import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import {
  createMcpExtension,
  type LoadedMcpConfig,
  type McpExtensionOptions,
  type McpServerConfig,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { StdioTransport, type McpTransport } from "@earendil-works/pi-mcp";
export const KETCH_SERVER = "ketch";
export const KETCH_TOOLS: readonly string[] = Object.freeze([
  "mcp__ketch__search",
  "mcp__ketch__scrape",
  "mcp__ketch__code",
  "mcp__ketch__docs",
]);
export const KETCH_STARTUP_MS = 10_000;
const TOOL_PREFIX = "mcp__ketch__";

export function createKetchServerConfig(exposure: "codemode" | "direct"): McpServerConfig {
  return {
    command: "ketch",
    args: ["mcp", "serve"],
    description: "Web search, Markdown scraping, public OSS code search, and library documentation using Ketch.",
    exposure: "hidden",
    toolExposure: Object.fromEntries(KETCH_TOOLS.map((name) => [name.slice(TOOL_PREFIX.length), exposure])),
  };
}

function transportFingerprint(config: McpServerConfig): string {
  if ("command" in config) {
    return JSON.stringify({
      kind: "stdio", type: config.type ?? "stdio", command: config.command, args: config.args ?? [], env: config.env ?? {}, cwd: config.cwd ?? null,
    });
  }
  return JSON.stringify({ kind: "http", type: config.type ?? "http", url: config.url, headers: config.headers ?? {}, auth: config.auth ?? null, oauth: config.oauth ?? null });
}

interface ParentKetchConfigView {
  getMcpServers(): readonly { name: string; config: McpServerConfig }[];
}

/**
 * Parent Ketch may be overridden by a user/project config or another extension registration. The
 * child deliberately starts the plain bundled command, so reject transport/backend divergence
 * before any delegated research can observe a different configuration.
 */
export function validateParentKetchTransport(
  view: ParentKetchConfigView,
  cwd: string,
  agentDir: string,
  projectTrusted: boolean,
): string | undefined {
  const expected = transportFingerprint(createKetchServerConfig("codemode"));
  let global: Record<string, unknown> = {};
  let project: Record<string, unknown> = {};
  const read = (path: string): Record<string, unknown> | undefined => {
    let text: string;
    try { text = readFileSync(path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`Unable to inspect Ketch configuration at ${path}.`);
    }
    try {
      const parsed = JSON.parse(text) as { mcpServers?: unknown };
      return parsed.mcpServers && typeof parsed.mcpServers === "object" && !Array.isArray(parsed.mcpServers)
        ? parsed.mcpServers as Record<string, unknown> : {};
    } catch {
      throw new Error(`Unable to inspect Ketch configuration at ${path}: invalid JSON. Configuration was not changed.`);
    }
  };
  try {
    global = read(join(agentDir, "mcp.json")) ?? {};
    if (projectTrusted) project = read(join(cwd, ".pi", "mcp.json")) ?? {};
  } catch (error) {
    return error instanceof Error ? error.message : "Unable to inspect Ketch configuration. Configuration was not changed.";
  }
  const globalEntry = global[KETCH_SERVER];
  const projectEntry = project[KETCH_SERVER];
  let configured: unknown = globalEntry;
  if (Object.hasOwn(project, KETCH_SERVER)) {
    if (!projectEntry || typeof projectEntry !== "object" || Array.isArray(projectEntry)) {
      return "Ketch has an invalid configured server entry; delegated research is disabled until it is corrected. Configuration was not changed.";
    }
    const transportKeys = new Set(["type", "command", "args", "env", "cwd", "url", "headers", "auth", "oauth"]);
    const changesTransport = Object.keys(projectEntry).some((key) => transportKeys.has(key));
    // Native Pi replaces the global transport when the project entry specifies one. Only
    // transport-less metadata/tool-exposure overrides inherit the global definition.
    configured = changesTransport || !globalEntry || typeof globalEntry !== "object" || Array.isArray(globalEntry)
      ? projectEntry
      : { ...(globalEntry as Record<string, unknown>), ...(projectEntry as Record<string, unknown>) };
  }
  const fileConfigured = Object.hasOwn(global, KETCH_SERVER) || Object.hasOwn(project, KETCH_SERVER);
  if (fileConfigured) {
    if (configured === undefined || !configured || typeof configured !== "object" || Array.isArray(configured)) {
      return "Ketch has an invalid configured server entry; delegated research is disabled until it is corrected. Configuration was not changed.";
    }
    const effective = configured as Record<string, unknown>;
    if (typeof effective.command === "string") {
      const candidate = effective as unknown as McpServerConfig;
      if (transportFingerprint(candidate) === expected) return undefined;
    }
    return "Ketch backend configuration differs from the delegated researcher: align the configured ketch command/arguments/environment/working directory with plain `ketch mcp serve`, or remove the conflicting override. Configuration was not changed.";
  }

  // Native Pi gives an applicable file entry precedence over extension registrations. Only
  // validate a registered server when no global/trusted-project file entry can override it.
  const registered = view.getMcpServers().find((server) => server.name === KETCH_SERVER);
  if (registered && transportFingerprint(registered.config) !== expected) {
    return "Ketch backend configuration differs from the delegated researcher: align the registered ketch command/arguments/environment/working directory with plain `ketch mcp serve`, or remove the conflicting registration. Configuration was not changed.";
  }
  return undefined;
}

// Never reads mcp.json or copies a parent's registered-server list for the child itself.
export function loadResearcherMcpConfig(): LoadedMcpConfig {
  return {
    servers: [{
      name: KETCH_SERVER,
      config: createKetchServerConfig("direct"),
      scope: "extension",
      source: "research-subagents",
    }],
    errors: [],
    autoEnableCodemode: false,
  };
}

async function waitForOwnedGroupExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_500;
  while (Date.now() < deadline) {
    try { process.kill(-pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
    await delay(25);
  }
  throw new Error(`Owned MCP process group ${pid} did not exit after forced termination.`);
}

const execFileAsync = promisify(execFile);
async function listOwnedGroupMembers(groupId: number): Promise<number[]> {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,pgid="]);
  return stdout.split("\n").flatMap((line) => {
    const values = line.trim().split(/\s+/u).map(Number);
    if (values.length < 2) return [];
    const pid = values[0]!, pgid = values[1]!;
    return pid > 0 && pgid === groupId ? [pid] : [];
  });
}

function settleWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    void promise.then(() => finish(true), () => finish(true));
  });
}

