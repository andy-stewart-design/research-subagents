import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionToolContext, McpServerConfig } from "@earendil-works/pi-coding-agent";
import { parseConfig } from "../lib/config.ts";
import { MAX_HANDOFF_BYTES } from "../lib/report.ts";
import { createResearchExtension } from "../extensions/research.ts";
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
  loadProfileTools?: (agent: string) => readonly string[],
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
    ...(loadProfileTools ? { loadProfileTools } : {}),
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
  assert.ok(updates.some((update) => /queued/.test(update.content[0].text)));
  assert.ok(updates.some((update) => /completed/.test(update.content[0].text)));

  const hook = harness.handlers.get("tool_call")!;
  assert.throws(() => hook({ toolName: "subagent", input: { agent: "scout", task: " " } }), /Invalid research input/);
  assert.throws(() => harness.tool.prepareArguments({ agent: "researcher", task: "x", tools: ["bash"] }), /Invalid research input/);
  assert.doesNotThrow(() => hook({ toolName: "mcp__ketch__search", input: {} }));
});

test("public results expose requested, effective, source, and ceiling timeout metadata", async () => {
  const harness = extensionHarness(async () => outcome(), () => parseConfig({ timeoutMs: 100 }));
  const result = await harness.tool.execute("timeout-metadata", {
    agent: "scout", task: "bounded question", timeout_ms: 50,
  }, undefined, undefined, harness.context);
  assert.equal(result.structuredContent.requestedTimeoutMs, 50);
  assert.equal(result.structuredContent.effectiveTimeoutMs, 50);
  assert.equal(result.structuredContent.timeoutSource, "caller");
  assert.equal(result.structuredContent.maxTimeoutMs, 900_000);
  assert.equal(result.details.effectiveTimeoutMs, 50);
  assert.equal(result.details.timeoutSource, "caller");
});

test("an incompatible Ketch backend blocks only researcher, not local Scout", async () => {
  const harness = extensionHarness(
    async () => outcome(),
    () => parseConfig({}),
    () => [{ name: "ketch", config: { command: "custom-ketch" } }],
  );
  const scout = await harness.tool.execute("research-scout", { agent: "scout", task: "local question" }, undefined, undefined, harness.context);
  assert.equal(scout.structuredContent.status, "completed");
  const researcher = await harness.tool.execute("researcher", { agent: "researcher", task: "web question" }, undefined, undefined, harness.context);
  assert.equal(researcher.isError, true);
  assert.match(researcher.content[0].text, /Ketch backend configuration differs/);
});

test("profile/domain mismatches fail closed before a child starts", async () => {
  let started = false;
  const harness = extensionHarness(async () => { started = true; return outcome(); });
  const researcher = await harness.tool.execute("research-1", {
    agent: "researcher", task: "Audit /Users/example/project/package.json and its local source files.",
  }, undefined, undefined, harness.context);
  assert.equal(researcher.isError, true);
  assert.match(researcher.content[0].text, /external-only/);
  const scout = await harness.tool.execute("research-2", {
    agent: "scout", task: "Check https://example.com for the latest documentation.",
  }, undefined, undefined, harness.context);
  assert.equal(scout.isError, true);
  assert.match(scout.content[0].text, /local-only/);
  assert.equal(started, false);
});

test("domain heuristics follow configured tool capabilities", async () => {
  for (const agent of ["scout", "researcher"] as const) {
    const harness = extensionHarness(async () => outcome(), undefined, undefined, () => ["bash"]);
    for (const task of ["Fetch https://example.com/docs.", "Inspect /Users/example/project/package.json."]) {
      const result = await harness.tool.execute(`${agent}-${task}`, { agent, task }, undefined, undefined, harness.context);
      assert.equal(result.isError, undefined, `${agent}: ${task}`);
    }
  }

  for (const tools of [["write"], ["edit"], ["write", "edit"]]) {
    const harness = extensionHarness(async () => outcome(), undefined, undefined, () => tools);
    const result = await harness.tool.execute("worker-local", {
      agent: "worker", task: "Update /Users/example/project/package.json.",
    }, undefined, undefined, harness.context);
    assert.equal(result.isError, undefined, tools.join(","));
  }
});

test("the default Worker can receive a URL task because bash provides external access", async () => {
  const harness = extensionHarness();
  const result = await harness.tool.execute("worker-url", {
    agent: "worker", task: "Use https://example.com/docs to verify the implementation.",
  }, undefined, undefined, harness.context);
  assert.equal(result.isError, undefined);
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
