import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const root = fileURLToPath(new URL("../..", import.meta.url));
const ketch = fileURLToPath(new URL("../../extensions/ketch.ts", import.meta.url));
const research = fileURLToPath(new URL("../../extensions/research.ts", import.meta.url));
const execFile = promisify(execFileCallback);

interface PiRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runPi(project: string, agentDir: string, probeFile: string, args: readonly string[]): Promise<PiRun> {
  return new Promise((resolve, reject) => {
    const child = spawn("pi", args, {
      cwd: project,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PROBE_FILE: probeFile },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    // RPC creates the runtime and emits session_start without making a model request.
    child.stdin.end('{"id":"state","type":"get_state"}\n');
  });
}

let piAvailable = true;
try { await execFile("pi", ["--version"]); }
catch { piAvailable = false; }

test("Pi/Jiti loads and registers each declared extension path independently and in either order", { skip: !piAvailable && "pi CLI is not installed" }, async () => {
  const disposable = await mkdtemp(join(tmpdir(), "research-loading-"));
  const agentDir = join(disposable, "agent");
  const project = join(disposable, "project");
  const probeFile = join(disposable, "probe.json");
  const probe = join(disposable, "probe.ts");
  await mkdir(project, { recursive: true });
  await writeFile(probe, `import { writeFileSync } from "node:fs";
export default (pi) => {
  pi.on("session_start", () => writeFileSync(process.env.PROBE_FILE, JSON.stringify({
    servers: pi.getMcpServers().map((server) => server.name),
    tools: pi.getAllTools().map((tool) => tool.name),
  })));
};
`);
  try {
    const cases = [
      ["ketch-only", ["--mode", "rpc", "--no-session", "--no-extensions", "--extension", "builtin:mcp", "--extension", "builtin:codemode", "--extension", ketch, "--extension", probe], ["ketch"], false],
      ["research-only", ["--mode", "rpc", "--no-session", "--no-extensions", "--extension", research, "--extension", probe], [], true],
      ["both", ["--mode", "rpc", "--no-session", "--no-extensions", "--extension", "builtin:mcp", "--extension", "builtin:codemode", "--extension", ketch, "--extension", research, "--extension", probe], ["ketch"], true],
      ["both-reversed", ["--mode", "rpc", "--no-session", "--no-extensions", "--extension", "builtin:mcp", "--extension", "builtin:codemode", "--extension", research, "--extension", ketch, "--extension", probe], ["ketch"], true],
    ] as const;
    for (const [name, args, expectedServers, expectsResearch] of cases) {
      await rm(probeFile, { force: true });
      const result = await runPi(project, agentDir, probeFile, args);
      assert.equal(result.code, 0, `${name}: ${result.stderr}`);
      assert.equal(result.stderr, "", name);
      const response = JSON.parse(result.stdout.split("\n")[0]!);
      assert.equal(response.success, true, name);
      const registration = JSON.parse(await readFile(probeFile, "utf8")) as { servers: string[]; tools: string[] };
      assert.deepEqual(registration.servers.filter((server) => server === "ketch"), expectedServers, name);
      assert.equal(registration.tools.filter((tool) => tool === "research").length, expectsResearch ? 1 : 0, name);
    }
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    assert.deepEqual(manifest.pi.extensions, ["./extensions/ketch.ts", "./extensions/research.ts"]);
    assert.equal(await stat(project).then(() => true), true);
    await assert.rejects(access(join(root, "index.ts")));
  } finally {
    await rm(disposable, { recursive: true, force: true });
  }
});
