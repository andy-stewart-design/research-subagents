import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { StdioTransport } from "@earendil-works/pi-mcp";
import { runToolCall } from "@earendil-works/pi-agent-core";
import {
  createAgentSession, createCodemodeExtension, createMcpExtension, DefaultResourceLoader,
  ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionError, type ExtensionFactory, type LoadedMcpConfig,
} from "@earendil-works/pi-coding-agent";
import entryPoint from "../../index.ts";
import { KETCH_TOOLS, createResearcherMcpExtension, waitForKetchCapabilities } from "../../lib/ketch.ts";

const fixtureFile = fileURLToPath(new URL("../fixtures/fake-mcp-server.mjs", import.meta.url));
interface SetupOptions {
  mode?: "parent" | "researcher";
  tools?: string;
  delayMs?: number;
  missingExecutable?: boolean;
  override?: boolean;
  unrelated?: boolean;
}

async function setup(t: TestContext, options: SetupOptions = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), "research-ketch-test-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await fs.mkdir(cwd);
  await fs.mkdir(agentDir);
  // Sentinels are deliberately never handed to the researcher's MCP loader.
  await fs.mkdir(join(cwd, ".pi"));
  const mcpSentinel = JSON.stringify({ mcpServers: { unwanted: { command: "must-not-run" } } });
  await fs.writeFile(join(cwd, ".pi", "mcp.json"), mcpSentinel);
  await fs.writeFile(join(agentDir, "mcp.json"), mcpSentinel);
  const callLog = join(root, "calls.jsonl");
  const transports: StdioTransport[] = [];
  const connections: string[] = [];
  const errors: ExtensionError[] = [];
  let session: AgentSession | undefined;
  t.after(async () => {
    try {
      if (session) {
        const pids = transports.flatMap((transport) => transport.pid ? [transport.pid] : []);
        try {
          await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        } finally {
          session.dispose();
        }
        for (const pid of pids) {
          assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
        }
      }
      assert.deepEqual(errors, []);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  const createTransport = (server: { name: string; source: string }) => {
    connections.push(server.name);
    const transport = new StdioTransport({
      command: options.missingExecutable ? join(root, "missing-executable") : process.execPath,
      args: [fixtureFile], cwd,
      env: {
        FAKE_MCP_CALL_LOG: callLog,
        FAKE_MCP_TOOLS: options.tools ?? "search,scrape,code,docs,crawl,tag,delete_database",
        FAKE_MCP_DELAY_MS: String(options.delayMs ?? 0),
        FAKE_MCP_MARKER: server.source === "configured-fixture" ? "file-override" : "default-registration",
      },
    });
    transports.push(transport);
    return transport;
  };
  const configured: LoadedMcpConfig = {
    servers: options.override ? [{ name: "ketch", config: {
      command: "user-configured-ketch", exposure: "hidden",
      toolExposure: { search: "codemode", scrape: "codemode", code: "codemode", docs: "codemode" },
    }, source: "configured-fixture", scope: "global" }] : [],
    errors: [],
  };
  const mode = options.mode ?? "parent";
  const factories: ExtensionFactory[] = mode === "parent"
    ? [createCodemodeExtension({ mode: "on" }), createMcpExtension({ loadConfig: () => configured, createTransport, logPath: join(root, "mcp.log") }), entryPoint]
    : [createResearcherMcpExtension({ createTransport, logPath: join(root, "mcp.log") })];
  if (options.unrelated) factories.push((pi) => pi.registerMcpServer("unrelated", { command: "unrelated-user-tool", exposure: "direct" }));
  const settingsManager = SettingsManager.inMemory({ defaultTools: ["read"] });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true,
    noThemes: true, noContextFiles: true, systemPrompt: "Offline MCP composition test.",
    appendSystemPrompt: [], extensionFactories: factories,
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const model = modelRuntime.getModel("anthropic", "claude-sonnet-4-5");
  assert.ok(model, "Need a bundled model descriptor only; no model request is made.");
  const history = SessionManager.inMemory(cwd);
  ({ session } = await createAgentSession({
    cwd, agentDir, model, thinkingLevel: "off", modelRuntime, resourceLoader, settingsManager,
    sessionManager: history, ...(mode === "researcher" ? { tools: [...KETCH_TOOLS] } : {}),
  }));
  await session.bindExtensions({ onError: (error) => errors.push(error) });
  // Native nested execution requires an issuing assistant message. Seed a scripted fixture,
  // not a model response, and restore it through the public authoritative-history API.
  history.appendMessage({
    role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [{ type: "toolCall", id: "fixture-parent", name: "fixture", arguments: {} }],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse", timestamp: Date.now(),
  });
  session.refreshContext();
  const current = session;
  const view = { getAllTools: () => current.getAllTools(), getActiveTools: () => current.getActiveToolNames() };
  const ready = (timeoutMs = 3000, signal?: AbortSignal) => waitForKetchCapabilities(view, { mode, timeoutMs, ...(signal ? { signal } : {}) });
  const context = current.extensionRunner.createToolContext("fixture-parent", undefined);
  const calls = async () => (await fs.readFile(callLog, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { session: current, ready, context, calls, connections, root, cwd, agentDir, mcpSentinel };
}

function text(result: { content: { type: string; text?: string }[] }) {
  return result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

// These are genuine native sessions, MCP clients/transports, and tool pipelines, but no LLM runs.
test("parent Ketch is callable programmatically through native wrappers without a research child", { timeout: 10_000 }, async (t) => {
  const harness = await setup(t, { unrelated: true });
  await harness.ready();
  assert.ok(harness.session.getActiveToolNames().includes("read"));
  assert.ok(harness.session.getActiveToolNames().includes("codemode"));
  assert.ok(harness.session.getAllTools().some((tool) => tool.name === "research"));
  for (const name of KETCH_TOOLS) {
    assert.ok(!harness.session.getActiveToolNames().includes(name));
    const args = name.endsWith("scrape") ? { url: "https://example.test/page", max_chars: 6000 } : { query: "question", limit: 5 };
    const outcome = await harness.context.executeTool(name, args);
    assert.equal(outcome.isError, false, text(outcome.result));
    const payload = outcome.result.structuredContent as { structuredContent: { marker: string; results: unknown[] }; isError: boolean };
    assert.equal(payload.isError, false);
    assert.equal(payload.structuredContent.marker, "default-registration");
    assert.equal(payload.structuredContent.results.length, 1);
  }
  assert.equal((await harness.calls()).length, 4);
  assert.deepEqual(harness.connections.sort(), ["ketch", "unrelated"]);
  assert.equal(harness.session.model?.id, "claude-sonnet-4-5");
  assert.equal(await fs.readFile(join(harness.cwd, ".pi", "mcp.json"), "utf8"), harness.mcpSentinel);
  assert.equal(await fs.readFile(join(harness.agentDir, "mcp.json"), "utf8"), harness.mcpSentinel);
});

test("actual codemode scripts receive complete structured Ketch values and cannot find hidden tools", { timeout: 10_000 }, async (t) => {
  const harness = await setup(t);
  await harness.ready();
  const assistant = harness.session.agent.state.messages.findLast((message) => message.role === "assistant");
  assert.ok(assistant && assistant.role === "assistant");
  // Codemode is model-only: issue it through the public top-level tool runner, not nested executeTool.
  const outcome = await runToolCall({ type: "toolCall", id: "fixture-parent", name: "codemode", arguments: { code: `
    const result = await tools.mcp__ketch__search({ query: "script", limit: 2 });
    text(result.structuredContent);
    text(ALL_TOOLS.filter(tool => tool.name.startsWith("mcp__ketch__")).map(tool => tool.name).sort());
    text(await describeTool("mcp__ketch__tag") ?? "hidden");
    const failure = await tools.mcp__ketch__search({ query: "[precondition]" });
    text({ isError: failure.isError, error: failure.content[0].text });
  ` } }, {
    tools: harness.session.agent.state.tools,
    assistantMessage: assistant,
    context: { messages: harness.session.agent.state.messages, tools: harness.session.agent.state.tools },
  });
  assert.equal(outcome.isError, false, text(outcome.result));
  const output = text(outcome.result);
  assert.match(output, /Controlled evidence/);
  assert.match(output, /hidden/);
  assert.match(output, /precondition/);
  assert.match(output, /"isError":\s*true/);
  assert.doesNotMatch(output, /mcp__ketch__(tag|crawl|delete_database)/);
  for (const name of KETCH_TOOLS) assert.ok(output.includes(name));
});

test("hidden tools and resource tools stay unreachable even through indirect execution", { timeout: 10_000 }, async (t) => {
  const harness = await setup(t);
  await harness.ready();
  harness.session.setActiveToolsByName([...harness.session.getActiveToolNames(), "mcp__ketch__tag", "mcp__ketch__crawl"]);
  assert.ok(!harness.session.getActiveToolNames().includes("mcp__ketch__tag"));
  for (const name of ["mcp__ketch__tag", "mcp__ketch__crawl", "mcp__ketch__delete_database", "read_mcp_resource"]) {
    assert.ok(!harness.session.getCallableToolNames().includes(name));
    assert.equal((await harness.context.executeTool(name, { query: "must-not-run" })).isError, true);
  }
  const invalid = await harness.context.executeTool("mcp__ketch__search", {});
  assert.equal(invalid.isError, true);
  await assert.rejects(harness.calls(), { code: "ENOENT" });
});

test("researcher config loads only Ketch with four direct tools and no indirect activation", { timeout: 10_000 }, async (t) => {
  const harness = await setup(t, { mode: "researcher" });
  await harness.ready();
  assert.deepEqual(harness.connections, ["ketch"]);
  assert.deepEqual(harness.session.getActiveToolNames().sort(), [...KETCH_TOOLS].sort());
  assert.deepEqual(harness.session.getCallableToolNames().sort(), [...KETCH_TOOLS].sort());
  assert.ok(!harness.session.getAllTools().some((tool) => ["codemode", "tool_search"].includes(tool.name)));
  const outcome = await harness.context.executeTool("mcp__ketch__docs", { query: "library question", limit: 5 });
  assert.equal(outcome.isError, false, text(outcome.result));
});

test("configured server entries take native precedence without replacing registrations or files", { timeout: 10_000 }, async (t) => {
  const harness = await setup(t, { override: true });
  await harness.ready();
  const outcome = await harness.context.executeTool("mcp__ketch__code", { query: "override" });
  assert.equal(outcome.isError, false);
  assert.match(text(outcome.result), /file-override/);
  assert.deepEqual(harness.connections, ["ketch"]);
  assert.equal(await fs.readFile(join(harness.agentDir, "mcp.json"), "utf8"), harness.mcpSentinel);
});

test("an incompatible configured server is reported instead of falling back or repairing configuration", { timeout: 10_000 }, async (t) => {
  const harness = await setup(t, { override: true, tools: "search,scrape,code" });
  await assert.rejects(harness.ready(250), /mcp__ketch__docs.*conflicting mcp.json/);
  assert.deepEqual(harness.connections, ["ketch"]);
  assert.equal(await fs.readFile(join(harness.agentDir, "mcp.json"), "utf8"), harness.mcpSentinel);
});

test("MCP error prefixes and mixed per-URL/backend failures survive native tool adaptation", { timeout: 10_000 }, async (t) => {
  const harness = await setup(t);
  await harness.ready();
  for (const prefix of ["validation", "not_found", "upstream", "precondition", "cancelled"]) {
    const outcome = await harness.context.executeTool("mcp__ketch__search", { query: "[" + prefix + "]" });
    assert.equal(outcome.isError, true);
    assert.ok(text(outcome.result).includes("[" + prefix + "]"));
    assert.equal((outcome.result.structuredContent as { isError: boolean }).isError, true);
  }
  const scrape = await harness.context.executeTool("mcp__ketch__scrape", { urls: ["https://example.test/good", "https://bad.example"] });
  assert.equal(scrape.isError, false);
  assert.match(text(scrape.result), /fixture fetch failure/);
  assert.match(text(scrape.result), /Fixture page/);
  const search = await harness.context.executeTool("mcp__ketch__search", { query: "partial" });
  assert.equal(search.isError, false);
  assert.match(text(search.result), /backend unavailable/);
});

test("missing executable or required tool cannot pass the pre-prompt capability barrier", { timeout: 10_000 }, async (t) => {
  for (const options of [{ missingExecutable: true }, { tools: "search,scrape,code,tag" }]) {
    const harness = await setup(t, { mode: "researcher", ...options });
    await assert.rejects(harness.ready(250), /Ketch capabilities unavailable/);
    assert.equal(harness.session.messages.filter((message) => message.role === "assistant").length, 1); // Scripted fixture only.
  }
});

test("slow native discovery waits for readiness and cancelled startup remains incomplete", { timeout: 10_000 }, async (t) => {
  const slow = await setup(t, { mode: "researcher", delayMs: 80 });
  await slow.ready();
  const waiting = await setup(t, { mode: "researcher", delayMs: 1000 });
  const controller = new AbortController();
  const pending = waiting.ready(3000, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});
