import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Value } from "typebox/value";
import { createResearchExtension } from "../extensions/research.ts";
import { ResearchConfigSchema, parseConfig, selectModel } from "../lib/config.ts";
import { ResearchInputSchema, discoverProfiles, loadProfile, parseResearchInput } from "../lib/profiles.ts";
import { ResearchRunner, resolveResearchTimeout } from "../lib/runner.ts";
import type { SessionOutcome } from "../lib/session.ts";

function outcome(): SessionOutcome {
  return {
    status: "completed",
    handoff: { text: "## Answer\nreviewed", truncated: false, isError: false },
    activity: { assistantMessages: 1, toolCalls: 0 },
  };
}

test("a markdown agent definition supplies the schema, config, model, prompt, and dispatch", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "research-agent-discovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "README.md"), "ignored");
  writeFileSync(join(root, "notes.txt"), "ignored");
  writeFileSync(join(root, ".hidden.md"), "ignored");
  writeFileSync(join(root, "reviewer.md"), `---
model: fixture/reviewer
thinking: low
maxTimeout: 30
tools:
  # The discovery path must preserve ordinary YAML formatting.
  - "read"
  - grep
description: Reviews local changes without editing.
---
# Reviewer
Inspect the requested changes.`);

  const registry = discoverProfiles(root);
  assert.deepEqual(registry.names, ["reviewer"]);
  assert.equal(registry.profiles.reviewer?.description, "Reviews local changes without editing.");
  assert.deepEqual(loadProfile("reviewer", registry).tools, ["read", "grep"]);
  assert.deepEqual(loadProfile("reviewer", registry).defaults, { model: "fixture/reviewer", thinking: "low" });
  assert.equal(loadProfile("reviewer", registry).maxTimeout, 30);
  assert.deepEqual(parseResearchInput({ agent: "reviewer", task: "review this", timeout_ms: 5000 }, registry), {
    agent: "reviewer", task: "review this", timeout_ms: 5000,
  });
  assert.equal(resolveResearchTimeout({ agent: "reviewer", task: "review" }, 120_000, registry), 30_000);
  assert.throws(() => resolveResearchTimeout({ agent: "reviewer", task: "review", timeout_ms: 0 }, 120_000, registry), /exceeds/);
  assert.throws(() => resolveResearchTimeout({ agent: "reviewer", task: "review", timeout_ms: 30_001 }, 120_000, registry), /exceeds/);
  assert.throws(() => parseResearchInput({ agent: "scout", task: "not registered" }, registry), /Invalid research input/);
  const config = parseConfig({ profiles: { reviewer: { thinking: "high" } } }, registry);
  assert.equal(config.profiles.reviewer?.thinking, "high");
  assert.deepEqual(selectModel("reviewer", config, {}, loadProfile("reviewer", registry).defaults, registry), {
    provider: "fixture", modelId: "reviewer", thinkingLevel: "high",
  });
  assert.ok(Value.Check(registry.inputSchema, { agent: "reviewer", task: "review this" }));

  let dispatched: unknown;
  const extension = createResearchExtension({
    profileRegistry: registry,
    getAgentDir: () => root,
    createRunner: (loaded, profileRegistry) => new ResearchRunner({
      maxConcurrency: loaded.maxConcurrency,
      ...(profileRegistry ? { profileRegistry } : {}),
      runSession: async (input, options) => {
        dispatched = { input, tools: loadProfile("reviewer", options.profileRegistry!).tools };
        return outcome();
      },
    }),
  });
  let tool: any;
  const api = {
    registerTool(definition: unknown) { tool = definition; },
    on() { return () => {}; },
    getMcpServers() { return []; },
  } as any;
  extension(api);
  assert.equal(tool.description.includes("reviewer (Reviews local changes without editing.)"), true);
  assert.ok(Value.Check(tool.parameters, { agent: "reviewer", task: "review this" }));
  const result = await tool.execute("review-1", { agent: "reviewer", task: "review this" }, undefined, undefined, {
    cwd: root,
    model: { provider: "fixture", id: "parent" },
    thinkingLevel: "medium",
    isProjectTrusted: () => false,
  });
  assert.equal(result.structuredContent.status, "completed");
  assert.deepEqual(dispatched, { input: { agent: "reviewer", task: "review this" }, tools: ["read", "grep"] });
});

