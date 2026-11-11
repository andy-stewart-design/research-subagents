import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import {
  PROFILE_NAMES,
  PROFILES,
  ResearchInputSchema,
  getProfile,
  loadProfileDefaults, loadProfilePrompt, parseProfilePrompt,
  parseResearchInput,
  type ProfileName,
} from "../lib/profiles.ts";

test("the bundled profiles have fixed tool policies", () => {
  assert.deepEqual(PROFILE_NAMES, ["scout", "researcher", "worker"]);
  assert.deepEqual(Object.keys(PROFILES), [...PROFILE_NAMES]);
  assert.deepEqual(getProfile("scout").tools, ["read", "grep", "find", "ls"]);
  assert.deepEqual(getProfile("researcher").tools, [
    "mcp__ketch__search", "mcp__ketch__scrape", "mcp__ketch__code", "mcp__ketch__docs",
  ]);
  assert.deepEqual(getProfile("worker").tools, ["read", "write", "edit", "bash"]);
  assert.ok(Object.isFrozen(PROFILE_NAMES) && Object.isFrozen(PROFILES));
});

test("callers cannot mutate bundled tools or register an extra profile", () => {
  assert.throws(() => (getProfile("scout").tools as string[]).push("bash"), TypeError);
  assert.throws(() => Object.assign(getProfile("researcher"), { tools: ["write"] }), TypeError);
  assert.throws(() => Object.assign(PROFILES, { worker: {} }), TypeError);
});

test("the strict schema is compatible with the target SDK without importing its runtime", () => {
  const parameters: ToolDefinition<typeof ResearchInputSchema>["parameters"] = ResearchInputSchema;
  assert.equal(parameters, ResearchInputSchema);
  for (const agent of PROFILE_NAMES) {
    const input = { agent, task: "Find the relevant evidence." };
    assert.ok(Value.Check(parameters, input));
    assert.deepEqual(parseResearchInput(input), input);
  }
  assert.match(JSON.stringify(parameters), /actual deadline or budget/);
  assert.match(JSON.stringify(parameters), /completion estimate/);
});

test("bad input, extra fields, unknown agents, and orchestration parameters are rejected", () => {
  const invalid = [
    undefined, null, [], "task", {}, { agent: "scout" }, { task: "question" },
    { agent: "planner", task: "make a plan" }, { agent: "Scout", task: "question" },
    { agent: "toString", task: "question" }, { agent: "../../outside", task: "question" },
    { agent: "scout", task: "" }, { agent: "scout", task: " \n\t\r" },
    { agent: "scout", task: 5 }, { agent: "scout", task: null },
    ...["cwd", "model", "tools", "thinking", "systemPrompt", "chain", "tasks", "agentScope"].map(
      (key) => ({ agent: "scout", task: "question", [key]: "not allowed" }),
    ),
    JSON.parse('{"agent":"scout","task":"question","__proto__":{}}'),
  ];
  for (const input of invalid) {
    assert.equal(Value.Check(ResearchInputSchema, input), false, JSON.stringify(input));
    assert.throws(() => parseResearchInput(input), /Invalid research input/);
  }
});

test("tasks remain literal, including whitespace, option-like text, file references and commands", () => {
  for (const task of ["  preserve this  ", "--model other/provider", "/mcp login ketch", "@secret.txt", "line one\n\nline two", "$(touch should-not-run)"]) {
    assert.equal(parseResearchInput({ agent: "scout", task }).task, task);
  }
});

test("large tasks are accepted without a command-line-sized cap", () => {
  const task = "Investigate this evidence.\n".repeat(10_000);
  assert.equal(parseResearchInput({ agent: "researcher", task }).task, task);
});

test("unknown runtime names cannot select a profile or escape bundled prompt paths", () => {
  for (const name of ["planner", "toString", "__proto__", "../../outside"] as unknown as ProfileName[]) {
    assert.throws(() => getProfile(name), /Unknown research profile/);
    assert.throws(() => loadProfilePrompt(name), /Unknown research profile/);
  }
});

