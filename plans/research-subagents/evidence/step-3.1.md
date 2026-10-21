# Step 3.1 — Public research tool and compact rendering

## Result

**Verified for the deterministic/native tool-pipeline scope.** Before the entry-point split, `npm run check` passed typecheck, **95 unit tests and 26 integration tests** (121 total). After the split, `npm test` passes **96 unit tests** and the integration suite remains green; Step 3.2 will record the complete post-refactor `npm run check` plus disposable loading proof. The implementation includes bounded MCP escalation, dispatch-time parent/child Ketch transport validation, interruption races, initialization diagnostics, repository-root report exclusion, and live progress rendering.

The standalone research entry point exposes the strict `research({ agent, task })` tool. It uses the shared runner from Step 2.3, captures the dispatching session's plain cwd/agent/model/thinking data, propagates the tool signal, validates parent Ketch parity at researcher dispatch, and owns active-run cleanup from `session_shutdown`. The separate Ketch entry point owns only parent MCP registration/readiness.

## What changed

- `extensions/research.ts` registers the two-profile schema, performs strict validation in `prepareArguments`, the `tool_call` hook, and execution, and rejects unsupported/invalid input before creating a child. `extensions/ketch.ts` independently registers parent Ketch/readiness without registering research.
- The tool loads the optional read-only configuration, preserves the parent model/thinking selection as dispatch data, returns bounded final report/diagnostic content, marks non-completed outcomes with `isError`, and includes measured child usage once.
- `lib/render.ts` provides compact call/progress/result rendering using Pi's TUI `Text` and width/ANSI helpers. Default output shows status and activity; expanded output shows the already-bounded report and retained overflow path. Missing details retain the actual bounded diagnostic. Rendering is optional and does not affect noninteractive execution.
- Setup failures are converted to the same capped public result contract. Dispatches from a repository subdirectory resolve the `.git` root before report-storage exclusion checks. Runner activity includes elapsed time for live and terminal updates.
- A parent Ketch registration or trusted config override that changes command, arguments, environment, cwd, or transport is rejected before delegated research, with actionable remediation and no configuration writes. Validation resolves the effective native file-configured entry first; a compatible global/trusted-project entry therefore overrides an incompatible extension registration exactly as native Pi does.
- `@earendil-works/pi-tui` is declared as a host peer with a pinned development copy for the target Pi 1.1.0 tests.
- Unit tests cover raw validation, literal task forwarding, status updates, failure flags, parent shutdown, narrow/Unicode rendering, and transcript exclusion. The integration fixture exercises the registered tool through Pi's native extension/tool pipeline while the existing native MCP fixture remains connected and usable.

## Verification

Reproduce from the package root:

```text
node --import tsx --test test/tool.test.ts test/render.test.ts test/integration/extension.test.ts
npm run check
```

The deterministic integration check used a scripted child outcome through an injected runner seam and a real native parent extension/MCP tool pipeline. Earlier Phase 2 tests cover fresh child execution and native child Ketch lifecycle. No model request or live backend call was made.

## Limits

Step 3.2 still owns actual Pi/Jiti loading, README/setup guidance, live Ketch/model/backend quality, citation review, human TUI cancellation, and optional-timeout user acceptance. No permanent installation or personal configuration change occurred.
