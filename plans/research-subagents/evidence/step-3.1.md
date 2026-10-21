# Step 3.1 — Public research tool and compact rendering

## Result

**Verified for the deterministic/native tool-pipeline scope.** `npm run check` passed typecheck, **88 unit tests and 25 integration tests** (113 total), with no skips on this platform.

The entry point now exposes the strict `research({ agent, task })` tool. It uses the shared runner from Step 2.3, captures the dispatching session's plain cwd/agent/model/thinking data, propagates the tool signal, and owns active-run cleanup from `session_shutdown`. The public tool is now registered alongside the existing native Ketch integration.

## What changed

- `index.ts` registers the two-profile schema, performs strict validation in `prepareArguments`, the `tool_call` hook, and execution, and rejects unsupported/invalid input before creating a child.
- The tool loads the optional read-only configuration, preserves the parent model/thinking selection as dispatch data, returns bounded final report/diagnostic content, marks non-completed outcomes with `isError`, and includes measured child usage once.
- `lib/render.ts` provides compact call/progress/result rendering using Pi's TUI `Text` and width/ANSI helpers. Default output shows status and activity; expanded output shows the already-bounded report and retained overflow path. Rendering is optional and does not affect noninteractive execution.
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
