import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import test, { type TestContext } from "node:test";
import {
  MAX_HANDOFF_BYTES,
  createDiagnosticHandoff,
  createReportHandoff,
  type ReportFileSystem,
  type ReportHandoff,
} from "../lib/report.ts";

const native: ReportFileSystem = {
  realpath: fs.realpath, mkdtemp: fs.mkdtemp, chmod: fs.chmod,
  writeFile: fs.writeFile, rm: fs.rm,
};
const noFiles = new Proxy({} as ReportFileSystem, {
  get() { throw new Error("Unexpected filesystem access."); },
});
const oversized = "Final report evidence, not an interim transcript.\n".repeat(600);

async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "research-report-test-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspaceDir = join(root, "repo");
  const scratchDir = join(root, "scratch ü🙂 with spaces");
  const home = join(root, "home");
  await Promise.all([fs.mkdir(workspaceDir), fs.mkdir(scratchDir), fs.mkdir(home)]);
  await fs.writeFile(join(workspaceDir, "source.ts"), "Repository sentinel.\n");
  await fs.mkdir(join(home, ".pi", "agent"), { recursive: true });
  await fs.writeFile(join(home, ".pi", "agent", "settings.json"), '{"sentinel":"unchanged"}\n');
  return { root, workspaceDir, scratchDir, home };
}

async function snapshot(directory: string): Promise<Record<string, string>> {
  const contents: Record<string, string> = {};
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      contents[entry.name + "/"] = "directory";
      for (const [name, value] of Object.entries(await snapshot(join(directory, entry.name)))) {
        contents[entry.name + "/" + name] = value;
      }
    } else {
      contents[entry.name] = await fs.readFile(join(directory, entry.name), "utf8");
    }
  }
  return contents;
}

function assertBounded(result: ReportHandoff) {
  assert.ok(Buffer.byteLength(result.text, "utf8") <= MAX_HANDOFF_BYTES);
  assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(result.text)), result.text);
}

function expectedPrefix(text: string, limit: number): string {
  let bytes = 0;
  let prefix = "";
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > limit) break;
    bytes += size;
    prefix += character;
  }
  return prefix;
}

function assertStorageFailure(result: ReportHandoff) {
  assert.equal(result.isError, true);
  assert.equal(result.reportPath, undefined);
  assert.match(result.text, /handoff failed: could not preserve the full report/);
  assert.doesNotMatch(result.text, /Full report:|Final report evidence/);
  assertBounded(result);
}

test("ordinary reports remain unchanged without filesystem access", async () => {
  for (const text of ["A focused answer.", "  ## Answer\n\nFormatting and citations preserved.  "]) {
    assert.deepEqual(await createReportHandoff(text, { workspaceDir: "/unused" }, noFiles), {
      text, truncated: false, isError: false,
    });
  }
});

test("reports at and just below the 12 KiB byte limit are unchanged", async () => {
  assert.equal(MAX_HANDOFF_BYTES, 12 * 1024);
  for (const text of ["a".repeat(MAX_HANDOFF_BYTES - 1), "a".repeat(MAX_HANDOFF_BYTES), "🙂".repeat(MAX_HANDOFF_BYTES / 4)]) {
    const result = await createReportHandoff(text, { workspaceDir: "/unused" }, noFiles);
    assert.deepEqual(result, { text, truncated: false, isError: false });
    assertBounded(result);
  }
});

test("a one-byte overflow is retained even when character count is below the byte cap", async (t) => {
  const options = await fixture(t);
  for (const text of ["a".repeat(MAX_HANDOFF_BYTES + 1), "🙂".repeat(MAX_HANDOFF_BYTES / 4) + "a"]) {
    assert.equal(Buffer.byteLength(text, "utf8"), MAX_HANDOFF_BYTES + 1);
    const result = await createReportHandoff(text, options);
    assert.equal(result.isError, false);
    assert.equal(result.truncated, true);
    assert.ok(result.reportPath);
    assert.equal(await fs.readFile(result.reportPath, "utf8"), text);
    assertBounded(result);
  }
});

test("empty or whitespace-only reports are errors, not fabricated successful reports", async () => {
  for (const text of ["", " \n\t", " ".repeat(MAX_HANDOFF_BYTES + 1)]) {
    const result = await createReportHandoff(text, { workspaceDir: "/unused" }, noFiles);
    assert.deepEqual(result, createDiagnosticHandoff("Research produced no final report."));
    assertBounded(result);
  }
});

test("ordinary and exactly-at-limit diagnostics remain unchanged and are errors", () => {
  for (const text of ["Research timed out.", "  Failure details.\n", "é".repeat(MAX_HANDOFF_BYTES / 2)]) {
    assert.deepEqual(createDiagnosticHandoff(text), { text, truncated: false, isError: true });
  }
  assert.equal(createDiagnosticHandoff(" \n ").text, "Research failed without a diagnostic.");
});

