import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../lib/config.ts";
import { createDiagnosticHandoff } from "../lib/report.ts";
import { ResearchRunner, type ResearchRunStatus } from "../lib/runner.ts";
import type { ResearchSessionOptions, SessionOutcome } from "../lib/session.ts";
import { usage } from "./fixtures/session-fixtures.ts";
import { TEST_PROFILE_REGISTRY } from "./fixtures/profile-fixtures.ts";

const baseOptions: ResearchSessionOptions = {
  cwd: "/tmp/research-runner-project",
  workspaceDir: "/tmp/research-runner-project",
  agentDir: "/tmp/research-runner-agent",
  parent: { model: { provider: "fixture", id: "model" } },
  config: parseConfig({}, TEST_PROFILE_REGISTRY),
  profileRegistry: TEST_PROFILE_REGISTRY,
};

const completed = (task: string): SessionOutcome => ({
  status: "completed",
  handoff: { text: `completed:${task}`, truncated: false, isError: false },
  activity: { assistantMessages: 1, toolCalls: 1, latestTool: "read" },
});
const waitFor = (signal: AbortSignal): Promise<void> => signal.aborted
  ? Promise.resolve()
  : new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function options(task: string, signal?: AbortSignal, profileRegistry = TEST_PROFILE_REGISTRY): ResearchSessionOptions {
  return {
    ...baseOptions,
    config: parseConfig({}, profileRegistry), profileRegistry,
    ...(signal ? { signal } : {}),
  };
}

test("shared capacity is two by default, queued cancellation never starts, and a released slot is reusable", async () => {
  const started: string[] = [];
  const releases: Array<() => void> = [];
  const runner = new ResearchRunner({
    maxConcurrency: 2,
    runSession: async (input) => {
      const task = (input as { task: string }).task;
      started.push(task);
      await new Promise<void>((resolve) => releases.push(resolve));
      return completed(task);
    },
  });
  const first = runner.run({ agent: "scout", task: "first" }, options("first"));
  const second = runner.run({ agent: "scout", task: "second" }, options("second"));
  const controller = new AbortController();
  const queued = runner.run({ agent: "scout", task: "queued" }, options("queued", controller.signal));
  await tick();
  assert.equal(runner.activeCount, 2);
  assert.equal(runner.queuedCount, 1);
  controller.abort();
  assert.equal((await queued).status, "cancelled");
  assert.deepEqual(started, ["first", "second"]);

  releases.shift()!();
  assert.equal((await first).status, "completed");
  const reusable = runner.run({ agent: "scout", task: "reusable" }, options("reusable"));
  await tick();
  assert.deepEqual(started, ["first", "second", "reusable"]);
  releases.shift()!();
  releases.shift()!();
  assert.equal((await second).status, "completed");
  assert.equal((await reusable).status, "completed");
  assert.equal(runner.activeCount, 0);
});

test("no timeout is allocated by default and long completion is successful", async () => {
  let aborted = false;
  const runner = new ResearchRunner({
    maxConcurrency: 2,
    runSession: async (_input, childOptions) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      aborted = childOptions.signal?.aborted ?? false;
      return completed("unlimited");
    },
  });
  const result = await runner.run({ agent: "scout", task: "unlimited" }, options("unlimited"));
  assert.equal(result.status, "completed");
  assert.equal(aborted, false);
});

test("configured timeout uses the isolated profile policy rather than a user's agent ceiling", async () => {
  const runner = new ResearchRunner({
    maxConcurrency: 1,
    timeoutMs: 20,
    runSession: async (_input, childOptions) => {
      await waitFor(childOptions.signal!);
      return { status: "cancelled", handoff: createDiagnosticHandoff("aborted"), activity: { assistantMessages: 0, toolCalls: 0 } };
    },
  });
  const result = await runner.run({ agent: "researcher", task: "bounded fixture timeout" }, options("bounded fixture timeout"));
  assert.equal(result.status, "timed_out");
  assert.equal(result.timeoutMs, 20);
  assert.equal(result.effectiveTimeoutMs, 20);
  assert.equal(result.timeoutSource, "global");
  assert.equal(result.maxTimeoutMs, 20);
  assert.match(result.handoff.text, /deadline source: global/);
});

