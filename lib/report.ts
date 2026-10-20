import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

export const MAX_HANDOFF_BYTES = 12 * 1024;
const DIAGNOSTIC_NOTICE = "\n\n[Diagnostic truncated.]";

export interface ReportHandoff {
  readonly text: string;
  /** Whether the returned text was clipped, not whether research completed. */
  readonly truncated: boolean;
  readonly isError: boolean;
  readonly reportPath?: string;
}

export interface ReportOptions {
  /** Host-supplied repository/workspace root; report artifacts must stay outside it. */
  readonly workspaceDir: string;
  /** A retained-report base, never a child's disposable session directory. Defaults to OS temp. */
  readonly scratchDir?: string;
}

// Narrow injection seam for deterministic filesystem failures, not a model-facing option.
export interface ReportFileSystem {
  realpath(path: string): Promise<string>;
  mkdtemp(prefix: string): Promise<string>;
  chmod(path: string, mode: number): Promise<void>;
  writeFile(path: string, text: string, options: {
    encoding: "utf8";
    mode: number;
    flag: "wx";
  }): Promise<void>;
  rm(path: string, options: { recursive: true; force: true }): Promise<void>;
}

const fileSystem: ReportFileSystem = { realpath, mkdtemp, chmod, writeFile, rm };

function utf8Prefix(text: string, maxBytes: number): string {
  // Only this bounded prefix is encoded, not a potentially very large full report.
  let end = Math.min(text.length, maxBytes);
  const last = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
  const bytes = Buffer.from(text.slice(0, end), "utf8");
  let boundary = Math.min(bytes.length, maxBytes);
  while (boundary > 0 && boundary < bytes.length && (bytes[boundary]! & 0xc0) === 0x80) {
    boundary--;
  }
  return bytes.toString("utf8", 0, boundary);
}

export function createDiagnosticHandoff(message: string): ReportHandoff {
  const text = message.trim() ? message : "Research failed without a diagnostic.";
  const truncated = Buffer.byteLength(text, "utf8") > MAX_HANDOFF_BYTES;
  return {
    text: truncated
      ? utf8Prefix(text, MAX_HANDOFF_BYTES - Buffer.byteLength(DIAGNOSTIC_NOTICE, "utf8")) + DIAGNOSTIC_NOTICE
      : text,
    truncated,
    isError: true,
  };
}

function isWithin(root: string, path: string): boolean {
  const entry = relative(root, path);
  return entry === "" || (entry !== ".." && !entry.startsWith(`..${sep}`) && !isAbsolute(entry));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown filesystem failure.";
}

/** Accept only the selected final report, never a session transcript or message array. */
export async function createReportHandoff(
  report: string,
  options: ReportOptions,
  files: ReportFileSystem = fileSystem,
): Promise<ReportHandoff> {
  if (!report.trim()) return createDiagnosticHandoff("Research produced no final report.");
  if (Buffer.byteLength(report, "utf8") <= MAX_HANDOFF_BYTES) {
    return { text: report, truncated: false, isError: false };
  }

  let ownedDirectory: string | undefined;
  try {
    const scratchDir = options.scratchDir ?? tmpdir();
    if (!isAbsolute(options.workspaceDir) || !isAbsolute(scratchDir)) {
      throw new Error("Workspace and report scratch directories must be absolute.");
    }
    const [workspace, scratch] = await Promise.all([
      files.realpath(options.workspaceDir),
      files.realpath(scratchDir),
    ]);
    if (isWithin(workspace, scratch)) {
      throw new Error("Report scratch storage must be outside the workspace.");
    }

    // Each retained report owns its own directory, separate from child-session cleanup.
    ownedDirectory = await files.mkdtemp(join(scratch, "pi-research-report-"));
    await files.chmod(ownedDirectory, 0o700);
    const reportPath = join(ownedDirectory, "report.md");
    const notice = `\n\n[Report truncated: this is a clipped excerpt, not a summary.]\nFull report: ${reportPath}`;
    const noticeBytes = Buffer.byteLength(notice, "utf8");
    if (noticeBytes >= MAX_HANDOFF_BYTES) {
      throw new Error("The full-report path and notice exceed the handoff budget.");
    }

    await files.writeFile(reportPath, report, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await files.chmod(reportPath, 0o600);
    return {
      text: utf8Prefix(report, MAX_HANDOFF_BYTES - noticeBytes) + notice,
      truncated: true,
      isError: false,
      reportPath,
    };
  } catch (error) {
    let cleanupFailed = false;
    if (ownedDirectory !== undefined) {
      try {
        await files.rm(ownedDirectory, { recursive: true, force: true });
      } catch {
        cleanupFailed = true;
      }
    }
    const cleanupNotice = cleanupFailed ? " Temporary report cleanup also failed." : "";
    // Keep the actionable failure before potentially long filesystem diagnostics; never claim preservation.
    return createDiagnosticHandoff(
      `Research report handoff failed: could not preserve the full report.${cleanupNotice}\n${errorMessage(error)}`,
    );
  }
}
