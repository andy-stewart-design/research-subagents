import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../..", import.meta.url));
const ketch = fileURLToPath(new URL("../../extensions/ketch.ts", import.meta.url));
const research = fileURLToPath(new URL("../../extensions/research.ts", import.meta.url));

async function runPi(agentDir: string, args: readonly string[]) {
  return execFileAsync("pi", args, {
    cwd: root,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    maxBuffer: 256 * 1024,
  });
}

let piAvailable = true;
try { await execFileAsync("pi", ["--version"]); }
catch { piAvailable = false; }

test("Pi/Jiti loads each declared extension path independently and in either order", { skip: !piAvailable && "pi CLI is not installed" }, async () => {
  const disposable = await mkdtemp(join(tmpdir(), "research-loading-"));
  const agentDir = join(disposable, "agent");
  const project = join(disposable, "project");
  await mkdir(project, { recursive: true });
  try {
    const cases = [
      ["ketch-only", ["--no-extensions", "--extension", "builtin:mcp", "--extension", "builtin:codemode", "--extension", ketch, "--help"]],
      ["research-only", ["--no-extensions", "--extension", research, "--help"]],
      ["both", ["--no-extensions", "--extension", "builtin:mcp", "--extension", "builtin:codemode", "--extension", ketch, "--extension", research, "--help"]],
      ["both-reversed", ["--no-extensions", "--extension", "builtin:mcp", "--extension", "builtin:codemode", "--extension", research, "--extension", ketch, "--help"]],
    ] as const;
    for (const [name, args] of cases) {
      const result = await runPi(agentDir, args);
      assert.match(result.stdout, /pi - AI coding assistant/ , name);
      assert.equal(result.stderr, "", name);
    }
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    assert.deepEqual(manifest.pi.extensions, ["./extensions/ketch.ts", "./extensions/research.ts"]);
    assert.equal(await stat(project).then(() => true), true);
    await assert.rejects(access(join(root, "index.ts")));
  } finally {
    await rm(disposable, { recursive: true, force: true });
  }
});
