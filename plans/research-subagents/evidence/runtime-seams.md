# Phase 0 — Runtime seam review

## Result and proof boundary

**Step 0.1: Verified. G0: Passed, for the read-only source-contract scope.** The installed Pi 1.1.0 exports supported APIs that can express the planned fresh SDK sessions, explicit Ketch-only MCP configuration, exact tool selection, and owned shutdown. No product decision or architecture change is required to start Phase 1.

This is not evidence that the implementation works: no feature source, test harness, dependency installation, session creation, process experiment, model request, or web/backend call was performed. Runtime isolation, model/provider compatibility, native process teardown, Pi/Jiti loading, and live report quality remain unverified obligations of later gates.

`PI_PACKAGE` below means:

```text
/Users/andy/.local/share/fnm/node-versions/v24.21.0/installation/lib/node_modules/@earendil-works/pi-coding-agent
```

Source paths and line ranges refer to that installed version, not private imports the extension should take.

## Preconditions and repository boundary

These are historical observations from Step 0.1 in the original `subagent-examples/` container, before Step 1.1 and relocation. The implementation and all planning documents subsequently moved together to `/Users/andy/Documents/Development/research-subagents/`. This source-review record is preserved; relocation does not reset its verification or claim new runtime proof.

- Rechecked package metadata: Pi **1.1.0**. Local Node **v24.21.0** and npm **11.19.0** are available. Reading metadata/version output did not import the SDK or start a session.
- `research-subagents/` does not exist; no new source/test paths collide with existing files. The repository contains the two reference directories and planning documents, without a root package manifest, test/build tooling, or `.git` directory. No repository/ancestor `AGENTS.md` or repository `CLAUDE.md` was found in the inspected paths.
- No existing test/build command was run, and no green or failing runtime baseline is claimed. The minimal example's old package imports remain a static compatibility concern, not a demonstrated test failure.
- Prior discussion-time local MCP discovery identified Ketch **v0.18.1** and the six advertised tools. Phase 0 did not rerun Ketch or treat that discovery as proof of current backend credentials, retrieval, or browser availability.
- No personal credential files were read, copied, or printed. Model/Ketch backend access and human TUI access are not established. Phase 1 dependency installation and later live requests/configuration setup require their respective execution approvals; the Phase 0 request did not authorize either.
- Only this evidence document and the plan's scoped progress/technical clarifications are changed. The spec, reference code, personal skill, installed packages, configuration, and credentials are untouched.

## Source-to-adapter map

| Boundary | Inspected source | Consequence for implementation |
| --- | --- | --- |
| Supported import surface | `dist/index.d.ts:9,15,19–22,31–32`; `examples/sdk/12-full-control.ts`; `examples/sdk/14-codemode-mcp.ts` | Import SDK/session/settings/resource/MCP APIs from the package root. Use public session/runner accessors, not private fields or deep imports. SDK examples provide the baseline configuration/startup shape. |
| Fresh history and settings | `dist/core/sdk.js:69–85`; `dist/core/session-manager.js:1364`; `dist/core/settings-manager.js:250–255,362–387` | Pass a new `SessionManager.inMemory(cwd)` and explicit in-memory settings. Do not rely on SDK defaults, which otherwise create file-backed managers and default resource discovery. |
| Resource suppression and inline factories | `dist/core/resource-loader.js:240–267,350–368,401–408,462–490,542–555,870–893`; `dist/core/resource-loader.d.ts:70–125` | Suppression flags coexist with explicit ordinary inline factories. Load only the selected MCP factory for researcher, none for scout. Explicit prompt and empty append-prompt inputs are also necessary. |
| Configured-package resolution before extension filtering | `dist/core/resource-loader.js:350–368`; `dist/core/package-manager.js:704–744,1014–1036` | `noExtensions` is not an independent no-install boundary: loader reload resolves configured packages before filtering extension paths, and missing package sources can trigger installation. Use the **same** fresh `SettingsManager.inMemory(...)`, with no package/resource entries, for both loader and session. Do not clone the parent's settings or pass file-backed settings into the child loader. |
| Exact model and thinking | `dist/core/sdk.js:87–143`; `dist/core/model-runtime.js:78–114`; `dist/core/model-runtime.d.ts:4–23` | Resolve provider/model explicitly before session construction; passing no model permits fallback. SDK clamps thinking. Construct child-owned model services with catalog network refresh disabled unless explicitly needed; deterministic tests inject model/auth services and do not instantiate a real provider workflow. |
| Actual tool reachability | `dist/core/sdk.js:145–158`; `dist/core/agent-session.js:193–198,1119–1158`; `dist/core/agent-session.d.ts:416–422` | Use exact tool names, not additive modifiers. An allowlist containing explicit `mcp__` names filters MCP registration too; a plain built-in-only allowlist does not. Verify both active declarations and reachable tools, not merely names returned by a registration spy. |
| Ketch-only MCP loader | `dist/extensions/mcp/index.d.ts:33–60`; `dist/extensions/mcp/config.d.ts:58–69`; `dist/extensions/mcp/index.js:968–1009` | Supply an explicit `LoadedMcpConfig` with only Ketch, no project config path, no automatic codemode activation, and four direct overrides with other tools hidden. A new child extension runtime prevents parent-registered servers from joining the native configured/registered merge. No default user/project MCP loader is called for the child. |
| Capability-readiness barrier | `dist/extensions/mcp/index.js:968–1042`; `dist/core/extensions/runner.js:1121–1165` | `bindExtensions()` starts MCP work in the background. The native prompt wait has a finite fallback that does not fail closed, and generic lifecycle-hook throws are caught/reported. The adapter must validate all required active/reachable tools before calling `prompt()`, using a cancellable startup check. A connection-readiness limit is not a timeout on research. |
| Explicit native shutdown | `dist/core/agent-session.js:992–1011,1909–1920,3570–3572`; `dist/core/agent-session-runtime.js:296–302`; `dist/core/extensions/runner.d.ts:23–25,179`; `dist/core/extensions/types.d.ts:624–629` | `session.dispose()` alone does not emit MCP shutdown. Abort owned work as necessary, await the public `session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" })` path before disposal, unsubscribe/remove listeners, and keep cleanup idempotent. The helper used by Pi's runtime is not needed as a private import. Do not await idle indefinitely before starting the cleanup needed to unblock outstanding tools. |
| Shutdown errors are not rejected promises | `dist/core/extensions/runner.js:813–842`; `dist/core/agent-session.d.ts:165–174`; `dist/core/agent-session.js:2614–2616,2664–2666` | Generic event handlers report errors through the extension error channel. Bind/capture that channel and treat material child startup/shutdown errors explicitly; an awaited event resolving is not proof that every close handler succeeded. |
| Native stdio process ownership | `dist/extensions/mcp/index.js:1111–1117`; `node_modules/@earendil-works/pi-mcp/dist/transports/stdio.js:7–35,72–90,132–162` | Native MCP shutdown aborts its session work and awaits connection closes. On the local non-Windows platform, stdio uses process groups and close escalation (stdin, SIGTERM, SIGKILL). This supports the intended adapter boundary, but only native lifecycle tests can establish observed process exit and descendant cleanup. Do not reimplement an MCP client or equate signal delivery with exit. |

