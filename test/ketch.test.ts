import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTick, setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { ExtensionAPI, McpServerConfig } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import {
  KETCH_TOOLS, createKetchServerConfig, loadResearcherMcpConfig, validateParentKetchTransport, waitForKetchCapabilities,
  type KetchToolView,
} from "../lib/ketch.ts";

const ready = (exposure: "direct" | "deferred") => KETCH_TOOLS.map((name) => ({ name, exposure }));
const view = (exposure: "direct" | "deferred"): KetchToolView => ({
  getAllTools: () => ready(exposure), getActiveTools: () => exposure === "direct" ? [...KETCH_TOOLS] : [],
});

test("manifest declares only the actual entry point", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.pi, { extensions: ["./index.ts"] });
});

test("transport-changing parent Ketch overrides are rejected before delegated research", () => {
  const error = validateParentKetchTransport({
    getMcpServers: () => [{ name: "ketch", config: { command: "custom-ketch", env: { HOME: "/private" } } }],
  }, "/project", "/agent", false);
  assert.match(error ?? "", /differs from the delegated researcher/);
  assert.match(error ?? "", /Configuration was not changed/);
  assert.equal(validateParentKetchTransport({
    getMcpServers: () => [{ name: "ketch", config: createKetchServerConfig("codemode") }],
  }, "/project", "/agent", false), undefined);
});

test("project Ketch transport replaces global configuration while metadata overrides inherit it", () => {
  const root = join(tmpdir(), `research-ketch-${process.pid}-${Date.now()}`);
  const agentDir = join(root, "agent");
  mkdirSync(join(root, ".pi"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { ketch: createKetchServerConfig("codemode") } }));
  writeFileSync(join(root, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { ketch: { url: "https://different.invalid/mcp" } } }));
  const view = { getMcpServers: () => [{ name: "ketch", config: createKetchServerConfig("codemode") }] };
  assert.match(validateParentKetchTransport(view, root, agentDir, true) ?? "", /differs from the delegated researcher/);
  writeFileSync(join(root, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { ketch: { description: "project label" } } }));
  assert.equal(validateParentKetchTransport(view, root, agentDir, true), undefined);
  rmSync(root, { recursive: true, force: true });
});

test("shared Ketch configuration fixes the CLI and exposes only four core tools", () => {
  for (const exposure of ["codemode", "direct"] as const) {
    const config = createKetchServerConfig(exposure);
    assert.deepEqual(config, {
      command: "ketch", args: ["mcp", "serve"],
      description: "Web search, Markdown scraping, public OSS code search, and library documentation using Ketch.",
      exposure: "hidden", toolExposure: { search: exposure, scrape: exposure, code: exposure, docs: exposure },
    });
  }
});

test("researcher configuration is fresh, Ketch-only, direct, and does not activate indirect tools", () => {
  const config = loadResearcherMcpConfig();
  assert.equal(config.servers.length, 1);
  assert.equal(config.servers[0]!.name, "ketch");
  assert.equal(config.servers[0]!.scope, "extension");
  assert.equal(config.projectConfig, undefined);
  assert.equal(config.autoEnableCodemode, false);
  assert.deepEqual(config.errors, []);
  config.servers.push({ name: "unrelated", config: { command: "not-run" }, source: "test" });
  assert.equal(loadResearcherMcpConfig().servers.length, 1);
});

test("parent accepts callable deferred tools; researcher requires direct active declarations", async () => {
  await waitForKetchCapabilities(view("deferred"), { mode: "parent" });
  await waitForKetchCapabilities(view("direct"), { mode: "researcher" });
  await assert.rejects(waitForKetchCapabilities(view("deferred"), { mode: "researcher", timeoutMs: 1 }), /Ketch capabilities unavailable/);
  await assert.rejects(waitForKetchCapabilities({ getAllTools: () => ready("direct"), getActiveTools: () => [] },
    { mode: "researcher", timeoutMs: 1 }), /unavailable/);
});

test("researcher rejects unexpected reachable/declared tools but allows hidden registrations", async () => {
  for (const exposure of ["direct", "model-only", "deferred", "codemode"] as const) {
    const extra = { name: "write", exposure };
    await assert.rejects(waitForKetchCapabilities({
      getAllTools: () => [...ready("direct"), extra], getActiveTools: () => [...KETCH_TOOLS, "write"],
    }, { mode: "researcher" }), /unexpected reachable tools: write/);
  }
  await waitForKetchCapabilities({
    getAllTools: () => [...ready("direct"), { name: "mcp__ketch__tag", exposure: "hidden" }],
    getActiveTools: () => [...KETCH_TOOLS],
  }, { mode: "researcher" });
});

