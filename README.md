# Pi research-subagents

A local Pi extension package for two read-only research profiles:

- **Scout** — isolated local code investigation using Pi's `read`, `grep`, `find`, and `ls` policy.
- **Researcher** — isolated external investigation using Ketch's `search`, `scrape`, `code`, and `docs` tools.

The package contains two independently loadable extensions:

- `extensions/ketch.ts` exposes parent Ketch retrieval through Pi's native MCP/codemode integration.
- `extensions/research.ts` exposes `research({ agent, task })` delegation.

Loading the package normally enables both. Loading either path explicitly enables only that capability.

## Requirements

- Node.js **22.19 or newer**
- Pi **1.1.0**
- Ketch **0.18.1** or a compatible `ketch mcp serve` executable for researcher runs
- Pi's native `builtin:mcp` and `builtin:codemode` extensions for direct parent Ketch use
- Preinstalled `rg` and `fd` (or `fdfind`) for Scout; research never downloads them automatically

Model availability, provider credentials, Ketch authentication, and browser/backend setup are operator responsibilities. Refresh or sign in through the parent Pi session when needed. Child sessions use read-only inherited/configured authentication data; they do not copy the parent transcript or ephemeral provider state and do not repair credentials.

## Manual installation

For a persistent personal installation from source, clone the repository and install its local dependencies first. Pi does not install or modify dependencies for local package paths:

```sh
git clone https://github.com/andy-stewart-design/research-subagents.git
cd /absolute/path/to/research-subagents
pnpm install --frozen-lockfile
pi install "$PWD"
pi list
```

The default install is personal and is recorded in `~/.pi/agent/settings.json`. To install only for the current project instead, use:

```sh
pi install --local "$PWD"
```

Before you get started, make sure you have [Ketch](https://github.com/1broseidon/ketch) installed. Then, begin a new Pi session after installation. Verify the separate prerequisites before using the profiles:

```sh
ketch --version
rg --version
fd --version    # or fdfind --version
```

To update a cloned installation:

```sh
cd /absolute/path/to/research-subagents
git pull
pnpm install --frozen-lockfile
```

Then `/reload` your session or start a new one. To remove it from Pi settings without deleting the clone:

```sh
pi remove "$PWD"
```

For a one-session test without changing settings, use the explicit loading commands below.

## Session Loading

From this directory, a normal package/resource load enables both manifest entries. For explicit local loading without changing Pi configuration:

```sh
pi --no-extensions \
  --extension builtin:mcp \
  --extension builtin:codemode \
  --extension "$PWD/extensions/ketch.ts" \
  --extension "$PWD/extensions/research.ts"
```

Independent loading is also supported:

```sh
# Direct parent Ketch only
pi --no-extensions --extension builtin:mcp --extension builtin:codemode \
  --extension "$PWD/extensions/ketch.ts"

# Research delegation only; Scout needs no parent Ketch connection
pi --no-extensions --extension "$PWD/extensions/research.ts"
```

The research extension does not register a parent Ketch server. A researcher creates and verifies its own isolated Ketch connection; it therefore still requires the Ketch executable and backend setup. Loading the Ketch extension is not required for Scout or for the isolated child connection.

## Direct Ketch and delegation

With `extensions/ketch.ts` plus Pi's native MCP/codemode extensions, the parent can call the four exposed Ketch capabilities directly. The extension registers the default `ketch mcp serve` entry only when another extension has not registered `ketch`; native file configuration retains Pi's precedence. Other Ketch tools remain hidden.

With `extensions/research.ts`, call:

```json
{
  "agent": "scout",
  "task": "Find the authentication flow and cite the relevant files and lines."
}
```

or:

```json
{
  "agent": "researcher",
  "task": "Compare the official API documentation with the current implementation and cite sources and gaps."
}
```

The input has exactly two fields: `agent` (`scout` or `researcher`) and a non-whitespace `task`. Task text remains literal; it is not treated as a command, file reference, prompt template, or parent transcript. The public boundary fails closed for obvious profile mismatches: local paths cannot be sent to Researcher, external URLs cannot be sent to Scout, and a Researcher child that produces no Ketch lookup is not accepted as a sourced report.

For researcher dispatches, an effective global or trusted project Ketch file entry wins over extension registrations, matching native Pi precedence. If that winning backend changes the command, arguments, environment, working directory, URL, or transport from plain `ketch mcp serve`, research fails with an actionable diagnostic. Scout is not blocked by Ketch configuration conflicts. If no parent Ketch entry exists, the researcher still proceeds with its independent child-owned configuration.

## Configuration

Research configuration is optional and read from:

```text
$PI_CODING_AGENT_DIR/research-subagents.json
```

Example:

```json
{
  "maxConcurrency": 2,
  "timeoutMs": 120000,
  "profiles": {
    "researcher": {
      "model": "anthropic/claude-sonnet-4-5",
      "thinking": "high"
    },
    "scout": {
      "thinking": "medium"
    }
  }
}
```

Defaults are concurrency **2** and **no research deadline**. A configured `timeoutMs` starts only after queued work receives a slot. Cancellation or timeout interrupts the child, waits for owned cleanup, and returns a truthful bounded error; the first interruption cause wins. This is separate from native MCP request/startup timeouts.

Agent files may also carry bundled frontmatter defaults. The bundled Scout and Researcher default to `openai-codex/gpt-5.6-luna` with `high` thinking; an explicit `research-subagents.json` profile override wins, followed by parent provider/model and thinking inheritance. Overrides must use `provider/model` and a supported thinking level. Unavailable or unauthenticated models fail without fallback.

## Safety and reports

Child sessions are fresh and isolated. They do not load ordinary extensions, skills, prompt templates, context files, parent history, or unrelated MCP servers. Scout has local read/search tools only; Researcher has the four direct Ketch tools only. This is a tool policy, not an operating-system sandbox: normal Pi/Ketch caches and configured credential behavior remain possible, but the feature does not edit source code or install tools.

Only the final assistant report is returned to the parent. Handoffs are capped at 12 KiB. Oversized reports retain a clipped excerpt and a private `report.md` under the OS temporary directory, outside the repository/workspace. The path is included in the result. If report preservation fails, the result reports that failure and does not claim a saved report.

The compact TUI rendering shows profile, bounded task preview, queue/running/completed state, elapsed time, tool activity, and latest tool. Expanded output shows the bounded report and retained path without exposing the child transcript or reasoning. Noninteractive callers receive the same bounded result contract.

## Recovery and removal

The package is installed into personal Pi settings only when explicitly requested with `pi install`; explicit `--extension` paths remain available for temporary testing. To stop using an installed copy, run `pi remove /absolute/path/to/research-subagents` (or use Pi's package controls). No research configuration or Ketch file needs to be rewritten. Correct missing model credentials, Ketch setup, or Scout binaries outside the research tool and retry.

Run the deterministic checks from the repository root with:

```sh
pnpm run check
```

Live model/web quality and human TUI acceptance require operator credentials, an approved disposable environment, and manual observation; the automated checks do not claim those results.
