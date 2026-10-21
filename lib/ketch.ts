import { setTimeout as delay } from "node:timers/promises";
import {
  createMcpExtension,
  type LoadedMcpConfig,
  type McpExtensionOptions,
  type McpServerConfig,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { PROFILES } from "./profiles.ts";

export const KETCH_SERVER = "ketch";
export const KETCH_TOOLS = PROFILES.researcher.tools;
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

// Never reads mcp.json or copies a parent's registered-server list.
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

export function createResearcherMcpExtension(
  options: Pick<McpExtensionOptions, "createTransport" | "logPath"> = {},
) {
  return createMcpExtension({ ...options, loadConfig: loadResearcherMcpConfig });
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