## Locked implementation details

1. **One in-memory settings instance per child.** Seed its initial state with child policy and no package/resource sources, then pass it to both the `DefaultResourceLoader` and `createAgentSession`. In-memory reload remains in memory. Do not use transient `applyOverrides()` as the sole protection: loader `reload()` rebuilds settings from storage and those overrides are not the stored seed.
2. **Explicit prompt inputs.** Supply the bundled profile as `systemPrompt` and `appendSystemPrompt: []`, together with all resource suppression flags. `noContextFiles` suppresses AGENTS/CLAUDE context discovery, not `SYSTEM.md`/`APPEND_SYSTEM.md` discovery by itself. Sentinel tests must cover both forms.
3. **No inherited extension/runtime state.** The child loader receives only the researcher MCP inline factory when needed; never reuse the parent loader, extension runtime, registered-server list, transcript, or mutable model selection. Standard model/auth configuration may be read through supported APIs; unavailable custom/ephemeral provider setup remains an explicit error.
4. **No prompt until capabilities are ready.** Check exact tools before prompting rather than hoping native startup waits succeed. The startup check must honor cancellation and emit an actionable missing-tool/connection diagnostic. No normal research deadline is allocated by default.
5. **Capture lifecycle errors and own cleanup.** Bind the extension error listener, initiate cancellation without creating an idle/close deadlock, await native shutdown, then dispose in final cleanup. Preserve retained report artifacts outside that cleanup. Runtime behavior under races/unresponsive servers remains a mandatory Phase 2 gate.
6. **Native MCP remains the transport implementation.** Use its public injection hook for fake-service tests; internal source paths in this note are evidence, not extension dependencies. Keep the version-sensitive SDK adapter narrow.

## Gate assessment and remaining proof

- G0's source-backed expressibility checks passed. No new material product contradiction or unsupported/private-only API dependency was found. The in-process SDK design remains the selected plan; no user decision is needed before the Phase 1 foundation.
- Implementation must still demonstrate configured-package noninstallation, profile/system-prompt/resource isolation, exact tool reachability, and unchanged parent state using disposable native integration fixtures. Reading source does not satisfy AC2–AC5 or AC16.
- Phase 2 must observe native server/process lifetime on success, startup failure, queued/running cancellation, timeout, shutdown/reload, unresponsive stdio, and sibling/parent noninterference. Capture shutdown error-channel failures; do not mark cleanup verified from a resolved event call.
- Live model/Ketch calls, accurate citations, real auth/browser behavior, and human TUI/noninteractive acceptance remain unperformed and unwaived. Existing model/network request timeouts do not change the confirmed **no research timeout by default** policy.
- Phase 1 may be proposed next. No Phase 1 work or dependency installation was started as part of this gate.