test("deadline emits a live handoff phase with a work-only clock and clears it at terminal status", async () => {
  const statuses: ResearchRunStatus[] = [];
  const runner = new ResearchRunner({
    maxConcurrency: 1, timeoutMs: 20, onStatus: (status) => statuses.push(status),
    runSession: async (_input, childOptions) => {
      await waitFor(childOptions.deadlineSignal!);
      childOptions.onActivity?.({ assistantMessages: 1, toolCalls: 1, latestTool: "read" });
      return completed("deadline");
    },
  });
  const result = await runner.run({ agent: "scout", task: "deadline phase" }, options("deadline phase"));
  assert.equal(result.status, "timed_out");
  const handoff = statuses.find((status) => status.phase === "preparing_timeout_handoff" && status.activity?.latestTool === "read");
  assert.ok(handoff);
  assert.equal(handoff.state, "running");
  assert.equal(handoff.elapsedMs, handoff.effectiveTimeoutMs);
  assert.equal(handoff.activity?.latestTool, "read");
  assert.equal(statuses.at(-1)?.state, "timed_out");
  assert.equal(statuses.at(-1)?.phase, undefined);
});

test("late timeout activity cannot replace the terminal status", async () => {
  const statuses: ResearchRunStatus[] = [];
  let lateActivity!: NonNullable<ResearchSessionOptions["onActivity"]>;
  const runner = new ResearchRunner({
    maxConcurrency: 1, timeoutMs: 20, onStatus: (status) => statuses.push(status),
    runSession: async (_input, childOptions) => {
      lateActivity = childOptions.onActivity!;
      await waitFor(childOptions.signal!);
      return { status: "cancelled", handoff: createDiagnosticHandoff("aborted"), activity: { assistantMessages: 0, toolCalls: 0 } };
    },
  });
  const result = await runner.run({ agent: "scout", task: "late timeout activity" }, options("late timeout activity"));
  assert.equal(result.status, "timed_out");
  const count = statuses.length;
  lateActivity({ assistantMessages: 9, toolCalls: 9, latestTool: "late" });
  assert.equal(statuses.length, count);
  assert.equal(statuses.at(-1)?.state, "timed_out");
});

test("late cancellation activity cannot replace the terminal status", async () => {
  const statuses: ResearchRunStatus[] = [];
  const controller = new AbortController();
  let lateActivity!: NonNullable<ResearchSessionOptions["onActivity"]>;
  const runner = new ResearchRunner({
    maxConcurrency: 1, onStatus: (status) => statuses.push(status),
    runSession: async (_input, childOptions) => {
      lateActivity = childOptions.onActivity!;
      await waitFor(childOptions.signal!);
      return { status: "cancelled", handoff: createDiagnosticHandoff("aborted"), activity: { assistantMessages: 0, toolCalls: 0 } };
    },
  });
  const pending = runner.run({ agent: "scout", task: "late cancellation activity" }, options("late cancellation activity", controller.signal));
  await tick();
  controller.abort();
  const result = await pending;
  assert.equal(result.status, "cancelled");
  const count = statuses.length;
  lateActivity({ assistantMessages: 9, toolCalls: 9, latestTool: "late" });
  assert.equal(statuses.length, count);
  assert.equal(statuses.at(-1)?.state, "cancelled");
});

test("timeout diagnostics expose caller and discovered agent ceiling values", async () => {
  const profileRegistry = Object.freeze({
    ...TEST_PROFILE_REGISTRY,
    prompts: Object.freeze({
      ...TEST_PROFILE_REGISTRY.prompts,
      scout: Object.freeze({ ...TEST_PROFILE_REGISTRY.prompts.scout!, maxTimeout: 900 }),
    }),
  });
  const runner = new ResearchRunner({
    maxConcurrency: 1, profileRegistry,
    runSession: async (_input, childOptions) => {
      await waitFor(childOptions.signal!);
      return { status: "cancelled", handoff: createDiagnosticHandoff("aborted"), activity: { assistantMessages: 0, toolCalls: 0 } };
    },
  });
  const result = await runner.run({ agent: "scout", task: "caller deadline", timeout_ms: 10 }, options("caller deadline", undefined, profileRegistry));
  assert.equal(result.status, "timed_out");
  assert.equal(result.requestedTimeoutMs, 10);
  assert.equal(result.effectiveTimeoutMs, 10);
  assert.equal(result.timeoutSource, "caller");
  assert.equal(result.maxTimeoutMs, 900_000);
  assert.match(result.handoff.text, /requested timeout_ms: 10 milliseconds/);
  assert.match(result.handoff.text, /configured maximum: 15 minutes/);
});

test("abort during listener registration cannot queue or start a child", async () => {
  const controller = new AbortController();
  let started = false;
  const original = controller.signal.addEventListener.bind(controller.signal);
  controller.signal.addEventListener = ((...args: any[]) => {
    original(args[0], args[1], args[2]);
    controller.abort();
  }) as typeof controller.signal.addEventListener;
  const runner = new ResearchRunner({ maxConcurrency: 1, runSession: async () => {
    started = true;
    return completed("should-not-start");
  } });
  const result = await runner.run({ agent: "scout", task: "race" }, options("race", controller.signal));
  assert.equal(result.status, "cancelled");
  assert.equal(started, false);
  assert.equal(runner.activeCount, 0);
  assert.equal(runner.queuedCount, 0);
});

