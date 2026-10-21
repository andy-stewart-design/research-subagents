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
  loadProfileDefaults, loadProfilePrompt,
  parseResearchInput,
  type ProfileName,
} from "../lib/profiles.ts";

test("exactly two bundled profiles have the fixed read-only tool policy", () => {
  assert.deepEqual(PROFILE_NAMES, ["scout", "researcher"]);
  assert.deepEqual(Object.keys(PROFILES), [...PROFILE_NAMES]);
  assert.deepEqual(getProfile("scout").tools, ["read", "grep", "find", "ls"]);
  assert.deepEqual(getProfile("researcher").tools, [
    "mcp__ketch__search", "mcp__ketch__scrape", "mcp__ketch__code", "mcp__ketch__docs",
  ]);
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
});

test("bad input, extra fields, workers, and orchestration parameters are rejected", () => {
  const invalid = [
    undefined, null, [], "task", {}, { agent: "scout" }, { task: "question" },
    { agent: "worker", task: "change code" }, { agent: "Scout", task: "question" },
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
  for (const name of ["worker", "toString", "__proto__", "../../outside"] as unknown as ProfileName[]) {
    assert.throws(() => getProfile(name), /Unknown research profile/);
    assert.throws(() => loadProfilePrompt(name), /Unknown research profile/);
  }
});

test("agent prompt frontmatter supplies bundled model defaults without leaking into prompt text", () => {
  assert.deepEqual(loadProfileDefaults("scout"), { model: "openai-codex/gpt-5.6-luna", thinking: "high" });
  assert.deepEqual(loadProfileDefaults("researcher"), { model: "openai-codex/gpt-5.6-luna", thinking: "high" });
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

test("both prompts request compact cited findings and explicit uncertainty, not implementation", () => {
  for (const name of PROFILE_NAMES) {
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