test("readiness waits for late tool registration without changing the view", async () => {
  let tools: ReturnType<typeof ready> = [];
  const pending = waitForKetchCapabilities({
    getAllTools: () => tools, getActiveTools: () => tools.map((tool) => tool.name),
  }, { mode: "researcher", timeoutMs: 500 });
  tools = ready("direct");
  await pending;
});

test("readiness fails clearly for missing tools and has bounded startup/cancellation", async () => {
  await assert.rejects(waitForKetchCapabilities({
    getAllTools: () => [], getActiveTools: () => [],
  }, { mode: "parent", timeoutMs: 1 }), /ketch mcp serve.*conflicting mcp.json.*not changed/);
  for (const timeoutMs of [0, -1, NaN, Infinity, 2_147_483_648]) {
    await assert.rejects(waitForKetchCapabilities(view("direct"), { mode: "researcher", timeoutMs }), /startup timeout/);
  }
  await assert.rejects(waitForKetchCapabilities(view("direct"), {
    mode: "researcher", signal: AbortSignal.abort(),
  }), { name: "AbortError" });
  const controller = new AbortController();
  const waiting = waitForKetchCapabilities({ getAllTools: () => [], getActiveTools: () => [] },
    { mode: "parent", signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
});

function fakeApi(existing = false, toolsReady = true, codemodeActive = true) {
  type Handler = (event: never, ctx: never) => unknown;
  const handlers = new Map<string, Handler>();
  const registrations: { name: string; config: McpServerConfig }[] = [];
  const notices: string[] = [];
  const api = {
    getMcpServers: () => existing ? [{ name: "ketch", config: { command: "user-owned" } }] : [],
    registerMcpServer: (name: string, config: McpServerConfig) => registrations.push({ name, config }),
    registerTool: () => {},
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    getAllTools: () => toolsReady ? ready("deferred") : [],
    getActiveTools: () => codemodeActive ? ["codemode", "read"] : ["read"],
  } as unknown as ExtensionAPI;
  const event = {} as never;
  const ctx = { ui: { notify: (message: string) => notices.push(message) }, isProjectTrusted: () => false } as never;
  return { api, handlers, registrations, notices, event, ctx };
}

test("factory registers default Ketch only; existing extension-owned servers are never replaced", () => {
  const fresh = fakeApi();
  extension(fresh.api);
  assert.deepEqual(fresh.registrations, [{ name: "ketch", config: createKetchServerConfig("codemode") }]);
  assert.deepEqual([...fresh.handlers.keys()], ["tool_call", "session_start", "session_shutdown"]);
  const existing = fakeApi(true);
  extension(existing.api);
  assert.deepEqual(existing.registrations, []);
});

test("parent startup surfaces capability inspection failures without repairing configuration", async () => {
  const broken = fakeApi();
  broken.api.getAllTools = () => { throw new Error("Configured Ketch tools are unavailable."); };
  extension(broken.api);
  broken.handlers.get("session_start")!(broken.event, broken.ctx);
  await nextTick();
  assert.deepEqual(broken.notices, ["Configured Ketch tools are unavailable."]);
  assert.equal(broken.registrations.length, 1);
  broken.handlers.get("session_shutdown")!(broken.event, broken.ctx);
});

test("parent startup respects inactive codemode and shutdown cancels pending diagnostics", async () => {
  const inactive = fakeApi(false, true, false);
  extension(inactive.api);
  inactive.handlers.get("session_start")!(inactive.event, inactive.ctx);
  await nextTick();
  assert.match(inactive.notices[0]!, /codemode is inactive/);
  assert.deepEqual(inactive.api.getActiveTools(), ["read"]);
  inactive.handlers.get("session_shutdown")!(inactive.event, inactive.ctx);
  const pending = fakeApi(false, false);
  extension(pending.api);
  pending.handlers.get("session_start")!(pending.event, pending.ctx);
  pending.handlers.get("session_shutdown")!(pending.event, pending.ctx);
  await delay(30);
  assert.deepEqual(pending.notices, []);
});