test("runner accepts a custom registry supplied only by session options and rejects mismatched snapshots", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "research-agent-runner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "reviewer.md"), "---\\nmodel: fixture/reviewer\\ntools: []\\n---\\n# Reviewer\\nReview.");
  const registry = discoverProfiles(root);
  const config = parseConfig({}, registry);
  let received: unknown;
  const runner = new ResearchRunner({
    maxConcurrency: 1,
    runSession: async (input, options) => {
      received = { input, registry: options.profileRegistry };
      return outcome();
    },
  });
  const result = await runner.run({ agent: "reviewer", task: "review" }, {
    ...baseSessionOptions(root), config, profileRegistry: registry,
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(received, { input: { agent: "reviewer", task: "review" }, registry });

  const mismatched = new ResearchRunner({ maxConcurrency: 1, profileRegistry: registry, runSession: async () => outcome() });
  const mismatchResult = await mismatched.run({ agent: "reviewer", task: "review" }, {
    ...baseSessionOptions(root), config, profileRegistry: discoverProfiles(root),
  });
  assert.equal(mismatchResult.status, "failed");
  assert.match(mismatchResult.handoff.text, /registry snapshot mismatch/);
});

function baseSessionOptions(root: string) {
  return {
    cwd: root, workspaceDir: root, agentDir: root,
    parent: { model: { provider: "fixture", id: "parent" } },
  } as const;
}

test("timeout policy preserves unlimited and finite-ceiling semantics", (t) => {
  const root = mkdtempSync(join(tmpdir(), "research-timeout-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "unbounded.md"), "---\nmaxTimeout: 0\n---\n# Unbounded");
  writeFileSync(join(root, "global.md"), "# Global");
  writeFileSync(join(root, "bounded.md"), "---\nmaxTimeout: 10\n---\n# Bounded");
  const registry = discoverProfiles(root);
  assert.equal(resolveResearchTimeout({ agent: "global", task: "x" }, 0, registry), undefined);
  assert.equal(resolveResearchTimeout({ agent: "bounded", task: "x" }, 0, registry), 10_000);
  assert.equal(resolveResearchTimeout({ agent: "unbounded", task: "x" }, 5000, registry), undefined);
  assert.equal(resolveResearchTimeout({ agent: "unbounded", task: "x", timeout_ms: 2500 }, 0, registry), 2500);
  assert.throws(() => resolveResearchTimeout({ agent: "bounded", task: "x", timeout_ms: 0 }, 0, registry), /exceeds/);
});

test("schema snapshots are deeply immutable and parsing keeps independent registry membership", (t) => {
  const root = mkdtempSync(join(tmpdir(), "research-agent-schema-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "reviewer.md"), "# Reviewer\\nReview.");
  const registry = discoverProfiles(root);
  assert.ok(Object.isFrozen(registry.inputSchema));
  assert.ok(Object.isFrozen(ResearchInputSchema));
  assert.ok(Object.isFrozen(ResearchConfigSchema));
  assert.throws(() => Object.assign(ResearchInputSchema, { properties: {} }), TypeError);
  assert.throws(() => Object.assign(ResearchConfigSchema, { properties: {} }), TypeError);
  assert.deepEqual(parseResearchInput({ agent: "reviewer", task: "review" }, registry), {
    agent: "reviewer", task: "review",
  });
  assert.throws(() => parseResearchInput({ agent: "reviewer", task: "review" }), /Invalid research input/);
});

test("reserved names are rejected and custom names never inherit bundled fallback tools or config", (t) => {
  const root = mkdtempSync(join(tmpdir(), "research-agent-reserved-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ["constructor", "prototype", "__proto__"]) {
    writeFileSync(join(root, `${name}.md`), "# Invalid");
    assert.throws(() => discoverProfiles(root), /Invalid agent filename/);
    rmSync(join(root, `${name}.md`));
  }
  writeFileSync(join(root, "custom-agent.md"), "# Custom\\nNo tools.");
  const registry = discoverProfiles(root);
  assert.deepEqual(registry.profiles["custom-agent"]?.tools, []);
  const inheritedProfiles = Object.create({ "custom-agent": { thinking: "high" } });
  const config = parseConfig({ profiles: inheritedProfiles }, registry);
  assert.equal(config.profiles["custom-agent"], undefined);
  assert.deepEqual(selectModel("custom-agent", config, { model: { provider: "fixture", id: "parent" } }, {}, registry), {
    provider: "fixture", modelId: "parent",
  });
});

test("new definitions fail closed when tools are omitted, and malformed names are rejected", (t) => {
  const root = mkdtempSync(join(tmpdir(), "research-agent-invalid-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "reviewer.md"), "---\nmodel: fixture/reviewer\n---\n# Reviewer\nNo tools.");
  assert.deepEqual(discoverProfiles(root).profiles.reviewer?.tools, []);
  writeFileSync(join(root, "bad name.md"), "# Invalid");
  assert.throws(() => discoverProfiles(root), /Invalid agent filename.*bad name\.md/);
  rmSync(join(root, "bad name.md"));
  writeFileSync(join(root, "broken.md"), "---\ntools: [read, mystery]\n---\n# Broken");
  assert.throws(() => discoverProfiles(root), /Invalid agent definition.*broken\.md.*unsupported tool name/);
});