async function forceOwnedProcessExit(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
      killer.once("error", () => resolve());
      killer.once("close", () => resolve());
    });
    return;
  }
  let groupSignalFailed = false;
  try { process.kill(-pid, "SIGKILL"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    groupSignalFailed = true;
  }
  if (!groupSignalFailed) {
    try {
      await waitForOwnedGroupExit(pid);
      return;
    } catch (error) {
      if ((error as Error).message !== `Owned MCP process group ${pid} did not exit after forced termination.`) throw error;
    }
  }
  // Some platforms reject signalling an orphaned group even though its descendants remain.
  // Enumerate only that captured group and kill its members individually as a fallback.
  const members = await listOwnedGroupMembers(pid);
  for (const member of members) {
    try { process.kill(member, "SIGKILL"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  await waitForOwnedGroupExit(pid);
}

export function createOwnedKetchTransport(entry: Parameters<NonNullable<McpExtensionOptions["createTransport"]>>[0], cwd: string): McpTransport {
  const config = entry.config;
  if (!("command" in config)) throw new Error("Researcher Ketch configuration must use a stdio command.");
  const transport = new StdioTransport({
    command: config.command,
    ...(config.args ? { args: config.args } : {}),
    ...(config.env ? { env: config.env } : {}),
    ...(config.cwd ? { cwd: config.cwd } : { cwd }),
  });
  let pid: number | undefined;
  let guarded = false;
  const start = transport.start.bind(transport);
  transport.start = async () => {
    await start();
    pid = transport.pid;
  };
  const close = transport.close.bind(transport);
  transport.close = async () => {
    if (guarded) return;
    guarded = true;
    let closeError: unknown;
    let nativeSettled = false;
    let nativeClose: Promise<void>;
    try {
      nativeClose = Promise.resolve(close()).then(
        () => { nativeSettled = true; },
        (error) => { nativeSettled = true; closeError = error; },
      );
    } catch (error) {
      nativeSettled = true;
      closeError = error;
      nativeClose = Promise.resolve();
    }
    // A descendant can retain the stdio pipes after the native transport has asked its child to
    // exit. Do not let native close make escalation unreachable; kill the captured ownership group
    // after a short grace period, then give the native promise one bounded chance to observe EOF.
    await settleWithin(nativeClose, 500);
    let forceError: unknown;
    if (pid !== undefined) {
      try { await forceOwnedProcessExit(pid); } catch (error) { forceError = error; }
    }
    if (!nativeSettled) await settleWithin(nativeClose, 1_000);
    if (!nativeSettled && !closeError) {
      closeError = new Error("Native MCP close remained pending after owned-process termination.");
    }
    if (closeError) throw closeError;
    if (forceError) throw forceError;
  };
  return transport;
}

export function createResearcherMcpExtension(
  options: Pick<McpExtensionOptions, "createTransport" | "logPath"> = {},
) {
  const createTransport = options.createTransport ?? ((entry, cwd) => createOwnedKetchTransport(entry, cwd));
  return createMcpExtension({ ...options, createTransport, loadConfig: loadResearcherMcpConfig });
}

export interface KetchToolView {
  getAllTools(): readonly Pick<ToolInfo, "name" | "exposure">[];
  getActiveTools(): readonly string[];
}

export interface KetchReadinessOptions {
  readonly mode: "parent" | "researcher";
  readonly signal?: AbortSignal;
  /** Connection/capability startup only, never a deadline on research. */
  readonly timeoutMs?: number;
}

export async function waitForKetchCapabilities(
  view: KetchToolView,
  options: KetchReadinessOptions,
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? KETCH_STARTUP_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error("Ketch startup timeout must be positive and within the supported timer range.");
  }
  const deadline = performance.now() + timeoutMs;
  while (true) {
    options.signal?.throwIfAborted();
    const tools = view.getAllTools();
    const active = new Set(view.getActiveTools());
    const callable = (tool: Pick<ToolInfo, "name" | "exposure">) =>
      tool.exposure === "codemode" || tool.exposure === "deferred" ||
      (tool.exposure === "direct" && active.has(tool.name));
    if (options.mode === "researcher") {
      const unexpected = tools.filter((tool) =>
        !KETCH_TOOLS.includes(tool.name) &&
        (callable(tool) || (tool.exposure === "model-only" && active.has(tool.name))),
      );
      if (unexpected.length) {
        throw new Error("Researcher has unexpected reachable tools: " + unexpected.map((tool) => tool.name).join(", "));
      }
    }
    const missing = KETCH_TOOLS.filter((name) => !tools.some((tool) =>
      tool.name === name && (options.mode === "researcher"
        ? tool.exposure === "direct" && active.has(name)
        : callable(tool)),
    ));
    if (!missing.length) return;
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      throw new Error(
        "Ketch capabilities unavailable: " + missing.join(", ") +
        ". Check that ketch mcp serve is installed/configured and that a conflicting mcp.json entry is not disabling or replacing its tools. Configuration was not changed.",
      );
    }
    await delay(Math.min(25, remaining), undefined, { signal: options.signal });
  }
}
