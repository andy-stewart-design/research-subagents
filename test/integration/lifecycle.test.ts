import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { StdioTransport } from "@earendil-works/pi-mcp";
import { createAgentSession, type AgentSession, type CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { parseConfig } from "../../lib/config.ts";
import { ResearchRunner } from "../../lib/runner.ts";
import { createOwnedKetchTransport } from "../../lib/ketch.ts";
import { createChildModelRuntime, runResearchSession, type ResearchSessionOptions, type SessionServices } from "../../lib/session.ts";
import { assistant, completedStream } from "../fixtures/session-fixtures.ts";

const fixtureServer = fileURLToPath(new URL("../fixtures/fake-mcp-server.mjs", import.meta.url));
const provider = "lifecycle-fixture";
const modelId = "catalog/research";

async function setup(t: TestContext, mode: "unresponsive" | "hang-call") {
  const root = await fs.mkdtemp(join(tmpdir(), "research-lifecycle-"));
  const cwd = join(root, "project"), agentDir = join(root, "agent");
  await fs.mkdir(cwd); await fs.mkdir(agentDir);
  await fs.writeFile(join(agentDir, "auth.json"), JSON.stringify({ [provider]: { type: "api_key", key: "offline-fixture" } }));
  await fs.writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { [provider]: {
    api: "openai-completions", baseUrl: "https://must-not-contact.invalid/v1",
    models: [{ id: modelId, name: "Lifecycle fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
  } } }));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const pids = new Set<number>();
  let currentSession: AgentSession | undefined;
  let requests = 0;
  const services: Partial<SessionServices> = {
    hasScoutBinary: () => true,
    startupTimeoutMs: 1000,
    async createModelRuntime(childAgentDir, selection, signal) {
      const runtime = await createChildModelRuntime(childAgentDir, selection, signal);
      runtime.streamSimple = (model, context) => {
        requests++;
        const session = currentSession!;
        assert.deepEqual(session.getActiveToolNames().sort(), [
          "mcp__ketch__search", "mcp__ketch__scrape", "mcp__ketch__code", "mcp__ketch__docs",
        ].sort());
        if (requests === 1) {
          return completedStream(assistant([{ type: "toolCall", id: "hang", name: "mcp__ketch__search", arguments: { query: "lifecycle" } }], "toolUse", 1, model));
        }
        return completedStream(assistant("Completed unexpectedly.", "stop", 1, model));
      };
      return runtime;
    },
    mcpOptions: {
      logPath: join(root, "mcp.log"),
      createTransport(server) {
        const transport = new StdioTransport({
          command: process.execPath,
          args: [fixtureServer],
          cwd: root,
          env: {
            FAKE_MCP_TOOLS: "search,scrape,code,docs",
            ...(mode === "unresponsive" ? { FAKE_MCP_UNRESPONSIVE: "1" } : {}),
            ...(mode === "hang-call" ? { FAKE_MCP_HANG_CALL: "1" } : {}),
          },
        });
        const start = transport.start.bind(transport);
        transport.start = async () => { await start(); if (transport.pid) pids.add(transport.pid); };
        assert.equal(server.name, "ketch");
        return transport;
      },
    },
    async createSession(input: CreateAgentSessionOptions) {
      const result = await createAgentSession(input);
      currentSession = result.session;
      return result;
    },
  };
  const options: ResearchSessionOptions = {
    cwd, workspaceDir: cwd, agentDir,
    parent: { model: { provider, id: modelId } },
    config: parseConfig({ profiles: { researcher: { model: `${provider}/${modelId}`, thinking: "max" } } }),
  };
  return { root, options, services, pids, get requests() { return requests; } };
}

async function waitForFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try { return (await fs.readFile(path, "utf8")).trim(); } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  throw new Error(`Fixture did not create ${path}.`);
}

async function assertExited(pids: Set<number>) {
  for (const pid of pids) {
    for (let attempt = 0; attempt < 30; attempt++) {
      try { process.kill(pid, 0); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (attempt === 29) assert.fail(`owned MCP process ${pid} did not exit`);
    }
  }
}

test("the feature-owned transport force-closes a same-group descendant after native close", { timeout: 10_000 }, async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "research-process-group-"));
  const parentPidFile = join(root, "parent.pid"), descendantPidFile = join(root, "descendant.pid");
  const transport = createOwnedKetchTransport({
    name: "ketch",
    source: "fixture",
    config: {
      command: process.execPath,
      args: [fixtureServer],
      env: {
        FAKE_MCP_PID: parentPidFile,
        FAKE_MCP_DESCENDANT_PID: descendantPidFile,
        FAKE_MCP_DESCENDANT_INHERIT_PIPES: "1",
      },
    },
  }, root);
  t.after(async () => { try { await transport.close(); } catch { /* preserve the test failure */ } await fs.rm(root, { recursive: true, force: true }); });
  await transport.start();
  const parentPid = Number(await waitForFile(parentPidFile));
  const descendantPid = Number(await waitForFile(descendantPidFile));
  await transport.close();
  await assertExited(new Set([parentPid, descendantPid]));
});

test("an unresponsive MCP startup fails closed and native teardown exits the owned process", { timeout: 10_000 }, async (t) => {
  const fixture = await setup(t, "unresponsive");
  const result = await runResearchSession({ agent: "researcher", task: "startup" }, fixture.options, fixture.services);
  assert.equal(result.status, "failed");
  assert.match(result.handoff.text, /Ketch capabilities unavailable/);
  assert.equal(fixture.requests, 0);
  await assertExited(fixture.pids);
});

test("a configured timeout aborts a running native tool, closes MCP, and leaves no orphan process", { timeout: 10_000 }, async (t) => {
  const fixture = await setup(t, "hang-call");
  const runner = new ResearchRunner({ maxConcurrency: 1, timeoutMs: 1500, services: fixture.services });
  const result = await runner.run({ agent: "researcher", task: "running timeout" }, fixture.options);
  assert.equal(result.status, "timed_out");
  assert.match(result.handoff.text, /timed out/);
  assert.ok(fixture.requests >= 1);
  await runner.shutdown();
  await assertExited(fixture.pids);
});