test("profile tools frontmatter supports defaults, inline arrays, comma lists, and explicit empty lists", () => {
  assert.deepEqual(parseProfilePrompt("scout", "---\nmodel: fixture/model\n---\nbody").tools, getProfile("scout").tools);
  assert.deepEqual(parseProfilePrompt("scout", "---\ntools: [read, bash, mcp__ketch__search]\n---\nbody").tools,
    ["read", "bash", "mcp__ketch__search"]);
  assert.deepEqual(parseProfilePrompt("worker", "---\ntools: read, write, edit\n---\nbody").tools,
    ["read", "write", "edit"]);
  assert.deepEqual(parseProfilePrompt("worker", "---\ntools: []\n---\nbody").tools, []);
  for (const [source, expected] of [
    [`---\ntools: ["read", 'bash', "grep"] # trailing comment\n---\nbody`, ["read", "bash", "grep"]],
    [`---\ntools: "read, bash" # scalar comment\n---\nbody`, ["read", "bash"]],
    [`---\ntools: ['mcp__ketch__search', "mcp__ketch__docs"]\n---\nbody`, ["mcp__ketch__search", "mcp__ketch__docs"]],
    [`---\ntools: [read, bash] # '#' inside a comment\n---\nbody`, ["read", "bash"]],
  ] as const) assert.deepEqual(parseProfilePrompt("worker", source).tools, expected);
  for (const source of [
    `---\ntools: [read, mystery]\n---\nbody`,
    `---\ntools: [read, read]\n---\nbody`,
    `---\ntools: [read\n---\nbody`,
    `---\ntools: ["read, bash"]\n---\nbody`,
    `---\ntools: ["read", "bash]\n---\nbody`,
    `---\ntools: [read,]\n---\nbody`,
    `---\ntools:\n---\nbody`,
    `---\ntools: ""\n---\nbody`,
    `---\ntools: [read] trailing\n---\nbody`,
  ]) assert.throws(() => parseProfilePrompt("worker", source), /Invalid worker prompt tools|unsupported tool name/);
  assert.throws(() => parseProfilePrompt("worker", "---\ntools: read\nmodel: fixture/model\ntools: bash\n---\nbody"), /duplicate tools/);
});

test("YAML frontmatter supports multiline tools and rejects unsafe or invalid schema values", () => {
  assert.deepEqual(parseProfilePrompt("researcher", `---
tools:
  [mcp__ketch__search,
   "mcp__ketch__scrape", # keep this formatted
   'mcp__ketch__code',
   mcp__ketch__docs]
---
body`).tools, [
    "mcp__ketch__search", "mcp__ketch__scrape", "mcp__ketch__code", "mcp__ketch__docs",
  ]);
  assert.deepEqual(parseProfilePrompt("worker", `---
tools:
  # comments are allowed in block sequences
  - "read"
  - 'grep' # quoted tool names remain strings
---
body`).tools, ["read", "grep"]);
  assert.equal(parseProfilePrompt("worker", `---
maxTimeout: "30"
---
body`).maxTimeout, 30);

  for (const source of [
    "---\ntools: [read, read]\n---\nbody",
    "---\nunknown: value\n---\nbody",
    "---\n- tools\n---\nbody",
    "---\nmodel: false\n---\nbody",
    "---\nthinking: 1\n---\nbody",
    "---\ntools: [read, false]\n---\nbody",
    "---\ntools: &allowed [read]\n---\nbody",
    "---\ntools: !!str read\n---\nbody",
    "---\nmaxTimeout: 1.5\n---\nbody",
    "---\nmaxTimeout: -1\n---\nbody",
  ]) assert.throws(() => parseProfilePrompt("worker", source), /Invalid worker prompt (?:frontmatter|tools|maxTimeout|model|thinking)/);
  assert.throws(() => parseProfilePrompt("worker", "---\ntools: [read]\nmodel: fixture/model\ntools: [bash]\n---\nbody"), /duplicate tools/);
});

test("model frontmatter accepts scalar and exact provider routing defaults", () => {
  const parsed = parseProfilePrompt("fixture", `---
model:
  byProvider:
    anthropic: anthropic/child
    openai: openai/child-openai
    openai-codex: openai-codex/child-codex
    constructor: custom/constructor-child
  fallback: custom/fallback
---
body`);
  const model = parsed.defaults.model;
  assert.ok(model && typeof model !== "string");
  assert.deepEqual({ ...model.byProvider }, {
    anthropic: "anthropic/child", openai: "openai/child-openai",
    "openai-codex": "openai-codex/child-codex", constructor: "custom/constructor-child",
  });
  assert.equal(model.fallback, "custom/fallback");
  assert.ok(Object.isFrozen(model) && Object.isFrozen(model.byProvider));
  assert.deepEqual(parseProfilePrompt("fixture", "---\nmodel: provider/id\n---\nbody").defaults, { model: "provider/id" });
  for (const source of [
    "---\nmodel:\n  byProvider:\n    anthropic: anthropic/child\n---\nbody",
    "---\nmodel:\n  byProvider: []\n  fallback: parent\n---\nbody",
    "---\nmodel:\n  byProvider:\n    bad/provider: x/y\n  fallback: parent\n---\nbody",
    "---\nmodel:\n  byProvider:\n    anthropic: invalid\n  fallback: parent\n---\nbody",
    "---\nmodel:\n  byProvider: {}\n  fallback: 1\n---\nbody",
    "---\nmodel:\n  byProvider: {}\n  fallback: parent\n  byParent: x/y\n---\nbody",
    "---\nmodel:\n  byProvider:\n    anthropic: anthropic/one\n    anthropic: anthropic/two\n  fallback: parent\n---\nbody",
  ]) assert.throws(() => parseProfilePrompt("fixture", source), /Invalid fixture prompt/);
});