test("oversized diagnostics are UTF-8-safe and bounded including their notice; no artifacts", () => {
  for (const text of ["a".repeat(MAX_HANDOFF_BYTES + 1), "漢🙂é".repeat(MAX_HANDOFF_BYTES), "e\u0301".repeat(MAX_HANDOFF_BYTES)]) {
    const result = createDiagnosticHandoff(text);
    assertBounded(result);
    assert.equal(result.isError, true);
    assert.equal(result.truncated, true);
    assert.equal(result.reportPath, undefined);
    const suffix = "\n\n[Diagnostic truncated.]";
    assert.ok(result.text.endsWith(suffix));
    assert.equal(result.text, expectedPrefix(text, MAX_HANDOFF_BYTES - Buffer.byteLength(suffix)) + suffix);
    assert.deepEqual(Object.keys(result).sort(), ["isError", "text", "truncated"]);
  }
});

test("overflow saves exactly the final report privately outside the workspace", async (t) => {
  const options = await fixture(t);
  const before = { repo: await snapshot(options.workspaceDir), home: await snapshot(options.home) };
  const result = await createReportHandoff(oversized, options);
  assertBounded(result);
  assert.equal(result.isError, false);
  assert.equal(result.truncated, true);
  assert.ok(result.reportPath && isAbsolute(result.reportPath));
  assert.equal(basename(result.reportPath), "report.md");
  assert.ok(relative(options.workspaceDir, result.reportPath).startsWith(".."));
  assert.equal(await fs.readFile(result.reportPath, "utf8"), oversized);
  assert.deepEqual(await fs.readdir(dirname(result.reportPath)), ["report.md"]);
  assert.match(result.text, /clipped excerpt, not a summary/);
  assert.ok(result.text.endsWith("Full report: " + result.reportPath));
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(dirname(result.reportPath))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(result.reportPath)).mode & 0o777, 0o600);
  }
  assert.deepEqual(Object.keys(result).sort(), ["isError", "reportPath", "text", "truncated"]);
  assert.deepEqual({ repo: await snapshot(options.workspaceDir), home: await snapshot(options.home) }, before);
});

test("Unicode clipping accounts for multibyte paths, notice bytes and 2/3/4-byte code points", async (t) => {
  const options = await fixture(t);
  for (const character of ["é", "漢", "🙂", "e\u0301"]) {
    for (let shift = 0; shift < 4; shift++) {
      const text = "a".repeat(MAX_HANDOFF_BYTES - 300 + shift) + character.repeat(1000);
      const result = await createReportHandoff(text, options);
      assert.ok(result.reportPath);
      assertBounded(result);
      const noticeStart = result.text.indexOf("\n\n[Report truncated:");
      assert.ok(noticeStart >= 0);
      const notice = result.text.slice(noticeStart);
      const budget = MAX_HANDOFF_BYTES - Buffer.byteLength(notice, "utf8");
      assert.equal(result.text.slice(0, noticeStart), expectedPrefix(text, budget));
      assert.ok(!result.text.includes("\ufffd"));
      assert.equal(await fs.readFile(result.reportPath, "utf8"), text);
    }
  }
});

test("default overflow storage uses OS temp, without changing process cwd or home", async (t) => {
  const options = await fixture(t);
  const cwd = process.cwd();
  const result = await createReportHandoff(oversized, { workspaceDir: options.workspaceDir });
  assert.ok(result.reportPath);
  const directory = dirname(result.reportPath);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  assert.equal(dirname(directory), await fs.realpath(tmpdir()));
  assert.equal(process.cwd(), cwd);
  assert.equal(await fs.readFile(result.reportPath, "utf8"), oversized);
  assertBounded(result);
});

test("concurrent reports have separate private files and never overwrite each other", async (t) => {
  const options = await fixture(t);
  const reports = [oversized, "Other final answer.\n".repeat(MAX_HANDOFF_BYTES)];
  const results = await Promise.all(reports.map((report) => createReportHandoff(report, options)));
  assert.notEqual(results[0]!.reportPath, results[1]!.reportPath);
  for (const [index, result] of results.entries()) {
    assert.ok(result.reportPath);
    assert.equal(await fs.readFile(result.reportPath, "utf8"), reports[index]);
    assertBounded(result);
  }
});

test("retained reports outlive unrelated child-session cleanup", async (t) => {
  const options = await fixture(t);
  const childDirectory = join(options.scratchDir, "child-session");
  await fs.mkdir(childDirectory);
  await fs.writeFile(join(childDirectory, "transcript.json"), "Ephemeral fixture, never retained.");
  const result = await createReportHandoff(oversized, options);
  assert.ok(result.reportPath);
  assert.notEqual(dirname(result.reportPath), childDirectory);
  await fs.rm(childDirectory, { recursive: true, force: true });
  assert.equal(await fs.readFile(result.reportPath, "utf8"), oversized);
  assert.deepEqual(await fs.readdir(dirname(result.reportPath)), ["report.md"]);
});