test("configured timeout starts only after a slot is granted and returns timed_out", async () => {
  let releaseFirst!: () => void;
  const firstReady = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let secondStarted = false;
  let secondWasInitiallyAborted = true;
  const runner = new ResearchRunner({
    maxConcurrency: 1,
    timeoutMs: 100,
    runSession: async (input, childOptions) => {
      const task = (input as { task: string }).task;
      if (task === "first") {
        await firstReady;
        return completed(task);
      }
      secondStarted = true;
      secondWasInitiallyAborted = childOptions.signal?.aborted ?? true;
      await waitFor(childOptions.signal!);
      return { status: "cancelled", handoff: createDiagnosticHandoff("aborted"), activity: { assistantMessages: 0, toolCalls: 0 } };
    },
  });
  const first = runner.run({ agent: "scout", task: "first" }, options("first"));
  const second = runner.run({ agent: "scout", task: "second" }, options("second"));
  await tick();
  assert.equal(runner.queuedCount, 1);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(secondStarted, false, "queue time must not consume the timeout");
  releaseFirst();
  assert.equal((await first).status, "completed");
  const result = await second;
  assert.equal(secondWasInitiallyAborted, false);
  assert.equal(result.status, "timed_out");
  assert.match(result.handoff.text, /timed out/);
});

test("first cancellation cause wins over a later timeout and preserves cleanup diagnostics, activity, and usage", async () => {
  const controller = new AbortController();
  const runner = new ResearchRunner({
    maxConcurrency: 1,
    timeoutMs: 20,
    runSession: async (_input, childOptions) => {
      await waitFor(childOptions.signal!);
      await new Promise((resolve) => setTimeout(resolve, 35));
      return {
        status: "failed",
        handoff: createDiagnosticHandoff("Research cleanup failed: MCP descendant remained alive."),
        activity: { assistantMessages: 4, toolCalls: 7, latestTool: "mcp__ketch__search" },
        usage: usage(2),
      };
    },
  });
  const pending = runner.run({ agent: "researcher", task: "cancel" }, options("cancel", controller.signal));
  await tick();
  controller.abort();
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.equal(result.usage?.totalTokens, 20);
  assert.equal(result.activity.toolCalls, 7);
  assert.match(result.handoff.text, /descendant remained alive/);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(result.status, "cancelled");
});

test("parent shutdown cancels active children, queued work, and waits for owned cleanup", async () => {
  const started: string[] = [];
  const runner = new ResearchRunner({
    maxConcurrency: 1,
    runSession: async (input, childOptions) => {
      const task = (input as { task: string }).task;
      started.push(task);
      await waitFor(childOptions.signal!);
      return { status: "cancelled", handoff: createDiagnosticHandoff("aborted"), activity: { assistantMessages: 0, toolCalls: 0 } };
    },
  });
  const active = runner.run({ agent: "researcher", task: "active" }, options("active"));
  const queued = runner.run({ agent: "scout", task: "queued" }, options("queued"));
  await tick();
  await runner.shutdown();
  assert.deepEqual(started, ["active"]);
  assert.equal((await active).status, "cancelled");
  assert.equal((await queued).status, "cancelled");
  assert.equal(runner.activeCount, 0);
  assert.equal(runner.queuedCount, 0);
  assert.equal((await runner.run({ agent: "scout", task: "after" }, options("after"))).status, "cancelled");
});

test("status and activity observers are bounded side channels and cannot break execution", async () => {
  const statuses: ResearchRunStatus[] = [];
  const runner = new ResearchRunner({
    maxConcurrency: 1,
    onStatus(status) { statuses.push(status); throw new Error("observer failure"); },
    runSession: async (_input, childOptions) => {
      childOptions.onActivity?.({ assistantMessages: 0, toolCalls: 1, latestTool: "read" });
      return completed("observed");
    },
  });
  const result = await runner.run({ agent: "scout", task: "observed" }, options("observed"));
  assert.equal(result.status, "completed");
  assert.deepEqual(statuses.map((status) => status.state), ["queued", "running", "running", "completed"]);
  assert.equal(statuses[0]?.model, "fixture/model");
  assert.equal(statuses[0]?.thinkingLevel, "high");
  assert.equal(statuses[2]?.activity?.latestTool, "read");
});