import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createFindToolDefinition, createGrepToolDefinition } from "@earendil-works/pi-coding-agent";
import { createScoutTools, hasScoutBinary, requireScoutBinary } from "../lib/scout.ts";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(join(tmpdir(), "research-scout-bin-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const managed = join(root, "managed"), path = join(root, "path");
  await fs.mkdir(managed); await fs.mkdir(path);
  const executable = async (directory: string, name: string) => {
    const file = join(directory, name + (process.platform === "win32" ? ".exe" : ""));
    // A trap if discovery ever executes a version probe; tests need metadata access only.
    await fs.writeFile(file, `#!/bin/sh\nprintf bad > ${JSON.stringify(join(root, "probe-ran"))}\n`, { mode: 0o700 });
    return file;
  };
  return { root, managed, path, executable };
}

test("Scout binary discovery reads managed/PATH metadata and fd aliases without running a probe", async (t) => {
  const f = await fixture(t);
  assert.equal(hasScoutBinary("rg", f.managed, f.path), false);
  assert.equal(hasScoutBinary("fd", f.managed, f.path), false);
  await f.executable(f.managed, "rg"); await f.executable(f.path, "fdfind");
  assert.equal(hasScoutBinary("rg", f.managed, f.path), true);
  assert.equal(hasScoutBinary("fd", f.managed, f.path), true);
  await assert.rejects(fs.access(join(f.root, "probe-ran")), { code: "ENOENT" });
});

test("Scout rejects a broken preferred managed binary instead of pretending a PATH entry will repair it", async (t) => {
  const f = await fixture(t);
  const managed = await f.executable(f.managed, "rg");
  await f.executable(f.path, "rg");
  if (process.platform !== "win32") {
    await fs.chmod(managed, 0o600);
    assert.equal(hasScoutBinary("rg", f.managed, f.path), false);
  }
  await fs.rm(managed); await fs.mkdir(managed);
  assert.equal(hasScoutBinary("rg", f.managed, f.path), false);
});

test("Scout prerequisites report operator setup, not an automatic download", () => {
  assert.throws(() => requireScoutBinary("rg", () => false), /already-installed ripgrep/);
  assert.throws(() => requireScoutBinary("fd", () => false), /automatic downloads are disabled/);
  assert.doesNotThrow(() => requireScoutBinary("fd", () => true));
});

test("Scout wrappers preserve native schemas/descriptions/renderers but gate backend entry", () => {
  const cwd = tmpdir();
  const guarded = createScoutTools(cwd, () => false);
  const native = [createGrepToolDefinition(cwd), createFindToolDefinition(cwd)];
  for (const [index, tool] of guarded.entries()) {
    assert.equal(tool.name, native[index]!.name);
    assert.equal(tool.parameters, native[index]!.parameters);
    assert.equal(tool.description, native[index]!.description);
    assert.equal(tool.renderCall, native[index]!.renderCall);
    assert.equal(tool.renderResult, native[index]!.renderResult);
    assert.throws(() => tool.execute("fixture", { pattern: "needle" }, undefined, undefined, undefined!), /automatic downloads are disabled/);
  }
});
