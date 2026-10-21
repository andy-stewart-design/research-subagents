import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { Type } from "typebox";
import type { AgentSessionEvent, CreateAgentSessionOptions, ExtensionError, SessionManager } from "@earendil-works/pi-coding-agent";
import { parseConfig } from "../lib/config.ts";
import { MAX_HANDOFF_BYTES } from "../lib/report.ts";
import { runResearchSession, type ChildSession, type ResearchSessionOptions, type SessionServices } from "../lib/session.ts";
import { assistant, parent, unitRuntime, usage } from "./fixtures/session-fixtures.ts";

async function options(t: TestContext): Promise<ResearchSessionOptions> {
  const root = await fs.mkdtemp(join(tmpdir(), "research-session-unit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project"), agentDir = join(root, "agent");
  await fs.mkdir(cwd); await fs.mkdir(agentDir);
  return { cwd, workspaceDir: cwd, agentDir, parent, config: parseConfig({}) };
}

interface Script {
  readonly history: SessionManager;
  readonly emit: (event: AgentSessionEvent) => void;
  readonly append: (message: Parameters<SessionManager["appendMessage"]>[0]) => void;
  readonly request: string;
}
function harness(run: (script: Script) => Promise<void> | void = ({ append }) => append(assistant("## Answer\nNo relevant findings.\n## Caveats\nLimited fixture."))) {
  const calls: string[] = [];
  const launches: CreateAgentSessionOptions[] = [];
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  let reportError: ((error: ExtensionError) => void) | undefined;
  let instance: ChildSession;
  const services: SessionServices = {
    createModelRuntime: unitRuntime,
    hasScoutBinary: () => true,
    async createSession(input) {
      launches.push(input);
      const tools = [...input.tools!];
      const history = input.sessionManager!;
      const emit = (event: AgentSessionEvent) => { for (const listener of listeners) listener(event); };
      instance = {
        model: input.model!,
        getAllTools: () => tools.map((name) => ({ name, description: "fixture", parameters: Type.Object({}), exposure: "direct", sourceInfo: { path: "<fixture>", source: "fixture", scope: "temporary", origin: "top-level" } })),
        getActiveToolNames: () => [...tools], getCallableToolNames: () => [...tools],
        subscribe(listener) { calls.push("subscribe"); listeners.add(listener); return () => { calls.push("unsubscribe"); listeners.delete(listener); }; },
        async bindExtensions(bindings) { calls.push("bind"); reportError = bindings.onError; },
        async prompt(request, promptOptions) {
          calls.push("prompt");
          assert.equal(promptOptions?.expandPromptTemplates, false);
          history.appendMessage({ role: "user", content: request, timestamp: Date.now() });
          await run({ history, emit, request, append(message) { history.appendMessage(message); emit({ type: "message_end", message }); } });
        },
        async abort() { calls.push("abort"); },
        extensionRunner: { async emit() { calls.push("shutdown"); } },
        dispose() { calls.push("dispose"); },
      };
      return { session: instance };
    },
  };
  return { services, calls, launches, listeners, get session() { return instance; }, error(error: string, event = "session_shutdown") { reportError?.({ extensionPath: "fixture", error, event }); } };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("invalid input/paths and an already-cancelled signal never create a runtime or session", async (t) => {
  const opts = await options(t);
  const h = harness();
  h.services.createModelRuntime = async () => { throw new Error("must not create runtime"); };
  for (const input of [{ agent: "worker", task: "x" }, { agent: "scout", task: " " }, { agent: "scout", task: "x", cwd: "/" }]) {
    const result = await runResearchSession(input, opts, h.services);
    assert.equal(result.status, "failed"); assert.match(result.handoff.text, /Invalid research input/);
  }
  const invalidPath = await runResearchSession({ agent: "scout", task: "x" }, { ...opts, cwd: "relative" }, h.services);
  assert.match(invalidPath.handoff.text, /absolute/);
  const controller = new AbortController(); controller.abort();
  assert.equal((await runResearchSession({ agent: "scout", task: "x" }, { ...opts, signal: controller.signal }, h.services)).status, "cancelled");
  assert.equal(h.launches.length, 0);
});

test("missing Scout prerequisites fail before model/session creation rather than letting native tools download binaries", async (t) => {
  const opts = await options(t), h = harness();
  h.services.hasScoutBinary = () => false;
  h.services.createModelRuntime = async () => { throw new Error("Must not create model services"); };
  const result = await runResearchSession({ agent: "scout", task: "question" }, opts, h.services);
  assert.equal(result.status, "failed"); assert.match(result.handoff.text, /already-installed ripgrep/);
  assert.match(result.handoff.text, /automatic downloads are disabled/); assert.equal(h.launches.length, 0);
});

test("fresh history/settings per invocation and large option/command/file-like task bytes remain literal", async (t) => {
  const opts = await options(t);
  const tasks = ["/mcp login secret\n@file.md $(touch nope) --cwd /private\n  ", "文🙂".repeat(40_000)];
  const h = harness(({ history, request, append }) => {
    assert.equal(history.buildSessionContext().messages.length, 1);
    assert.equal(request, `Research task (literal data):\n\n${tasks[h.launches.length - 1]}`);
    append(assistant(h.launches.length === 1 ? "FIRST_CHILD_SENTINEL" : "Independent final report"));
  });
  const capturedParent = { ...parent, messages: ["PARENT_SENTINEL"], activeTools: ["write"] };
  const before = JSON.stringify(capturedParent);
  for (const task of tasks) assert.equal((await runResearchSession({ agent: "scout", task }, { ...opts, parent: capturedParent }, h.services)).status, "completed");
  assert.notEqual(h.launches[0]!.sessionManager, h.launches[1]!.sessionManager);
  assert.notEqual(h.launches[0]!.settingsManager, h.launches[1]!.settingsManager);
  assert.notEqual(h.launches[0]!.modelRuntime, h.launches[1]!.modelRuntime);
  assert.equal(h.launches[0]!.cwd, opts.cwd);
  assert.equal(JSON.stringify(capturedParent), before);
  assert.equal(h.listeners.size, 0);
});

test("dispatch paths are captured before asynchronous startup rather than reread from a mutable caller object", async (t) => {
  const opts = await options(t), captured = { ...opts };
  const h = harness();
  h.services.createModelRuntime = async () => {
    Object.assign(opts, { cwd: "changed", agentDir: "changed", workspaceDir: "changed" });
    return unitRuntime();
  };
  const result = await runResearchSession({ agent: "scout", task: "question" }, opts, h.services);
  assert.equal(result.status, "completed");
  assert.equal(h.launches[0]!.cwd, captured.cwd); assert.equal(h.launches[0]!.agentDir, captured.agentDir);
});

test("only final authoritative text blocks enter handoff; activity has no transcript; usage is counted once from history", async (t) => {
  const opts = await options(t);
  const updates: unknown[] = [];
  const h = harness(({ history, append, emit }) => {
    append(assistant("INTERIM_NARRATION", "toolUse"));
    emit({ type: "tool_execution_start", toolCallId: "one", toolName: "read", args: { path: "ARGUMENT_SECRET" } });
    const tool = { role: "toolResult", toolCallId: "one", toolName: "read", content: [{ type: "text", text: "TOOL_SECRET" }], details: { private: "DETAIL_SECRET" }, usage: usage(2), isError: false, timestamp: Date.now() } as const;
    // Tool execution events (including nested results) are not separately billed again.
    emit({ type: "tool_execution_end", toolCallId: "one", toolName: "read", result: { content: [], details: undefined, usage: usage(50) }, isError: false });
    append({ ...tool, content: [...tool.content] });
    history.appendUsage("fixture_extra", "fixture", "model", usage(3));
    append(assistant([{ type: "thinking", thinking: "REASONING_SECRET" }, { type: "text", text: "## Answer\nFinal" }, { type: "text", text: "## Evidence\nfile.ts:1" }], "stop", 4));
  });
  const result = await runResearchSession({ agent: "scout", task: "question" }, { ...opts, onActivity: (value) => updates.push(value) }, h.services);
  assert.equal(result.handoff.text, "## Answer\nFinal\n## Evidence\nfile.ts:1");
  assert.equal(result.status, "completed");
  assert.deepEqual(result.usage, usage(10));
  assert.deepEqual(result.activity, { assistantMessages: 2, toolCalls: 1, latestTool: "read" });
  assert.equal(updates.length, 3);
  assert.doesNotMatch(JSON.stringify([updates, result]), /SECRET|INTERIM/);
  assert.deepEqual(h.calls, ["subscribe", "bind", "prompt", "abort", "shutdown", "unsubscribe", "dispose"]);
});

test("malformed optional provider usage is omitted rather than invented or leaking an uncaught failure", async (t) => {
  const opts = await options(t);
  const h = harness(({ append }) => {
    const message = assistant("Valid final report");
    Object.assign(message.usage, { cost: undefined }); // Simulate an untyped provider's malformed metadata.
    append(message);
  });
  const result = await runResearchSession({ agent: "scout", task: "question" }, opts, h.services);
  assert.equal(result.status, "completed"); assert.equal(result.usage, undefined);
});

test("overall prompt settlement, not an early agent end or recoverable error, determines completion", async (t) => {
  const opts = await options(t);
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const h = harness(async ({ append, emit }) => {
    append({ ...assistant("RECOVERABLE_PRIVATE", "error"), errorMessage: "transient failure" });
    emit({ type: "agent_end", messages: [], willRetry: true });
    await wait;
    append(assistant("Recovered final report"));
  });
  let settled = false;
  const pending = runResearchSession({ agent: "scout", task: "question" }, opts, h.services).then((result) => { settled = true; return result; });
  while (!h.calls.includes("prompt")) await tick();
  assert.equal(settled, false); assert.ok(!h.calls.includes("shutdown"));
  release();
  const result = await pending;
  assert.equal(result.handoff.text, "Recovered final report"); assert.equal(result.status, "completed");
});

test("terminal failures cannot fall back to earlier narration, even when prompt resolves normally", async (t) => {
  const opts = await options(t);
  for (const reason of ["error", "aborted", "length", "toolUse", "pending", "deferred"] as const) {
    const h = harness(({ append }) => { append(assistant("STALE_NARRATION")); append({ ...assistant("INCOMPLETE_FRAGMENT", reason), errorMessage: "terminal fixture" }); });
    const result = await runResearchSession({ agent: "scout", task: "question" }, opts, h.services);
    assert.equal(result.status, reason === "aborted" ? "cancelled" : "failed");
    assert.equal(result.handoff.isError, true); assert.doesNotMatch(result.handoff.text, /STALE_NARRATION|INCOMPLETE_FRAGMENT/);
    assert.equal(h.calls.filter((call) => call === "shutdown").length, 1);
  }
});

test("empty, thinking-only, absent, event-only and unfinished-tool answers fail; genuine no-findings succeeds", async (t) => {
  const opts = await options(t);
  const scripts: ((script: Script) => void)[] = [
    () => {},
    ({ append }) => append(assistant("  \n")),
    ({ append }) => append(assistant([{ type: "thinking", thinking: "private" }])),
    ({ emit }) => emit({ type: "message_end", message: assistant("Event is not authoritative history") }),
    ({ append }) => append(assistant([{ type: "text", text: "Unfinished" }, { type: "toolCall", id: "unfinished", name: "read", arguments: {} }])),
    ({ append }) => { append(assistant("Stale")); append({ role: "toolResult", toolCallId: "one", toolName: "read", content: [], isError: false, timestamp: Date.now() }); },
  ];
  for (const script of scripts) assert.equal((await runResearchSession({ agent: "scout", task: "question" }, opts, harness(script).services)).status, "failed");
  assert.equal((await runResearchSession({ agent: "scout", task: "question" }, opts, harness().services)).status, "completed");
});

test("compaction cannot replace the final report and recovery omission cannot resurrect stale narration", async (t) => {
  const opts = await options(t);
  const compacted = harness(({ history, append }) => {
    append(assistant("Final unabridged answer"));
    history.appendCompaction("COMPACTION_SUMMARY_NOT_THE_REPORT", null, 50000, undefined, false, usage(3));
    assert.ok(!history.buildSessionContext().messages.some((message) => message.role === "assistant"));
  });
  const result = await runResearchSession({ agent: "scout", task: "question" }, opts, compacted.services);
  assert.equal(result.status, "completed"); assert.equal(result.handoff.text, "Final unabridged answer");
  assert.deepEqual(result.usage, usage(4));
  const omitted = harness(({ history, append }) => {
    append(assistant("STALE_REPORT"));
    const failed = history.appendMessage({ ...assistant("PRIVATE_FAILURE", "error"), errorMessage: "terminal failure" });
    history.appendContextEdit(failed, null);
  });
  const failure = await runResearchSession({ agent: "scout", task: "question" }, opts, omitted.services);
  assert.equal(failure.status, "failed"); assert.doesNotMatch(failure.handoff.text, /STALE_REPORT|PRIVATE_FAILURE/);
});

test("selected model/auth failures happen before session creation and never fallback", async (t) => {
  const opts = await options(t);
  for (const kind of ["missing", "unavailable", "auth", "config"] as const) {
    const h = harness();
    h.services.createModelRuntime = async () => {
      const runtime = await unitRuntime();
      if (kind === "missing") runtime.getModel = () => undefined;
      if (kind === "unavailable") runtime.getAvailable = async () => [];
      if (kind === "auth") runtime.getAuth = async () => { throw new Error("DO_NOT_ECHO_CREDENTIALS"); };
      if (kind === "config") runtime.getError = () => "Invalid model configuration";
      return runtime;
    };
    const result = await runResearchSession({ agent: "scout", task: "question" }, opts, h.services);
    assert.equal(result.status, "failed"); assert.equal(h.launches.length, 0);
    assert.doesNotMatch(result.handoff.text, /DO_NOT_ECHO/);
  }
});

test("SDK fallback, startup throws, changed tool policy, and lifecycle error-channel failures are explicit", async (t) => {
  const opts = await options(t);
  for (const kind of ["fallback", "model-changed", "bind", "tools", "lifecycle", "shutdown", "shutdown-reject", "abort", "dispose"] as const) {
    const h = harness();
    const create = h.services.createSession;
    h.services.createSession = async (input) => {
      const created = await create(input);
      if (kind === "fallback") return { ...created, modelFallbackMessage: "fallback" };
      if (kind === "model-changed") Object.assign(created.session, { model: { ...created.session.model!, id: "other-model" } });
      if (kind === "bind") created.session.bindExtensions = async () => { throw new Error("bind failed"); };
      if (kind === "tools") created.session.getCallableToolNames = () => ["read", "write"];
      if (kind === "lifecycle") {
        const bind = created.session.bindExtensions.bind(created.session);
        created.session.bindExtensions = async (bindings) => { await bind(bindings); h.error("startup channel failure", "session_start"); };
      }
      if (kind === "shutdown") created.session.extensionRunner.emit = async () => { h.calls.push("shutdown"); h.error("shutdown channel failure"); };
      if (kind === "shutdown-reject") created.session.extensionRunner.emit = async () => { h.calls.push("shutdown"); throw new Error("shutdown rejected"); };
      if (kind === "abort") created.session.abort = async () => { throw new Error("abort rejected"); };
      if (kind === "dispose") created.session.dispose = () => { throw new Error("dispose failed"); };
      return created;
    };
    const result = await runResearchSession({ agent: "scout", task: "question" }, opts, h.services);
    assert.equal(result.status, "failed", kind);
    assert.equal(h.calls.filter((call) => call === "shutdown").length, 1);
    assert.equal(h.listeners.size, 0);
    if (!["shutdown", "shutdown-reject", "abort", "dispose"].includes(kind)) assert.ok(!h.calls.includes("prompt"));
  }
});

test("abort/idle and native shutdown run concurrently; cancellation closes once and never fabricates a partial report", async (t) => {
  const opts = await options(t);
  const controller = new AbortController();
  let release!: () => void;
  const untilClosed = new Promise<void>((resolve) => { release = resolve; });
  const h = harness(async ({ append }) => { append(assistant("Partial narration", "toolUse")); await untilClosed; append(assistant("Late answer")); });
  const create = h.services.createSession;
  h.services.createSession = async (input) => {
    const created = await create(input);
    created.session.abort = async () => { h.calls.push("abort"); await untilClosed; };
    created.session.extensionRunner.emit = async () => { h.calls.push("shutdown"); release(); };
    return created;
  };
  const pending = runResearchSession({ agent: "scout", task: "question" }, { ...opts, signal: controller.signal }, h.services);
  while (!h.calls.includes("prompt")) await tick();
  controller.abort();
  const result = await pending;
  assert.equal(result.status, "cancelled"); assert.doesNotMatch(result.handoff.text, /Partial narration|Late answer/);
  assert.equal(h.calls.filter((call) => call === "shutdown").length, 1); assert.equal(h.listeners.size, 0);
});

test("native researcher capability barrier rejects missing tools without submitting a prompt", async (t) => {
  const opts = await options(t);
  const h = harness();
  const create = h.services.createSession;
  h.services.createSession = async (input) => {
    const created = await create(input);
    created.session.getAllTools = () => [];
    created.session.getActiveToolNames = () => [];
    return created;
  };
  const result = await runResearchSession({ agent: "researcher", task: "question" }, opts, { ...h.services, startupTimeoutMs: 1 });
  assert.equal(result.status, "failed"); assert.match(result.handoff.text, /Ketch capabilities unavailable/);
  assert.ok(!h.calls.includes("prompt")); assert.ok(h.calls.includes("shutdown"));
});

test("cancellation during session creation still shuts down the late-created owned session exactly once", async (t) => {
  const opts = await options(t), controller = new AbortController();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const h = harness(), create = h.services.createSession;
  h.services.createSession = async (input) => { const created = await create(input); await wait; return created; };
  const pending = runResearchSession({ agent: "scout", task: "question" }, { ...opts, signal: controller.signal }, h.services);
  while (!h.launches.length) await tick();
  controller.abort(); release();
  assert.equal((await pending).status, "cancelled");
  assert.deepEqual(h.calls, ["abort", "shutdown", "dispose"]);
});

test("activity callback failures cannot break native persistence/cleanup and unknown tool names are bounded metadata", async (t) => {
  const opts = await options(t);
  const h = harness(({ emit, append }) => {
    emit({ type: "tool_execution_start", toolCallId: "bad", toolName: "UNTRUSTED_SECRET".repeat(1000), args: { private: "secret" } });
    append(assistant("Final answer"));
  });
  const result = await runResearchSession({ agent: "scout", task: "question" }, { ...opts, onActivity() { throw new Error("observer unavailable"); } }, h.services);
  assert.equal(result.status, "failed"); assert.match(result.handoff.text, /Activity callback failed/);
  assert.equal(result.activity.latestTool, "unavailable tool");
  assert.doesNotMatch(JSON.stringify(result), /UNTRUSTED_SECRET/);
  assert.equal(h.listeners.size, 0); assert.ok(h.calls.includes("dispose"));
});

test("overflow preserves only the complete final report after child cleanup; storage failure and thrown diagnostics are capped", async (t) => {
  const opts = await options(t);
  const full = "## Answer\n" + "🙂 evidence ".repeat(2000);
  const h = harness(({ append }) => { append(assistant("NEVER_STORE_INTERIM")); append(assistant(full)); });
  const result = await runResearchSession({ agent: "scout", task: "question" }, opts, h.services);
  assert.equal(result.status, "completed"); assert.equal(result.handoff.truncated, true);
  assert.ok(h.calls.includes("dispose"));
  assert.equal(await fs.readFile(result.handoff.reportPath!, "utf8"), full);
  assert.ok(Buffer.byteLength(result.handoff.text) <= MAX_HANDOFF_BYTES);
  t.after(() => fs.rm(dirname(result.handoff.reportPath!), { recursive: true, force: true }));
  const failed = await runResearchSession({ agent: "scout", task: "question" }, { ...opts, scratchDir: opts.workspaceDir }, harness(({ append }) => append(assistant(full))).services);
  assert.equal(failed.status, "failed"); assert.equal(failed.handoff.reportPath, undefined);
  const thrown = await runResearchSession({ agent: "scout", task: "question" }, opts, harness(() => { throw new Error("Failure🙂".repeat(5000)); }).services);
  assert.equal(thrown.status, "failed"); assert.ok(Buffer.byteLength(thrown.handoff.text) <= MAX_HANDOFF_BYTES);
});
