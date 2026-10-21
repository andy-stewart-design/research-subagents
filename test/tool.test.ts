import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionToolContext, McpServerConfig } from "@earendil-works/pi-coding-agent";
import { parseConfig } from "../lib/config.ts";
import { MAX_HANDOFF_BYTES } from "../lib/report.ts";
import { createResearchExtension } from "../index.ts";
import { ResearchRunner } from "../lib/runner.ts";
import type { SessionOutcome } from "../lib/session.ts";

const outcome = (status: SessionOutcome["status"] = "completed"): SessionOutcome => ({
  status,
  handoff: {
    text: status === "completed" ? "## Answer\nFixture report." : `Research ${status}.`,
    truncated: false,
    isError: status !== "completed",
  },
  activity: { assistantMessages: 1, toolCalls: 2, latestTool: "read" },
});

function extensionHarness(
  runSession: NonNullable<ConstructorParameters<typeof ResearchRunner>[0]>["runSession"] = async () => outcome(),
  loadConfig: () => ReturnType<typeof parseConfig> = () => parseConfig({}),
  getMcpServers: () => readonly { name: string; config: McpServerConfig }[] = () => [],
) {
  let tool: any;
  const handlers = new Map<string, (event: any, ctx?: any) => any>();
  let runner: ResearchRunner | undefined;
  const api = {
    getMcpServers,
    registerMcpServer: () => {},
    registerTool: (definition: unknown) => { tool = definition; },
    on: (event: string, handler: (event: any, ctx?: any) => any) => { handlers.set(event, handler); return () => handlers.delete(event); },
  } as unknown as ExtensionAPI;
  createResearchExtension({
    getAgentDir: () => "/fixture-agent",
    loadConfig,
    createRunner: (config) => {
      runner = new ResearchRunner({
        maxConcurrency: config.maxConcurrency,
        ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
        runSession,
      });
      return runner;
    },
  })(api);
  assert.ok(tool);
  const context = {
    cwd: "/fixture-project",
    model: { provider: "fixture", id: "model" },
    thinkingLevel: "high",
    isProjectTrusted: () => false,
  } as unknown as ExtensionToolContext;
  return { tool, handlers, context, get runner() { return runner; } };
}

test("public research validates raw input before execution and returns only bounded final handoff data", async () => {
  let captured: { input: unknown; options: any } | undefined;
  const harness = extensionHarness(async (input, options) => {
    captured = { input, options };
    options.onActivity?.({ assistantMessages: 1, toolCalls: 1, latestTool: "read" });
    return outcome();
  });
  const rawTask = "/mcp login\n@literal file $(not-a-command)";
  const updates: any[] = [];
  const result = await harness.tool.execute("research-1", { agent: "scout", task: rawTask }, undefined, (update: any) => updates.push(update), harness.context);
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.status, "completed");
  assert.equal(result.content[0].text, "## Answer\nFixture report.");
  assert.deepEqual(captured?.input, { agent: "scout", task: rawTask });
  assert.equal(captured?.options.cwd, "/fixture-project");
  assert.equal(captured?.options.agentDir, "/fixture-agent");
  assert.ok(updates.some((update) => /Research queued/.test(update.content[0].text)));
  assert.ok(updates.some((update) => /Research completed/.test(update.content[0].text)));

  const hook = harness.handlers.get("tool_call")!;
  assert.throws(() => hook({ toolName: "research", input: { agent: "scout", task: " " } }), /Invalid research input/);
  assert.throws(() => harness.tool.prepareArguments({ agent: "researcher", task: "x", tools: ["bash"] }), /Invalid research input/);
  assert.doesNotThrow(() => hook({ toolName: "mcp__ketch__search", input: {} }));
});

test("an incompatible Ketch backend blocks only researcher, not local Scout", async () => {
  const harness = extensionHarness(
    async () => outcome(),
    () => parseConfig({}),
    () => [{ name: "ketch", config: { command: "custom-ketch" } }],
  );
  const notices: string[] = [];
  await harness.handlers.get("session_start")!({}, {
    ...harness.context,
    ui: { notify: (message: string) => notices.push(message) },
  });
  const scout = await harness.tool.execute("research-scout", { agent: "scout", task: "local question" }, undefined, undefined, harness.context);
  assert.equal(scout.structuredContent.status, "completed");
  const researcher = await harness.tool.execute("researcher", { agent: "researcher", task: "web question" }, undefined, undefined, harness.context);
  assert.equal(researcher.isError, true);
  assert.match(researcher.content[0].text, /Ketch backend configuration differs/);
  assert.equal(notices.length, 1);
});

test("public research marks failed, cancelled, and timed-out child outcomes as tool errors", async () => {
  for (const status of ["failed", "cancelled", "timed_out"] as const) {
    const harness = extensionHarness(async () => outcome(status));
    const result = await harness.tool.execute("research-1", { agent: "researcher", task: "question" }, undefined, undefined, harness.context);
    assert.equal(result.isError, true, status);
    assert.equal(result.structuredContent.status, status);
  }
});

test("initialization failures stay inside the bounded public tool result", async () => {
  const harness = extensionHarness(async () => outcome(), () => { throw new Error("configuration failure🙂".repeat(5000)); });
  const result = await harness.tool.execute("research-1", { agent: "scout", task: "question" }, undefined, undefined, harness.context);
  assert.equal(result.isError, true);
  assert.ok(Buffer.byteLength(result.content[0].text, "utf8") <= MAX_HANDOFF_BYTES);
  assert.match(result.content[0].text, /configuration failure/);
});

test("reports exclude the repository root when Pi dispatches from a subdirectory", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "research-workspace-"));
  await fs.mkdir(join(root, ".git"));
  const subdirectory = join(root, "src");
  await fs.mkdir(subdirectory);
  let workspace: string | undefined;
  const harness = extensionHarness(async (_input, options) => {
    workspace = options.workspaceDir;
    return outcome();
  });
  (harness.context as any).cwd = subdirectory;
  await harness.tool.execute("research-1", { agent: "scout", task: "question" }, undefined, undefined, harness.context);
  assert.equal(workspace, root);
  await fs.rm(root, { recursive: true, force: true });
});

test("parent shutdown owns active research runners without affecting unrelated tool state", async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const harness = extensionHarness(async (_input, options) => {
    await new Promise<void>((resolve) => {
      if (options.signal?.aborted) resolve();
      else options.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    release();
    return outcome("cancelled");
  });
  const pending = harness.tool.execute("research-1", { agent: "scout", task: "active" }, undefined, undefined, harness.context);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await harness.handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" });
  await pending;
  await wait;
  assert.equal(harness.runner?.activeCount, 0);
});
