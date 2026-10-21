import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { parseConfig } from "../lib/config.ts";
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

function extensionHarness(runSession: NonNullable<ConstructorParameters<typeof ResearchRunner>[0]>["runSession"] = async () => outcome()) {
  let tool: any;
  const handlers = new Map<string, (event: any, ctx?: any) => any>();
  let runner: ResearchRunner | undefined;
  const api = {
    getMcpServers: () => [],
    registerMcpServer: () => {},
    registerTool: (definition: unknown) => { tool = definition; },
    on: (event: string, handler: (event: any, ctx?: any) => any) => { handlers.set(event, handler); return () => handlers.delete(event); },
  } as unknown as ExtensionAPI;
  createResearchExtension({
    getAgentDir: () => "/fixture-agent",
    loadConfig: () => parseConfig({}),
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

test("public research marks failed, cancelled, and timed-out child outcomes as tool errors", async () => {
  for (const status of ["failed", "cancelled", "timed_out"] as const) {
    const harness = extensionHarness(async () => outcome(status));
    const result = await harness.tool.execute("research-1", { agent: "researcher", task: "question" }, undefined, undefined, harness.context);
    assert.equal(result.isError, true, status);
    assert.equal(result.structuredContent.status, status);
  }
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
