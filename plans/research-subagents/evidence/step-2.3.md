# Step 2.3 — Shared runner, cancellation, timeout, and teardown

## Result

**Verified for the Step 2.3 deterministic/native scope.** `npm run check` passed typecheck, **82 unit tests and 24 integration tests** (106 total), with no skips on this platform. This step adds the shared runner, five runner race/status tests, and two native lifecycle tests.

`lib/runner.ts` now owns process-local child capacity and invocation lifecycle. It is not yet registered as the public `research` tool; that remains Step 3.1. Live model/Ketch quality, actual CLI/Jiti loading, and human TUI acceptance remain Step 3.2 work.

## What changed

- `ResearchRunner` enforces a validated shared concurrency limit, starts queued work only when a slot is granted, and releases each slot exactly once on success, failure, cancellation, timeout, and startup rejection.
- Queued calls can be cancelled without creating a child. Active cancellation aborts only that invocation. Parent shutdown cancels queued and active feature-owned work, waits for child completion/cleanup, and prevents later starts.
- No timeout timer is created when `timeoutMs` is absent. When configured, the safety timer starts after a slot is granted, not when the call enters the queue. Timeout is reported as a distinct `timed_out` outcome rather than completed or cancelled research.
- Status callbacks expose only bounded invocation metadata (profile, literal task, state, elapsed time, and activity counters/latest tool). Observer failures are swallowed so rendering cannot affect execution or cleanup.
- The runner passes a child-owned abort signal into the existing session adapter. The adapter continues to start abort and native MCP shutdown concurrently, await shutdown before disposal, and preserve retained overflow artifacts outside child cleanup.
- The fake stdio server can now simulate no startup response or a hanging tool call. Native lifecycle tests observed the owned MCP PID exit in both startup failure and running-timeout cases.

## Verification

Reproduce from the package root:

```text
npm run check
```

The runner tests cover default capacity two, queued cancellation, slot reuse, disabled-by-default deadlines, timeout-after-queue semantics, parent shutdown, status/activity observer failure, and active cleanup. Native lifecycle tests cover an unresponsive MCP startup and a hanging MCP tool call interrupted by the configured timeout; both assert no owned process remains.

## Limits

No real model/Ketch backend request, permanent installation, actual Pi/Jiti loading, or TUI interaction was performed. The process-lifetime checks use the native Pi MCP transport with a disposable local fixture. Cross-platform process teardown beyond the inspected local platform remains unverified. Step 3.1 still must wire the runner to the public tool and parent shutdown hook.
