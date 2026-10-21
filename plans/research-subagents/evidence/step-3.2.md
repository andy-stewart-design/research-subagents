# Step 3.2 — Local setup and actual loading

## Result

**Blocked for full completion, with documentation and deterministic loading verified.** The required live model/web/backend and human TUI checks were not performed: they require explicit approval, operator credentials, a configured Ketch installation/backend, and human interaction. No permanent installation or personal Pi configuration change was made.

## Documentation

- Added `README.md` covering Pi 1.1.0 / Ketch 0.18.1 prerequisites, Node version, direct Ketch versus delegated research, independent extension entry points, profile input, model inheritance/overrides, configuration, timeout semantics, report retention, tool-policy limitations, Scout prerequisites, recovery/removal, and live-check limitations.
- Documented explicit paths:
  - `extensions/ketch.ts` for parent Ketch only.
  - `extensions/research.ts` for delegation only.
  - Both paths for the normal combined capability.
- Documented that parent Ketch requires Pi's native `builtin:mcp` and `builtin:codemode`, while research-only Scout does not require a parent Ketch connection.

## Actual Pi/Jiti loading

`test/integration/loading.test.ts` runs the installed Pi CLI (`pi --version` reported 1.1.0) in disposable directories with `PI_CODING_AGENT_DIR` redirected to a temporary agent directory. It loads with `--no-extensions` and explicit paths in four compositions:

1. Ketch only, with native MCP/codemode built-ins.
2. Research only.
3. Both, Ketch then research.
4. Both, research then Ketch.

Each invocation uses Pi RPC mode with a `get_state` request, so Jiti/extension loading and the runtime registration path are exercised without a model request. A disposable observer extension records `pi.getMcpServers()` and `pi.getAllTools()` at `session_start`; the test asserts Ketch registration and/or the research tool for each composition, checks exit status and loader stderr, and uses the disposable project as the process cwd. It also verifies the two-entry manifest, the absence of the removed root `index.ts`, and that the project directory remains separate from the repository. Factory tests additionally verify no duplicate Ketch registration, one research tool, independent loading, reversed composition, and no factory-started processes/timers.

## Automated verification

From the repository root:

```text
npm run check
```

Passed: typecheck, **96 unit tests**, and **27 integration tests** (123 total), with no skips. The integration total includes the disposable Pi/Jiti loading check. Native lifecycle, bounded reports, cancellation/timeout, parent-precedence validation, Scout independence, and hostile-descendant cleanup remain passing.

## Actual user setup and smoke test

With explicit user approval, installed the local package into the personal Pi package settings:

```text
pi install /Users/andy/Documents/Development/research-subagents
```

`pi list` reports the local package path, and the resulting `~/.pi/agent/settings.json` contains the package declaration. No package files were copied or modified and no other Pi/Ketch configuration was changed. The user subsequently reported that the basic interactive smoke test worked successfully.

## Outstanding acceptance

Not run and not waived:

- Live model/provider authentication and selected-model acceptance.
- Real Ketch search/scrape/code/docs calls and citation/report-quality review.
- Human TUI observation of queue/progress/expanded output, cancellation, cleanup, and parent-Ketch usability afterward.
- Live short-timeout and no-timeout interactive comparison.

Therefore Step 3.2 and G3 must not be reported as fully verified until those approval-required checks are completed or explicitly recorded as accepted deviations.
