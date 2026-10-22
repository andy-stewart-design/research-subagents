import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  CONFIG_FILENAME,
  THINKING_LEVELS,
  loadConfig,
  parseConfig,
  selectModel,
} from "../lib/config.ts";
import type { ProfileName } from "../lib/profiles.ts";

function fixture(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "research-config-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("defaults have concurrency two and no research timeout or other budget", () => {
  const config = parseConfig({});
  assert.deepEqual(config, { maxConcurrency: 2, profiles: {} });
  assert.equal(Object.hasOwn(config, "timeoutMs"), false);
});

test("explicit concurrency, timeout, and per-profile overrides are preserved", () => {
  const input = {
    maxConcurrency: 3,
    timeoutMs: 250.5,
    profiles: {
      scout: { model: "provider/model", thinking: "off" },
      researcher: { thinking: "high" },
      worker: { model: "provider/worker", thinking: "medium" },
    },
  };
  assert.deepEqual(parseConfig(input), input);
});

test("all target SDK thinking levels are accepted", () => {
  assert.deepEqual(THINKING_LEVELS, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  for (const thinking of THINKING_LEVELS) {
    assert.equal(parseConfig({ profiles: { scout: { thinking } } }).profiles.scout?.thinking, thinking);
  }
});

test("invalid configuration shapes and unknown fields fail instead of being ignored", () => {
  const invalid = [
    null, [], false, 4, "config",
    { maxConcurrency: 0 }, { maxConcurrency: -1 }, { maxConcurrency: 1.5 },
    { maxConcurrency: "2" }, { maxConcurrency: Infinity }, { maxConcurrency: Number.MAX_SAFE_INTEGER + 1 },
    { timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: "100" },
    { timeoutMs: NaN }, { timeoutMs: Infinity }, { timeoutMs: null },
    { profiles: [] }, { profiles: null }, { profiles: { planner: {} } },
    { profiles: { scout: null } }, { profiles: { scout: { thinking: "ultra" } } },
    { profiles: { scout: { tools: ["bash"] } } },
    { profiles: { researcher: { systemPrompt: "replace" } } },
    { profiles: { worker: { tools: ["bash"] } } },
    { model: "provider/global" }, { cwd: "/elsewhere" }, { maxTurns: 5 },
    { maxToolCalls: 5 }, { tokenBudget: 1000 },
    JSON.parse('{"profiles":{"__proto__":{"model":"other/model"}}}'),
  ];
  for (const input of invalid) {
    assert.throws(() => parseConfig(input), /Invalid research configuration/, JSON.stringify(input));
  }
});

test("model overrides require provider/id without whitespace", () => {
  for (const model of ["", "model", "/model", "provider/", " provider/id", "provider/id ", "provider/id\n", "provider/i d", "pro vider/id"]) {
    assert.throws(() => parseConfig({ profiles: { scout: { model } } }), /\/profiles\/scout\/model/);
  }
});

test("configuration is detached from caller data and immutable", () => {
  const input = { profiles: { scout: { model: "provider/id" } } };
  const config = parseConfig(input);
  input.profiles.scout.model = "other/changed";
  assert.equal(config.profiles.scout?.model, "provider/id");
  assert.ok(Object.isFrozen(config) && Object.isFrozen(config.profiles) && Object.isFrozen(config.profiles.scout));
  assert.throws(() => Object.assign(config, { timeoutMs: 1 }), TypeError);
});

test("missing configuration neither writes a default nor creates the agent directory", (t) => {
  const dir = fixture(t);
  const absent = join(dir, "missing-agent");
  assert.deepEqual(loadConfig(absent), parseConfig({}));
  assert.equal(existsSync(absent), false);
  assert.deepEqual(readdirSync(dir), []);
});

test("loading reads only the named file and does not rewrite user settings", (t) => {
  const dir = fixture(t);
  const path = join(dir, CONFIG_FILENAME);
  const content = '{\n  "maxConcurrency": 4, "profiles": {"scout": {"thinking": "low"}}\n}\n';
  writeFileSync(path, content);
  writeFileSync(join(dir, "settings.json"), '{"packages":["do-not-load"]}\n');
  const before = { files: readdirSync(dir), mtime: statSync(path).mtimeMs };
  assert.equal(loadConfig(dir).maxConcurrency, 4);
  assert.equal(loadConfig(dir).profiles.scout?.thinking, "low");
  assert.equal(readFileSync(path, "utf8"), content);
  assert.equal(statSync(path).mtimeMs, before.mtime);
  assert.deepEqual(readdirSync(dir), before.files);
  assert.equal(readFileSync(join(dir, "settings.json"), "utf8"), '{"packages":["do-not-load"]}\n');
});

test("invalid JSON fails with its path, without echoing content or repairing the file", (t) => {
  const dir = fixture(t);
  const path = join(dir, CONFIG_FILENAME);
  const content = '{"unexpected-secret":"SENSITIVE_SENTINEL",';
  writeFileSync(path, content);
  assert.throws(() => loadConfig(dir), (error: Error) => {
    assert.match(error.message, /Invalid JSON/);
    assert.ok(error.message.includes(path));
    assert.ok(!error.message.includes("SENSITIVE_SENTINEL"));
    return true;
  });
  assert.equal(readFileSync(path, "utf8"), content);
});

test("schema-invalid files fail with path/field diagnostics and remain unchanged", (t) => {
  const dir = fixture(t);
  const path = join(dir, CONFIG_FILENAME);
  const content = '{"profiles":{"scout":{"thinking":"unsupported"}}}';
  writeFileSync(path, content);
  assert.throws(() => loadConfig(dir), (error: Error) => {
    assert.ok(error.message.includes(path));
    assert.match(error.message, /\/profiles\/scout\/thinking/);
    return true;
  });
  assert.equal(readFileSync(path, "utf8"), content);
});

test("read errors are not mistaken for absent configuration", (t) => {
  const dir = fixture(t);
  const path = join(dir, CONFIG_FILENAME);
  mkdirSync(path);
  assert.throws(() => loadConfig(dir), (error: Error) => {
    assert.ok(error.message.includes(path));
    assert.match(error.message, /Unable to read/);
    assert.ok(error.cause instanceof Error);
    return true;
  });
});

test("relative agent directories cannot accidentally read repository configuration", () => {
  assert.throws(() => loadConfig("."), /absolute agent directory/);
  assert.throws(() => loadConfig(""), /absolute agent directory/);
});

const parent = Object.freeze({
  model: Object.freeze({ provider: "openai-codex", id: "parent-model" }),
  thinkingLevel: "high" as const,
});

test("profile-file model defaults are used and explicit config overrides them", () => {
  const parent = { model: { provider: "parent", id: "model" }, thinkingLevel: "high" as const };
  assert.deepEqual(selectModel("researcher", parseConfig({}), parent, { model: "openai-codex/gpt-5.6-luna", thinking: "low" }), {
    provider: "openai-codex", modelId: "gpt-5.6-luna", thinkingLevel: "low",
  });
  assert.deepEqual(selectModel("researcher", parseConfig({ profiles: { researcher: { model: "override/model", thinking: "off" } } }), parent, {
    model: "openai-codex/gpt-5.6-luna", thinking: "low",
  }), { provider: "override", modelId: "model", thinkingLevel: "off" });
});

test("model selection inherits exact parent provider, ID, and thinking without mutation", () => {
  const config = parseConfig({});
  const snapshot = JSON.stringify({ config, parent });
  for (const name of ["scout", "researcher", "worker"] as const) {
    assert.deepEqual(selectModel(name, config, parent), {
      provider: "openai-codex", modelId: "parent-model", thinkingLevel: "high",
    });
  }
  assert.equal(JSON.stringify({ config, parent }), snapshot);
});

test("profile overrides are independent, preserve ID slashes, and inherit thinking", () => {
  const config = parseConfig({ profiles: { researcher: { model: "openrouter/anthropic/claude-example" } } });
  assert.deepEqual(selectModel("researcher", config, parent), {
    provider: "openrouter", modelId: "anthropic/claude-example", thinkingLevel: "high",
  });
  assert.equal(selectModel("scout", config, parent).modelId, "parent-model");
});

test("thinking-only and explicit off overrides take precedence", () => {
  const config = parseConfig({ profiles: { scout: { thinking: "off" }, researcher: { thinking: "low" } } });
  assert.equal(selectModel("scout", config, parent).thinkingLevel, "off");
  assert.equal(selectModel("researcher", config, parent).thinkingLevel, "low");
});

test("a model override can work without a parent; unspecified thinking remains unspecified", () => {
  const config = parseConfig({ profiles: { scout: { model: "provider/id" } } });
  assert.deepEqual(selectModel("scout", config, {}), { provider: "provider", modelId: "id" });
  assert.equal(Object.hasOwn(selectModel("scout", config, {}), "thinkingLevel"), false);
});

test("missing/invalid parent models never select a fallback", () => {
  const config = parseConfig({});
  for (const model of [undefined, { provider: "", id: "id" }, { provider: "provider", id: "" }, { provider: "pro vider", id: "id" }, { provider: "bad/provider", id: "id" }]) {
    const defaults = model === undefined ? {} : { model };
    assert.throws(() => selectModel("scout", config, defaults), /No valid model selected for scout/, JSON.stringify(defaults));
  }
  assert.throws(() => selectModel("scout", parseConfig({ profiles: { scout: { thinking: "low" } } }), {}), /select a parent model/);
});

test("model selection validates runtime profile names and malformed direct override data", () => {
  const config = parseConfig({});
  assert.throws(() => selectModel("planner" as unknown as ProfileName, config, parent), /Unknown research profile/);
  assert.throws(() => selectModel("scout", { maxConcurrency: 2, profiles: { scout: { model: "unqualified" } } }, parent), /No valid model selected/);
  assert.deepEqual(selectModel("scout", config, { model: { provider: "custom-provider", id: "models/test" } }), {
    provider: "custom-provider", modelId: "models/test",
  });
});
