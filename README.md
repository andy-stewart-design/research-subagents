# Pi research-subagents

A local Pi extension package for isolated child profiles. The bundled profiles are:

- **Scout** — read-only local code investigation using Pi's `read`, `grep`, `find`, and `ls` policy.
- **Researcher** — read-only external investigation using Ketch's `search`, `scrape`, `code`, and `docs` tools.
- **Worker** — repository implementation using Pi's `read`, `write`, `edit`, and `bash` tools.

Agent types are discovered from the bundled `agents/*.md` files. Add a safe lowercase filename (letters/digits separated by `-` or `_`) to register a profile without changing TypeScript; `README.md`, dotfiles, and non-markdown files are ignored. Existing bundled profiles retain their historical omitted-tools defaults; a new profile must declare `tools` explicitly (omitting it gives the new profile no tools). Discovery is deterministic and is refreshed when the extension is reloaded.

The package contains two independently loadable extensions:

- `extensions/ketch.ts` exposes parent Ketch retrieval through Pi's native MCP/codemode integration.
- `extensions/research.ts` exposes `subagent({ agent, task })` delegation.

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

With `extensions/research.ts`, call `subagent`: 

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

or:

```json
{
  "agent": "worker",
  "task": "Implement the requested change, run the relevant tests, and report the files changed."
}
```

The input has `agent` (one of the discovered profile filenames), a non-whitespace `task`, and optional `timeout_ms` (a nonnegative integer in milliseconds). Task text remains literal; it is not treated as a command, file reference, prompt template, or parent transcript. A call timeout may only shorten the effective finite ceiling; `timeout_ms: 0` is unlimited only when that ceiling is unlimited. The public boundary fails closed for obvious mismatches with the selected profile capabilities: local paths require a selected local-capable tool, external URLs require `bash` or Ketch, and the bundled Scout/Researcher defaults retain their local-only/external-only checks. A Researcher child that produces no Ketch lookup is not accepted as a sourced report. Worker tasks are allowed to modify the current repository.

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
    },
    "worker": {
      "thinking": "high"
    }
  }
}
```

Defaults are concurrency **2** and **no research deadline**. `timeoutMs` is absent/`0` for unlimited or a positive integer in milliseconds, and starts only after queued work receives a slot. Agent frontmatter may add `maxTimeout` as nonnegative integer seconds; `0` explicitly overrides a finite global ceiling. A call may add `timeout_ms` subject to that effective ceiling. Invalid, fractional, negative, or exceeding values fail before launch. This is separate from native MCP request/startup timeouts.

When a deadline expires, the result is irreversibly `timed_out`/incomplete and is returned as an error. The child gets a fixed 30-second grace window: interruption is requested immediately, the original operation must settle before one tool-free same-session handoff is attempted, all callable tools are disabled first, and the handoff is forcibly persisted (including short summaries) before disposal. A stalled abort, startup, summary, persistence, or grace expiry returns a diagnostic naming the last active tool and uncertainty about late work. Explicit parent cancellation skips this handoff and interrupts promptly. Callers should allow at least the work deadline plus 30 seconds of grace and bounded cleanup before applying an outer request timeout. Cleanup is bounded; Pi SDK disposal is not treated as proof that arbitrary in-process tools stopped, although owned Ketch process termination is retained as a fallback.

Agent files carry the profile source of truth in ordinary YAML markdown frontmatter. `model` and `thinking` set string defaults; `description` documents the public enum; `tools` is an optional exact allowlist; `maxTimeout` is an optional nonnegative integer timeout ceiling in seconds (zero means unlimited). Existing bundled profiles retain their historical omitted-tools defaults, while a new profile without `tools` receives no tools. `tools: []` also intentionally exposes no tools. YAML flow arrays may be inline or wrapped across lines, and block sequences are supported, for example `tools: [read, grep, bash]`, a multiline flow array, or:

```yaml
tools:
  - read
  - grep
  - bash
```

The legacy comma-separated scalar form (`tools: read, grep, bash`) remains supported. Supported names are the native `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls`, plus `mcp__ketch__search`, `mcp__ketch__scrape`, `mcp__ketch__code`, and `mcp__ketch__docs`; unknown names, duplicates, malformed lists, and unsupported values fail before the child task starts.

For example, create `agents/reviewer.md`:

```markdown
---
model: anthropic/claude-sonnet-4-5
thinking: high
tools: [read, grep, find]
description: Review local changes and report risks without editing files.
---

# Reviewer

Inspect the requested changes, cite exact files and lines, and report risks and gaps.
```

Reload Pi after adding or removing an agent (`/reload` or a new session). The reload is the discovery snapshot boundary; a running extension keeps its existing registry. Ketch is loaded only when at least one Ketch tool is selected, and only the selected Ketch subset is exposed. `grep` and `find` use safe wrappers and require already-installed `rg`/`fd` only when selected.

The bundled Scout, Researcher, and Worker default to `openai-codex/gpt-5.6-luna` with `high` thinking; an explicit `research-subagents.json` profile override wins, followed by parent provider/model and thinking inheritance. Overrides must use `provider/model` and a supported thinking level. Unavailable or unauthenticated models fail without fallback.

## Safety and reports

Child sessions are fresh and isolated. They do not load ordinary extensions, skills, prompt templates, context files, parent history, or unrelated MCP servers. Each profile receives exactly its markdown allowlist; the bundled defaults are Scout local read/search, Researcher’s four direct Ketch tools, and Worker read/write/edit plus shell. This is a tool policy, not an operating-system sandbox: any selected `bash` or edit capability can modify files or execute commands, and normal Pi/Ketch caches and configured credential behavior remain possible.

Only the final assistant report is returned to the parent. Handoffs are capped at 12 KiB. Oversized reports retain a clipped excerpt and a private `report.md` under the OS temporary directory, outside the repository/workspace. The path is included in the result. If report preservation fails, the result reports that failure and does not claim a saved report. Child activity and final reachability checks use the exact markdown allowlist; parent tools, extensions, codemode, and MCP configuration are not inherited.

The compact TUI rendering shows profile, bounded task preview, queue/running/completed state, elapsed time, tool activity, and latest tool. Expand a live subagent result to inspect its retained ordered tool history: each entry shows a safe argument summary and a timestamp relative to child start (not tool duration). Only the latest 50 calls are retained; older calls are represented by an omitted count. Expanded output also shows the bounded report and retained path without exposing the child transcript or reasoning. Noninteractive callers receive the same bounded result contract. Timeout summaries use the child-owned SDK runtime with a provider request cap of at most 1024 output tokens (and no reasoning setting where the SDK supports that default); the 12 KiB handoff limit remains a separate byte limit.

## Recovery and removal

The package is installed into personal Pi settings only when explicitly requested with `pi install`; explicit `--extension` paths remain available for temporary testing. To stop using an installed copy, run `pi remove /absolute/path/to/research-subagents` (or use Pi's package controls). No research configuration or Ketch file needs to be rewritten. Correct missing model credentials, Ketch setup, or Scout binaries outside the research tool and retry.

Run the deterministic checks from the repository root with:

```sh
pnpm run check
```

Live model/web quality and human TUI acceptance require operator credentials, an approved disposable environment, and manual observation; the automated checks do not claim those results.