test("workspace storage, equal roots and symlinks into the workspace are rejected before writes", async (t) => {
  const options = await fixture(t);
  const nested = join(options.workspaceDir, "scratch");
  await fs.mkdir(nested);
  const alias = join(options.root, "scratch-alias");
  await fs.symlink(nested, alias, "dir");
  const workspaceAlias = join(options.root, "workspace-alias");
  await fs.symlink(options.workspaceDir, workspaceAlias, "dir");
  const before = await snapshot(options.workspaceDir);
  for (const [workspaceDir, scratchDir] of [
    [options.workspaceDir, options.workspaceDir],
    [options.workspaceDir, nested],
    [options.workspaceDir, alias],
    [workspaceAlias, nested],
  ]) {
    const result = await createReportHandoff(oversized, { workspaceDir: workspaceDir!, scratchDir: scratchDir! }, {
      ...native,
      async mkdtemp() { assert.fail("Workspace storage must be rejected before allocation."); },
    });
    assertStorageFailure(result);
    assert.match(result.text, /outside the workspace/);
  }
  assert.deepEqual(await snapshot(options.workspaceDir), before);
});

test("similarly named sibling directories are not incorrectly considered inside the workspace", async (t) => {
  const options = await fixture(t);
  const scratchDir = join(options.root, "repo-other");
  await fs.mkdir(scratchDir);
  const result = await createReportHandoff(oversized, { workspaceDir: options.workspaceDir, scratchDir });
  assert.equal(result.isError, false);
  assert.ok(result.reportPath);
  assert.equal(await fs.readFile(result.reportPath, "utf8"), oversized);
});

test("relative and nonexistent storage paths fail without creating directories", async (t) => {
  for (const options of [{ workspaceDir: "relative" }, { workspaceDir: "/unused", scratchDir: "relative" }]) {
    const result = await createReportHandoff(oversized, options, noFiles);
    assertStorageFailure(result);
    assert.match(result.text, /must be absolute/);
  }
  const options = await fixture(t);
  const missing = join(options.root, "not-created");
  assertStorageFailure(await createReportHandoff(oversized, { ...options, scratchDir: missing }));
  await assert.rejects(fs.stat(missing), { code: "ENOENT" });
});

test("filesystem failures remove only the newly owned directory and preserve user data", async (t) => {
  const options = await fixture(t);
  const before = { repo: await snapshot(options.workspaceDir), home: await snapshot(options.home) };
  const failures: Partial<ReportFileSystem>[] = [
    { async realpath() { throw new Error("Path resolution denied."); } },
    { async mkdtemp() { throw new Error("ENOSPC: temporary directory unavailable."); } },
    { async chmod() { throw new Error("EACCES: private directory permissions unavailable."); } },
    { async writeFile(path, text, settings) {
      assert.deepEqual(settings, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await native.writeFile(path, text.slice(0, 20), settings);
      throw new Error("ENOSPC: partial report write.");
    } },
    { async chmod(path, mode) {
      if (path.endsWith("report.md")) throw new Error("EACCES: final permissions unavailable.");
      await native.chmod(path, mode);
    } },
  ];
  for (const failure of failures) {
    const result = await createReportHandoff(oversized, options, { ...native, ...failure });
    assertStorageFailure(result);
    assert.deepEqual(await fs.readdir(options.scratchDir), []);
    assert.deepEqual({ repo: await snapshot(options.workspaceDir), home: await snapshot(options.home) }, before);
  }
});

test("cleanup failure is explicit, remains bounded, and does not claim a preserved report", async (t) => {
  const options = await fixture(t);
  const result = await createReportHandoff(oversized, options, {
    ...native,
    async writeFile() { throw new Error("Write failed. " + "漢".repeat(MAX_HANDOFF_BYTES)); },
    async rm() { throw new Error("Cleanup failed."); },
  });
  assertStorageFailure(result);
  assert.match(result.text, /cleanup also failed/);
  assert.equal(result.truncated, true);
  const leftovers = await fs.readdir(options.scratchDir);
  assert.equal(leftovers.length, 1); // The fixture teardown removes this explicitly reported failure.
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(join(options.scratchDir, leftovers[0]!))).mode & 0o777, 0o700);
  }
});

test("an unrepresentable full path is an error, never a clipped or falsely usable path", async (t) => {
  const options = await fixture(t);
  const impossiblePath = join(options.scratchDir, "x".repeat(MAX_HANDOFF_BYTES));
  const removed: string[] = [];
  const result = await createReportHandoff(oversized, options, {
    ...native,
    async mkdtemp() { return impossiblePath; },
    async chmod() {},
    async writeFile() { assert.fail("Must validate notice budget before writing."); },
    async rm(path) { removed.push(path); },
  });
  assertStorageFailure(result);
  assert.match(result.text, /path and notice exceed/);
  assert.deepEqual(removed, [impossiblePath]);
});
