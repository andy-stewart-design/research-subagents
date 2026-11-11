# Pi research-subagents

A Pi extension that delegates work to fresh, isolated child sessions. Define your own subagents by adding Markdown files in `agents/`. Each child gets only its profile's tools and the supplied task—not the parent transcript.

Three profiles are included to get started:

| Profile    | Use                             |
| ---------- | ------------------------------- |
| Scout      | Local read/search               |
| Researcher | External research through Ketch |
| Worker     | File edits and shell commands   |

## Requirements

- Node.js **22.19+** and Pi **1.1.0**.
- Credentials for the provider/model you select in Pi. Model IDs and authentication depend on your setup.
- [Ketch](https://github.com/1broseidon/ketch) **0.18.1** (or a compatible `ketch mcp serve`) when using Ketch tools.
- `rg` and `fd` (or `fdfind`) only when a selected profile uses the `grep` or `find` tools. Scout's bundled profile uses them.
- `pnpm` for installing from source.

## Installation

Recommended source install:

```sh
git clone https://github.com/andy-stewart-design/research-subagents.git
cd research-subagents
pnpm install --frozen-lockfile
pi install "$PWD"
```

For the current project instead of personal Pi settings, use `pi install --local "$PWD"`. Reload Pi with `/reload` (or start a new session).

## Configure subagents

Profiles are Markdown files in `agents/*.md`. For example, add `agents/reviewer.md`, then run `/reload`:

```markdown
---
description: Review local changes without editing files.
model: example-provider/example-model
thinking: high
tools: [read, grep, find]
maxTimeout: 900
---

# Reviewer

Inspect the requested changes and report exact files, lines, risks, and gaps.
```

The model value above is illustrative. `model` uses `provider/model`; `thinking` sets the default level; `tools` is the exact allowlist; and `maxTimeout` is a per-profile ceiling in **seconds** (`0` means unlimited). Supported tools are `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, and `mcp__ketch__search`, `mcp__ketch__scrape`, `mcp__ketch__code`, `mcp__ketch__docs`. New profiles should declare `tools` explicitly.

To route a profile based on the parent's provider, use a frontmatter model mapping:

```yaml
model:
  byProvider:
    anthropic: anthropic/example-model
    openai-codex: openai-codex/example-model
  fallback: parent
```

Provider keys are exact. `fallback` is required; `parent` inherits the parent's model. The targets are examples, not availability guarantees.

Optional global settings live at `~/.pi/agent/research-subagents.json` (or under `$PI_CODING_AGENT_DIR` if set):

```json
{
  "maxConcurrency": 2,
  "timeoutMs": 120000,
  "profiles": {
    "worker": { "thinking": "high" }
  }
}
```

`maxConcurrency` defaults to `2`. `timeoutMs` is the global default in milliseconds; omitted or `0` means unlimited. A declared `maxTimeout` replaces that default for its profile, including when it is `0`. Optional `profiles.<name>.model` (`provider/model`) and `thinking` values override frontmatter. Per-call `timeout_ms` is also milliseconds; omit it or use `0` to inherit the configured policy.
