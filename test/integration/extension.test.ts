import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { runToolCall } from "@earendil-works/pi-agent-core";
import { StdioTransport } from "@earendil-works/pi-mcp";
import {
  createAgentSession, createCodemodeExtension, createMcpExtension, DefaultResourceLoader,
  ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionError, type LoadedMcpConfig,
} from "@earendil-works/pi-coding-agent";
import { createResearchExtension } from "../../extensions/research.ts";
import { parseConfig } from "../../lib/config.ts";
import { ResearchRunner } from "../../lib/runner.ts";
import type { SessionOutcome } from "../../lib/session.ts";

const fixtureServer = fileURLToPath(new URL("../fixtures/fake-mcp-server.mjs", import.meta.url));

function reportOutcome(): SessionOutcome {
  return {
    status: "completed",
    handoff: { text: "## Answer\nPublic pipeline report.\n## Evidence\nfixture:1", truncated: false, isError: false },
    activity: { assistantMessages: 2, toolCalls: 3, latestTool: "read" },
  };
}

test("public research completes through the native extension tool pipeline without transcript handoff", { timeout: 10_000 }, async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "research-extension-"));
  const cwd = join(root, "project"), agentDir = join(root, "agent"), pids: number[] = [];
  await fs.mkdir(cwd); await fs.mkdir(agentDir);
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const errors: ExtensionError[] = [];
  let session: AgentSession | undefined;
  t.after(async () => {
    if (session) {
      try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); } catch { /* preserve the test failure */ }
      try { session.dispose(); } catch { /* preserve the test failure */ }
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const configured: LoadedMcpConfig = { servers: [], errors: [] };
  const createTransport = () => {
    const transport = new StdioTransport({
      command: process.execPath,
      args: [fixtureServer],
      cwd: root,
      env: { FAKE_MCP_TOOLS: "search,scrape,code,docs", FAKE_MCP_DELAY_MS: "0" },
    });
    const start = transport.start.bind(transport);
    transport.start = async () => { await start(); if (transport.pid) pids.push(transport.pid); };
    return transport;
  };
  const extension = createResearchExtension({
    getAgentDir: () => agentDir,
    loadConfig: () => parseConfig({}),
    createRunner: (config) => new ResearchRunner({
      maxConcurrency: config.maxConcurrency,
      runSession: async () => reportOutcome(),
    }),
  });
  const settingsManager = SettingsManager.inMemory({ defaultTools: ["read", "subagent"] });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: "Native extension pipeline fixture.", appendSystemPrompt: [],
    extensionFactories: [
      createCodemodeExtension({ mode: "on" }),
      createMcpExtension({ loadConfig: () => configured, createTransport, logPath: join(root, "mcp.log") }),
      extension,
    ],
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const model = modelRuntime.getModel("anthropic", "claude-sonnet-4-5");
  assert.ok(model);
  const history = SessionManager.inMemory(cwd);
  ({ session } = await createAgentSession({
    cwd, agentDir, model, modelRuntime, resourceLoader, settingsManager, sessionManager: history,
    tools: ["read", "subagent"], thinkingLevel: "off",
  }));
  await session.bindExtensions({ onError: (error) => errors.push(error) });
  history.appendMessage({
    role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [{ type: "toolCall", id: "fixture-subagent", name: "subagent", arguments: { agent: "scout", task: "Find the fixture fact." } }],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse", timestamp: Date.now(),
  });
  session.refreshContext();
  const assistant = session.agent.state.messages.findLast((message) => message.role === "assistant");
  assert.ok(assistant && assistant.role === "assistant");
  const call = await runToolCall({
    type: "toolCall", id: "fixture-subagent", name: "subagent",
    arguments: { agent: "scout", task: "Find the fixture fact." },
  }, {
    tools: session.agent.state.tools,
    assistantMessage: assistant,
    context: { messages: session.agent.state.messages, tools: session.agent.state.tools },
  });
  assert.equal(call.isError, false);
  assert.match(JSON.stringify(call.result.structuredContent), /Public pipeline report/);
  assert.doesNotMatch(JSON.stringify(call.result), /reasoning|PRIVATE_TRANSCRIPT/);
  assert.ok(session.getActiveToolNames().includes("subagent"));
  assert.ok(session.getActiveToolNames().includes("read"));

  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
  session = undefined;
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.deepEqual(errors, []);
});