test("agent prompt frontmatter supplies bundled model defaults without leaking into prompt text", () => {
  assert.deepEqual(loadProfileDefaults("scout"), { model: "openai-codex/gpt-5.6-luna", thinking: "high" });
  assert.deepEqual(loadProfileDefaults("researcher"), { model: "openai-codex/gpt-5.6-luna", thinking: "high" });
  assert.deepEqual(loadProfileDefaults("worker"), { model: "openai-codex/gpt-5.6-luna", thinking: "high" });
  assert.doesNotMatch(loadProfilePrompt("researcher"), /gpt-5\.6-luna/);
});

test("prompts load from bundled resources, not cwd or local agent files", () => {
  const dir = mkdtempSync(join(tmpdir(), "research-profile-test-"));
  const previous = process.cwd();
  try {
    mkdirSync(join(dir, "agents"));
    writeFileSync(join(dir, "agents", "scout.md"), "LOCAL_PROMPT_SENTINEL");
    mkdirSync(join(dir, ".pi"));
    writeFileSync(join(dir, ".pi", "SYSTEM.md"), "PROJECT_SYSTEM_SENTINEL");
    process.chdir(dir);
    assert.match(loadProfilePrompt("scout"), /# Scout/);
    assert.ok(!loadProfilePrompt("scout").includes("LOCAL_PROMPT_SENTINEL"));
    assert.ok(!loadProfilePrompt("researcher").includes("PROJECT_SYSTEM_SENTINEL"));
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("research prompts request compact cited findings and explicit uncertainty", () => {
  for (const name of ["scout", "researcher"] as const) {
    const prompt = loadProfilePrompt(name);
    for (const heading of ["Answer", "Evidence", "Caveats", "Next lookup"]) {
      assert.ok(prompt.includes("## " + heading));
    }
    assert.match(prompt, /400–800 words/);
    assert.match(prompt, /untrusted data/);
    assert.match(prompt, /no parent conversation history/);
    assert.match(prompt, /not a sandbox/);
    assert.match(prompt, /do not (edit|implement)/);
    assert.match(prompt, /gaps/);
    assert.match(prompt, /Do not (include|return).*tool transcript/);
    assert.doesNotMatch(prompt, /model:\s|anthropic\/claude|openai-codex\//);
  }
});

test("worker prompt permits targeted implementation and verification", () => {
  const prompt = loadProfilePrompt("worker");
  for (const tool of getProfile("worker").tools) assert.ok(prompt.includes(`\`${tool}\``));
  assert.match(prompt, /Make the smallest targeted changes/);
  assert.match(prompt, /Run the most relevant tests/);
  assert.match(prompt, /not an operating-system sandbox/);
  assert.match(prompt, /Do not delegate/);
});

test("scout guidance requests inspected file/line evidence and static/runtime distinctions", () => {
  const prompt = loadProfilePrompt("scout");
  assert.match(prompt, /path:line/);
  assert.match(prompt, /never invent references/);
  assert.match(prompt, /static inspection from runtime verification/);
  assert.match(prompt, /only tools are.*read.*grep.*find.*ls/);
});

test("researcher guidance covers bounded Ketch lookups, provenance and setup/error policy", () => {
  const prompt = loadProfilePrompt("researcher");
  for (const tool of getProfile("researcher").tools) assert.ok(prompt.includes(tool));
  for (const term of ["configured backend defaults", "max_chars", "6000", "five", "force_browser", "source URLs", "public repo URLs", "precondition", "per-URL", "optional `tag` argument"]) {
    assert.ok(prompt.includes(term), term);
  }
  assert.match(prompt, /not a total research-call or run-time budget/);
  assert.match(prompt, /Do not install software, change configuration, or repair authentication/);
});
