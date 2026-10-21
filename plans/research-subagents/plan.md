# Research Subagents Implementation Plan

## Status and governing source

- Governing spec: [spec.md](spec.md), requirements R1–R12 and acceptance criteria AC1–AC16.
- Additional governing clarification: the user reaffirmed that research has **no timeout by default**, with an optional configurable safety timeout available if long sessions become an issue.
- Delivery state: In progress. Phase 0, Phase 1, and Step 2.1 are Verified; G0 and G1 passed. Steps 2.2–3.2 and G2/G3 remain Pending. The entry point provides Ketch MCP integration only; delegation is not registered yet.
- Acceptance or release still pending: Full feature acceptance, end-to-end report integration, native-runtime checks, and approval-required live/TUI checks. Scoped foundation checks are recorded below. Publication and permanent installation are not part of this plan.
- Blockers: No unresolved product decisions or foundation blockers. Live acceptance requires explicit approval, available model/Ketch credentials, and human TUI access. Native child isolation and MCP teardown are mandatory later gates, not assumed successes.

Step statuses below are the authoritative execution record. A phase is complete only when its step completion gates and phase exit gate are satisfied. Checkboxes indicate completed tasks, not passed gates. Verified means the scoped gate and implementation review passed; it does not mean live acceptance, user approval, installation, or release. In supervised execution, record manual approvals in extension state, not task checkboxes.

## Execution constraints

- Repository/package root: `/Users/andy/Documents/Development/research-subagents`. All authored source/test/planning paths below are relative to this root. Reference examples remain outside the package under `../subagent-examples/` and are not runtime dependencies. `PI_PACKAGE` denotes the inspected external installation at `/Users/andy/.local/share/fnm/node-versions/v24.21.0/installation/lib/node_modules/@earendil-works/pi-coding-agent`; it is read-only reference material.
- Implement directly at the package root (`lib/`, `agents/`, `test/`), not in another nested package directory. Planning documents live at `plans/research-subagents/` inside this project. Preserve the external examples, governing spec, personal Ketch skill, existing Pi/Ketch configuration, authentication, and unrelated work; example deletion is a separate user action.
- Historical baseline: the original `subagent-examples/` container had no root manifest, tests, build scripts, or Git directory. The standalone package now has the Step 1.1 manifest/tooling/tests; its source and planning documents were relocated together after that step. Do not initialize Git, install the extension permanently, or treat static legacy-import concerns in the examples as demonstrated runtime failures.
- Every package/test file and command described below is a **proposed addition**, except the installed Pi APIs/docs and ordinary Node/npm executables. Do not attempt these commands until their owning step adds the necessary tooling.
- Use current `@earendil-works/*` APIs and host-provided TypeBox. Pi's package docs require host libraries as `peerDependencies: "*"`, not runtime dependencies; pin development copies to the inspected Pi 1.1.0 generation for reproducible tests. Document the supported version rather than claiming that the peer range establishes compatibility.
- Never launch real research, install dependencies, modify real home/configuration, or invoke permanent package installation merely to satisfy a deterministic test. Use disposable directories, explicit agent/config paths, fake model/session services, and fake MCP transports/processes. A fake-service test does not establish live backend compatibility.
- No processes, sockets, or long-lived timers start in the extension factory. Feature-owned resources begin during a session/tool invocation and are cleaned up on every terminal path and parent shutdown/reload.
- Keep timeout configuration absent/disabled by default; no normal turn/tool-call/token/spend cap. Native connection and per-request network timeouts are distinct from a deadline on the whole research run.
- Keep stable step IDs and brief evidence at the owning gate. Create supporting notes only for consequential runtime decisions, failures, or reproducibility details; do not create empty evidence files or paste transcripts into this plan.

### Inspected implementation seams and chosen path

This plan uses **fresh in-process SDK sessions**, an option explicitly allowed by the spec, rather than copying either large subprocess extension:

1. `PI_PACKAGE/dist/index.d.ts` exports `createAgentSession`, `SessionManager`, `SettingsManager`, `DefaultResourceLoader`, `ModelRuntime`, and `createMcpExtension`.
2. `dist/extensions/mcp/index.d.ts` exposes `createMcpExtension({ loadConfig, createTransport, ... })`. A supplied loader can return only the feature-owned Ketch entry, avoiding default user/project `mcp.json` discovery. `createTransport` is a native fake-service testing seam, not a reason to implement another MCP client.
3. `examples/sdk/14-codemode-mcp.ts` shows explicit MCP startup through `session.bindExtensions()`. Resource suppression supports explicit inline factories, but loader reload resolves configured packages before extension filtering. Pass the same fresh, seeded `SettingsManager.inMemory(...)` to the loader and session; do not inherit package/resource settings or rely only on transient `applyOverrides()`. Set the profile `systemPrompt` explicitly and `appendSystemPrompt: []`: `noContextFiles` alone does not suppress discovered system/append prompts.
4. `dist/core/sdk.js` can select a fallback model if `model` is absent. Resolve and validate the exact selected provider/model before constructing a session; never pass an unresolved selection and rely on that fallback.
5. **Cleanup caveat:** `dist/core/agent-session.js` shows that `session.dispose()` invalidates contexts and removes listeners but does not itself emit `session_shutdown`. `AgentSessionRuntime.dispose()` emits shutdown first; native MCP closes connections from its shutdown handler. The child adapter must perform and await the supported shutdown-event path before final disposal, not call `dispose()` alone.
6. `dist/core/extensions/runner.d.ts` exposes `session.extensionRunner.emit(...)`; the matching runtime implementation uses `session_shutdown` with reason `quit`. Generic handler failures are reported through the extension error channel rather than necessarily rejecting this call: capture that channel and do not treat promise resolution as proof of cleanup. Keep this version-sensitive sequence in one adapter and verify native stdio teardown, including unresponsive-server handling.
7. MCP connections start in the background. Native startup wait expiry can allow a prompt to proceed before tools exist. Explicitly await/check the required reachable Ketch tools before submitting the task; throwing from a generic extension lifecycle handler is not a reliable fail-closed barrier because the runner catches those errors.

Use a child-owned model runtime and in-memory settings/history, not the parent's agent, conversation, extension runner, or mutable selection state. Reuse supported credential/model configuration without copying parent messages or loading provider extensions. Unsupported ephemeral/custom parent provider availability remains a clear error as specified, not a reason to inherit unrelated extensions.

This selection removes CLI/task-file/JSON-stream plumbing and allows readiness validation before the first model request. It does not add sandbox guarantees. If native teardown or isolation cannot meet the spec, stop the affected gate and document the technical blocker; do not quietly broaden tools, weaken cleanup, or switch architecture mid-step.

### Proposed package tooling and configuration

Working directory for package commands below: the repository/package root (`/Users/andy/Documents/Development/research-subagents`).

| Proposed command | Tooling added in Step 1.1 | Purpose |
| --- | --- | --- |
| `npm run typecheck` | TypeScript, `tsconfig.json`, script invoking `tsc --noEmit` | Type-check source and tests against the target SDK |
| `npm test` | `tsx`, Node `node:test`, script invoking `node --import tsx --test test/*.test.ts` | Deterministic focused tests; no real model or web calls |
| `npm run test:integration` | Script invoking `node --import tsx --test test/integration/*.test.ts`; tests added in Phase 2 | Native Pi/MCP composition using fake services/disposable processes |
| `npm run check` | Composition of typecheck, unit tests, integration tests | Final deterministic package regression gate, used once the integration files exist |

Focused commands below use that same Node runner with explicit test paths; they are not additional frameworks or existing repository commands. No compiled distribution/build pipeline is needed for a local TypeScript Pi extension. Validate its actual Pi/Jiti loading separately; `tsc --noEmit` is not runtime-load proof.

Use one optional, user-owned configuration file at `getAgentDir()/research-subagents.json`, read without creating or rewriting it. Proposed fields: positive integer `maxConcurrency` (default 2), optional positive finite `timeoutMs` (absent means disabled), and optional `profiles.scout` / `profiles.researcher` model and thinking overrides. Models are fully qualified `provider/id`; preserve slashes inside model IDs. Invalid or unknown configuration fields fail with a useful message. The report cap stays a v1 constant at 12 KiB; output target and retrieval guidance remain prompt policy rather than another configuration surface.

Use the installed `ketch` executable with fixed `mcp serve` arguments and its own ordinary backend/configuration behavior. Parent integration registers a session-scoped Ketch server through Pi's native MCP extension, default-hidden with only the four core tools exposed as codemode tools. Native file-configured precedence is not silently rewritten. Detect incompatible user overrides and explain how to resolve them; never take over an unrelated server or hide an existing failure. Researcher loading returns its own explicit Ketch-only config with those four tools direct, everything else hidden, and codemode/tool-search autoactivation disabled.

## Phase overview and delivery boundary

| Phase | Outcome | Dependencies | Exit gate |
| --- | --- | --- | --- |
| 0 | Confirm the target SDK contracts and verification boundary | Governing spec and installed references | G0: source-backed implementation boundary, no runtime claims |
| 1 | Small package foundation, fixed profiles, validated policy, bounded handoff | G0 | G1: focused policy/report checks compose and type-check |
| 2 | Native Ketch access and isolated child execution with lifecycle control | G1 | G2: native isolation/teardown plus deterministic execution tests |
| 3 | Model-facing delegation, minimal rendering, documented setup, acceptance | G2 | G3: full deterministic regression and separately recorded live/manual acceptance |

Delivery boundary: one feature-complete standalone local package handoff at this project root, with these reviewable increments. If later submitted through Git, the phases may be one feature-complete PR; no intermediate installation/publication is implied.

Atomic groups: each SDK/MCP policy change lands with its adapter tests; final `research` registration lands with its runner consumer and rendering tests in Step 3.1. No schema/data migration or reference-package deletion is planned. Phase 1 is development foundation, not a claimed functional extension; Phase 2.1 adds the real Ketch-only entry point, and Phase 3.1 adds delegation without placeholder handlers.

## Phase 0 — Runtime and safety boundary lock

Outcome: implementation can start with an explicit SDK/resource/teardown boundary and an honest baseline.
Depends on: the governing spec and readable installed target package.
Review boundary: read-only reference/API analysis and concise planning evidence; no application code, installs, provider calls, or process experiments.

### Step 0.1 — Confirm the supported runtime and test seams

Status: Verified
Requirements / acceptance: R2–R5, R7–R11; prerequisite analysis only, not acceptance fulfillment.
Depends on: None.
Review boundary: confirm the chosen SDK path and record any execution-critical incompatibility before implementation.

Expected files:

- `plans/research-subagents/evidence/runtime-seams.md` — add only when recording the consequential runtime/cleanup decision during execution.
- `plans/research-subagents/plan.md` — gate status and any necessary source-backed correction; preserve product decisions.

Tasks:

- [x] Reconfirm exported APIs, inline-factory loading under resource suppression, exact model resolution, tool reachability, and supported session-shutdown emission against the implementation-time installed version.
- [x] Record the small source-to-adapter map, including the difference between session disposal and MCP shutdown, tool-readiness barrier, and native MCP resource/tool exposure filtering.
- [x] Confirm new package/test paths do not collide with new user work and identify any existing failures or missing execution prerequisites without calling them regressions.
- [x] Separate dependency-install approval from live model/web/TUI approval; record actual availability without printing secrets or treating schema discovery as backend verification.

Verification:

- Automated: Not applicable; this is a read-only source/contract gate, not a runtime test.
- Manual: Compare the targeted declarations and implementations with the chosen path above. Expected result: each needed hook is supported, no reliance on private fields/deep package imports, and no unacknowledged inheritance of user resources. Record technical blockers instead of relaxing a boundary.

Completion gate: the implementation seams are source-backed, version prerequisites are identified, and no unresolved SDK-contract issue makes subsequent steps speculative. This gate does not prove isolation or process cleanup at runtime.
Evidence: Passed source/API review against installed Pi 1.1.0; Node v24.21.0/npm 11.19.0 metadata and repository inventory confirmed. Recorded the supported SDK/tool/shutdown seams and tightened settings, prompt-discovery, and lifecycle-error handling in [runtime-seams.md](evidence/runtime-seams.md). No implementation tests, sessions, or live workflows ran.

Phase exit gate **G0**: after Step 0.1 review, assess whether the supported SDK path can express all required boundaries. Advance only if it can; otherwise mark the affected implementation steps Blocked and document a recommended resolution. Do not ask the user to approve a weakened security/context contract as an implementation convenience.
Evidence: Passed for the source-contract scope; the chosen SDK path can express the required boundaries through public APIs without a product change. [Runtime proof remains explicitly deferred to G2/G3](evidence/runtime-seams.md#gate-assessment-and-remaining-proof). No Phase 1 work was performed as part of G0.

## Phase 1 — Policy and report foundation

Outcome: a small, testable package foundation defines the two profiles, safe defaults, and bounded report behavior without exposing an unfinished research tool.
Depends on: G0.
Review boundary: new package-local tooling/policy/report helpers and their tests; no real Ketch/model launch or user configuration changes.

### Step 1.1 — Add package-local tooling, profiles, and validated configuration

Status: Verified
Requirements / acceptance: R1, R3, R5, R7, R11, R12; AC1 (validation portion), AC7 (selection portion), AC10 (configuration portion), AC16 (configuration-read portion). Runtime portions belong to Steps 2.2–3.2.
Depends on: Step 0.1.
Review boundary: actual pure policy/configuration behavior and development tooling; no placeholder extension exports.

Expected files:

- `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore` — add package-local development scripts/dependencies; no missing entry-point declaration.
- `lib/config.ts`, `lib/profiles.ts` — add strict configuration parsing, fixed profile names/tool policy, and explicit model/thinking selection data.
- `agents/scout.md`, `agents/researcher.md` — add bundled research-only prompts; no hardcoded Anthropic requirement.
- `test/config.test.ts`, `test/profiles.test.ts` — add deterministic policy tests.

Tasks:

- [x] Add the proposed Node/TypeScript tooling, host peers, pinned target-generation development dependencies, and package-local lockfile; install dependencies only under execution approval.
- [x] Define the strict two-field delegation input and fixed profile map; reject whitespace tasks, unknown profiles, orchestration/override parameters, and invalid configuration before any session creation.
- [x] Implement read-only optional configuration loading and model/thinking precedence without selecting a fallback; keep default timeout undefined and concurrency two.
- [x] Adapt profile instructions for compact cited findings, gaps, no edits/delegation, untrusted content, selective retrieval, and no tagging; avoid loading the personal skill or requiring long code/source inventories.
- [x] Test omitted/invalid configuration, provider-qualified IDs containing additional slashes, missing parent model, inheritance/overrides, forbidden profile tools, and the literal-task policy.

Verification:

- Automated: from `.`, run `npm run typecheck` and `node --import tsx --test test/config.test.ts test/profiles.test.ts`. Assert no configuration writes/session creation, exactly two profiles, correct selection data, and no default timeout/budget.
- Manual: Review prompts against R12 and the current Ketch MCP schemas. This proves intended guidance, not resistance to all prompt injections or real backend availability.

Completion gate: the new pure helpers and prompts pass scoped tests/typecheck and are reviewable without future runner code. No unimplemented `research` tool or invalid package entry point is advertised.
Evidence: From `.`, `npm run typecheck` and `node --import tsx --test test/config.test.ts test/profiles.test.ts` passed (29 tests), including a fresh typecheck/test rerun after relocation to the standalone package root; source/prompt review confirmed strict policy, literal tasks, read-only configuration, no default timeout, and no advertised entry point. Local dependencies were installed with lifecycle scripts disabled; `npm ls` confirmed the Pi 1.1.0 family and TypeBox 1.3.27, with development overrides preventing transitive drift to 1.3.0. These checks exercise pure policy/loading only: SDK session/auth/thinking clamping, native tool isolation, report capping, and live Ketch/model behavior are not yet verified.

### Step 1.2 — Implement the capped report/diagnostic handoff

Status: Verified
Requirements / acceptance: R6, R9, R11, R12; AC9 (full helper portion), AC8/AC13 (formatting portions). Native final-message selection and integrated overflow are owned by Steps 2.2 and 3.1.
Depends on: Step 1.1.
Review boundary: deterministic byte-bounded handoff and private overflow artifacts; no model-driven summarization or transcript retention.

Expected files:

- `lib/report.ts` — add UTF-8-safe capping and final-report artifact handling.
- `test/report.test.ts` — add byte-boundary, permission, and filesystem-failure fixtures.

Tasks:

- [x] Return ordinary reports unchanged under the 12 KiB text budget; apply the same budget to terminal diagnostics and all profile results.
- [x] For overflow, reserve space for a truthful clipping notice and absolute path, preserve complete final report text in private scratch storage outside the repository, and keep it separate from ephemeral session cleanup.
- [x] Handle multibyte text, exact boundaries, path/notice overhead, and failed artifact writes without falsely promising preservation or treating clipping as synthesis.
- [x] Keep only final report artifacts and bounded rendering metadata; exclude raw child/tool/reasoning transcripts from parent details and scratch output.
- [x] Test repository/home noninterference, private permissions, retention after simulated child cleanup, and storage failure using temporary directories and injected filesystem errors.

Verification:

- Automated: `node --import tsx --test test/report.test.ts`, then `npm run typecheck`. Assert every model-facing result is at most 12 KiB in UTF-8, retained contents match the input exactly, files are private/outside the fixture repo, and error paths remain bounded.
- Manual: Not needed for this helper scope; integrated parent readability is checked in Step 3.2.

Completion gate: boundary/failure tests pass, retained reports survive only the intended cleanup boundary, and no future runner is needed to demonstrate helper correctness.
Evidence: `node --import tsx --test test/report.test.ts` passed all 17 focused tests, followed by a passing `npm run typecheck`; source review confirmed private exclusive file creation and final-report-only metadata. Tests cover 12 KiB byte boundaries, multibyte text/paths, canonical workspace exclusion, retained reports after simulated child cleanup, unchanged fixture repo/home files, partial writes, permission/storage/cleanup failures, and bounded truthful diagnostics. The future host must supply the repository/workspace root and selected final text; actual SDK lifecycle and model-facing integration are not yet verified.

Phase exit gate **G1**: after Step 1.2 checks, run `npm run typecheck` and `npm test` over the existing foundation tests. Review the config/profile/report contracts together: no automatic configuration writes, no default research deadline, no broad tool grants, and no transcript persistence. This does not establish a runnable extension yet.
Evidence: Passed `npm run typecheck` and the full `npm test` suite (46 tests), after the focused Step 1.2 checks. Reviewed the policy/profile/report composition: settings are read-only, timeout remains disabled by default, tools stay fixed, and the handoff helper retains only final report text with a bounded excerpt/path. No runtime session, live backend, user configuration, dependency, or installation changes were needed; G2/G3 remain Pending.

## Phase 2 — Native Ketch and isolated execution

Outcome: real native MCP composition and fresh-session execution are implemented behind tested adapters, with reliable lifecycle control before exposing delegation to the model.
Depends on: G1.
Review boundary: parent Ketch entry point, child session adapter, and run ownership; no elaborate UI, real backend tests, or permanent installation.

### Step 2.1 — Expose Ketch through native MCP and define isolated child loading

Status: Verified
Requirements / acceptance: R2–R4, R11, R12; AC3 (native MCP/resource policy portion), AC5/AC6 (fake MCP portions), AC16 (registration portion). Full child composition belongs to Step 2.2; live backend proof belongs to Step 3.2.
Depends on: Step 1.2.
Review boundary: a functional Ketch-only extension entry point plus child-only native MCP policy, not a custom retrieval implementation.

Expected files:

- `index.ts` — add real parent Ketch registration; no stub delegation tool.
- `lib/ketch.ts` — add shared command/tool policy, native child `loadConfig`, and capability-readiness validation.
- `package.json` — add explicit Pi manifest pointing only to `index.ts`; helper/test files are not discoverable extensions.
- `test/ketch.test.ts`, `test/integration/ketch-mcp.test.ts` — add native MCP composition tests.
- `test/fixtures/fake-mcp-server.mjs` — add a minimal disposable stdio fixture for process/tool/error testing, not a production MCP client.

Tasks:

- [x] Register the feature's default Ketch entry through `pi.registerMcpServer` without touching `mcp.json` or starting processes in the factory. Expose only search/scrape/code/docs through codemode in that default entry.
- [x] Build the researcher's explicit `createMcpExtension({ loadConfig, ... })` input: Ketch only; four direct tool overrides; all other tools hidden; no codemode/tool-search activation. Keep this factory researcher-only; scout's no-MCP session wiring remains in Step 2.2.
- [x] Define a cancellable, finite capability-startup check that runs before the first research prompt; distinguish startup/network failure from an optional deadline on research itself. Missing required tools must fail clearly, not merely log a lifecycle-hook error.
- [x] Respect native user-configured server precedence, surface incompatible overrides, and leave unrelated server registrations/active tools intact; make default Ketch configuration and child configuration share the intended CLI/backend behavior without copying unrelated server entries.
- [x] Exercise structured results and error prefixes/per-URL failures through native Pi wrappers with injected transports/fake stdio; verify direct parent calls need no research session.

Verification:

- Automated: `node --import tsx --test test/ketch.test.ts` and `node --import tsx --test test/integration/ketch-mcp.test.ts`, then `npm run typecheck`. Assert only the selected capabilities are reachable, hidden tools cannot be loaded indirectly, unwanted servers never start, returned MCP structures/errors survive, and missing capabilities are detected before a model prompt.
- Manual: No real Ketch backend use here. Inspect manifest/load-path and override diagnostics; actual Pi/Jiti loading and user-configured behavior are checked in Step 3.2.

Completion gate: native MCP tests—not just mock registration assertions—prove the default exposure and startup/failure contract. Parent Ketch integration is a real usable capability at this review boundary.
Evidence: `npm run check` passed typecheck, 56 unit tests, and 9 native integration tests; source/manifest review confirmed Ketch-only registration and lifecycle-owned readiness checks. Actual codemode and native stdio/tool wrappers exercised controlled results, hidden-tool/resource exclusion, configured-entry precedence, missing/late tools, errors, and responsive process teardown; [step-2.1.md](evidence/step-2.1.md) records setup, proof limits, and the raw-input coercion detail carried into Step 3.1. No live Ketch/model requests, CLI/Jiti acceptance, permanent installation, or user configuration changes occurred; full child isolation and G2/G3 remain Pending.

### Step 2.2 — Run a fresh, strictly configured SDK child and select its final answer

Status: Pending
Requirements / acceptance: R1–R6, R9, R11, R12; AC2, AC3, AC7, AC8, AC13, AC14 (automated portions), AC4/AC16 (session-isolation portions). Live/model-quality and final tool-pipeline portions remain in Phase 3.
Depends on: Step 2.1.
Review boundary: one real isolated session adapter with final-answer/error handling and baseline cleanup; no shared queue or public delegation registration yet.

Expected files:

- `lib/session.ts` — add child SDK creation, readiness, model validation, event projection, and owned cleanup.
- `test/session.test.ts` — add injected session/model fixtures for finalized answers, errors, recovery, and literal/large tasks.
- `test/integration/isolation.test.ts` — add native SDK/resource-load/tool-reachability tests in disposable homes/repos.

Tasks:

- [ ] Create a child-owned model runtime, fresh history, captured dispatch `cwd`, and one seeded in-memory settings instance shared by loader/session with no package/resource sources. Suppress extensions/skills/templates/themes/context discovery, set the bundled profile as `systemPrompt` and `appendSystemPrompt: []`, and load only the explicit researcher MCP factory. Do not depend on `applyOverrides()` surviving loader reload.
- [ ] Resolve the exact selected model and validate supported/auth availability before constructing a session; propagate thinking with SDK clamping. Fail unavailable selection without fallback or importing unrelated parent provider extensions.
- [ ] Bind extensions, await the required tool set, and submit a literal, self-contained task only afterward. Prefix/encode task text so a leading `/mcp` or similar text is not executed as a command; do not expand parent history, file references, or templates automatically.
- [ ] Subscribe before prompting; project only activity counters/latest tool name and finalized assistant outcome. Await overall prompt completion/recovery, concatenate all final text blocks, and reject empty/error/abort/output-limit/unfinished-tool outcomes instead of using earlier narration.
- [ ] Use the handoff helper; aggregate reportable nested model usage once if available under the current tool-result contract, without a usage dashboard or double-counted nested results. Capture the extension error channel as well as promise rejections. Make cleanup idempotent: initiate cancellation without an idle/close deadlock, await child native extension/MCP shutdown before disposal, handle reported shutdown failures explicitly, and unsubscribe on every terminal/startup-failure path.
- [ ] Test fresh-context sentinels, task literals/large input, exact reachable tools, user/project/package/system/append-prompt sentinels that must never enter the child, no configured-package installation, terminal-versus-recoverable errors, and a legitimate no-findings answer. Use real SDK setup for resource/tool isolation, injected session/provider responses for answer-state logic, and disposable installer-denial fixtures; name that proof boundary honestly.

Verification:

- Automated: `node --import tsx --test test/session.test.ts test/report.test.ts` and `node --import tsx --test test/integration/isolation.test.ts`, then `npm run typecheck`. Assert no parent/previous-child sentinels or filesystem writes, no forbidden callable tools/server startup, correct selected model, no model request before capability readiness, final-answer-only handoff, and native shutdown on success and failure.
- Manual: Review the isolated session's loader/settings inputs and emitted model context in fixtures. A scripted provider/session proves plumbing, not that a real model will always cite accurately or resist injection; live review stays pending.

Completion gate: the adapter runs correctly against completed prerequisites, native isolation tests pass, and successful/error/recovery fixtures cannot leak interim transcript content or silently choose another model. Baseline cleanup must already work; lifecycle race hardening is not an excuse to leak until Step 2.3.
Evidence: Not run.

### Step 2.3 — Add shared queue, cancellation, optional timeout, and shutdown ownership

Status: Pending
Requirements / acceptance: R7–R11; AC10, AC11, AC12 (automated portions), AC15/AC16 (lifecycle portions). Final parent-tool/TUI observations remain in Steps 3.1–3.2.
Depends on: Step 2.2.
Review boundary: invocation scheduling and resource ownership, including hostile cancellation timing; no new research features or budgets.

Expected files:

- `lib/runner.ts` — add shared capacity, invocation ownership/status, optional timeout, and parent-shutdown cleanup.
- `lib/session.ts` — bounded adapter changes for abort/cleanup ownership only.
- `test/runner.test.ts` — add deterministic queue/race/fake-clock checks.
- `test/integration/lifecycle.test.ts`, `test/fixtures/fake-mcp-server.mjs` — add native MCP process lifetime/unresponsive-server cases.

Tasks:

- [ ] Implement a cancellation-aware shared capacity limit; queued calls consume no child resources. Recheck cancellation when granting a slot, release exactly once on all paths, and keep sibling state independent.
- [ ] Allocate a wall-clock deadline only for configured `timeoutMs`, starting at child startup rather than queue entry. With no configuration, allocate no research-deadline timer and impose no call/turn budget.
- [ ] Distinguish cancelled, timed-out, failed, and completed outcomes. Abort startup/readiness/running work, close child-owned MCP connections using native shutdown, dispose the child, and remove timers/listeners without invoking the parent's abort/shutdown actions.
- [ ] Track active invocations for parent session shutdown/reload; ensure no queued work starts afterward. Use bounded native process teardown/escalation rather than treating a sent signal or `dispose()` call as evidence a process exited.
- [ ] Test queued cancellation versus slot release, already-aborted signals, overlapping completion/abort/timeout, startup rejection, default unlimited-call behavior, and an unresponsive fake stdio MCP server. Confirm overflow artifacts survive cleanup while the parent connection and unrelated sibling remain usable.

Verification:

- Automated: `node --import tsx --test test/runner.test.ts` and `node --import tsx --test test/integration/lifecycle.test.ts`, then `npm run typecheck`. Assert maximum two active defaults, no cancelled queued starts, capacity recovery, no deadline by default, truthful timeout status when enabled, closed native connections/terminated owned processes, and sibling/parent noninterference.
- Manual: Not required for scoped deterministic races; TUI cancellation is a separate live/manual gate. If native MCP cannot terminate the fake unresponsive process cleanly, stop G2 rather than waiving orphan prevention.

Completion gate: queue/race and native process-lifetime assertions pass without hanging the test process, including success/failure/shutdown cleanup. Optional timeout remains off by default and does not become a hidden startup-to-completion budget.
Evidence: Not run.

Phase exit gate **G2**: after Step 2.3 checks, run `npm run check`. Review native isolation and lifecycle results together: only Ketch connects for researcher, no MCP connects for scout, no first prompt without tools, every terminal path releases capacity and owned resources, and no parent configuration/tool/model replacement occurs. Fix regressions before exposing `research` publicly. Record source/runtime proof limits and any platform limitation instead of calling mocked checks live acceptance.
Evidence: Not run.

## Phase 3 — Delegation surface and acceptance

Outcome: a locally loadable, documented two-profile extension provides compact parent-facing research results with minimal progress and verified failure semantics.
Depends on: G2.
Review boundary: public tool wiring/rendering, local loading/setup guidance, and final deterministic plus approval-required user-facing acceptance. No permanent installation, publication, or edits to the user's personal skill/configuration.

### Step 3.1 — Wire the public research tool and compact progress rendering

Status: Pending
Requirements / acceptance: R1, R4, R6–R12; AC1, AC5, AC8–AC16 (integrated automated portions). The backend/TUI/manual portions are owned by Step 3.2, not claimed here.
Depends on: Step 2.3.
Review boundary: atomic schema/runner/renderer integration into the existing Ketch entry point; no stub tools or nested-agent UI.

Expected files:

- `index.ts` — add validated `research` tool, prompt guidance, progress projection, shutdown handler, and truthful result errors/usage.
- `lib/render.ts` — add only compact call/status/activity and expanded bounded report presentation using Pi's built-in components/width helpers.
- `test/tool.test.ts`, `test/render.test.ts`, `test/integration/extension.test.ts` — add public tool-pipeline, exposure, noninterference, and render fixtures.

Tasks:

- [ ] Register the strict `research({ agent, task })` schema and shared runner without model-controlled directory/tool/model overrides. Validate raw `research` input in a `tool_call` hook before Pi's native argument coercion, as well as at execution; invalid direct/programmatic calls fail before session creation. Preserve native coercion semantics for Ketch tools rather than adding a second MCP validator.
- [ ] Capture dispatch plain data, propagate the tool signal, and send only bounded model-facing report/diagnostic content. Mark errors through the supported tool-result failure contract; keep status metadata separate from raw transcripts and include nested usage once when measured.
- [ ] Render queued/running/terminal status, profile/task, elapsed time/tool activity, and expanded bounded report; never stream the child transcript or reasoning to parent context. Handle partial arguments, no TUI, narrow widths, and Unicode with library helpers.
- [ ] Add guidance for autonomous multi-step delegation versus direct simple Ketch lookups and self-contained child tasks. Do not force routing or alter unrelated parent active tools/model/thinking.
- [ ] Wire parent session shutdown/reload to owned-run cleanup; test a full tool invocation with scripted child outcomes and native fake MCP, parent/sibling sentinel isolation, schema failures, overflow, errors, and cancellation. Do not confuse a registry spy with a real tool-pipeline integration.

Verification:

- Automated: `node --import tsx --test test/tool.test.ts test/render.test.ts` and `node --import tsx --test test/integration/extension.test.ts`, then `npm run typecheck`. Assert complete schema-to-runner-to-result behavior; only intended Ketch/codemode/research additions; bounded text; no transcript details; correct failure flags; no-TUI parity; stable rendering at narrow widths; parent state/config snapshots unchanged.
- Manual: Inspect default/expanded render snapshots and documented Ctrl+C semantics. Interactive/model/backend proof remains Step 3.2.

Completion gate: public registration and its consumers/tests land atomically and pass scoped pipeline checks. No private worker/profile/config behavior is exposed accidentally. Ketch direct programmatic calls still require no delegated session.
Evidence: Not run.

### Step 3.2 — Document local setup and verify actual user-facing behavior

Status: Pending
Requirements / acceptance: R1–R12; completes AC4–AC8, AC12, AC15, AC16 live/manual portions and validates actual loading for the automated contract set. See final mapping for owners of other portions.
Depends on: Step 3.1.
Review boundary: setup/recovery documentation, actual Pi/Jiti loading, and explicitly approved live acceptance; not automatic installation or a release.

Expected files:

- `README.md` — add supported versions, prerequisites, optional configuration example, usage, safety limitations, timeout semantics, and recovery/removal guidance.
- `test/integration/loading.test.ts` — add disposable-home native Pi loading/manifest checks without a model request, using explicit resource paths and fake MCP transport.
- `plans/research-subagents/plan.md` — concise gate outcomes and outstanding acceptance; supporting `evidence/live-acceptance.md` only when meaningful real checks occur.

Tasks:

- [ ] Document separate direct-Ketch and delegated workflows, two-profile input, inherited/overridden models, private overflow paths, no sandbox, no default timeout, optional timeout interruption semantics, and the difference between research deadlines and native request timeouts.
- [ ] Document explicit local loading from the package directory, required Pi 1.1.0/Ketch v0.18.1 target prerequisites, backend/browser/model setup responsibilities, native MCP/codemode requirements, conflicting file-configured Ketch precedence, and actionable missing-tool/auth failures. Do not change the user's existing skill; explain that child guidance is bundled and independent of it.
- [ ] Run the complete deterministic gate and actual local Pi extension loader in a disposable home/project; verify manifest scope and sibling helper/test files are not loaded as extensions. Ensure reference examples are not simultaneously auto-loaded and no real home is mutated.
- [ ] After explicit live/model/web approval, use a controlled scratch repo and one-shot extension loading to perform a local scout task and a sourced researcher task. Exercise search, scrape, code, and docs programmatically; compare researcher capability/backend behavior, inspect concise citations/gaps, and read an overflow report if generated or injected for the check.
- [ ] With human TUI access, observe queue/activity/expanded reports, cancel a running investigation, and confirm later work/parent Ketch still functions. Exercise a configured short safety timeout in the disposable setup; then remove it and confirm no research deadline is enabled. Observe noninteractive results separately.
- [ ] Record what actually ran, versions/model/backend used without credentials, configuration/repo snapshot results, limitations and any blocked checks. Do not mark overall acceptance verified if live/manual criteria remain unperformed; an accepted waiver is an Accepted deviation with its owner and follow-up, not a passing test.

Verification:

- Automated: from `.`, `npm run check`, including the newly added loading check. Expected: deterministic suites pass with disposable resources, explicit loader/manifest composition succeeds, and reference directories/user files remain untouched. This does not prove real web/model behavior.
- Manual, approval-required: create a disposable project and a private directory named by `$SMOKE_AGENT_DIR`, populate only its explicitly approved credential setup, and ensure Ketch is installed. From the disposable project, start `PI_CODING_AGENT_DIR="$SMOKE_AGENT_DIR" pi --no-extensions --extension builtin:mcp --extension builtin:codemode --extension /absolute/path/to/research-subagents/index.ts` (substitute the actual local package path). Confirm those explicit built-ins are enabled rather than relying on ambient extensions. Run the tasks/calls above and observe useful cited final reports, no child transcript handoff, truthful failures/interruptions, unchanged fixture repository and existing configuration/model selections, and clean owned-process teardown. A fake provider does not satisfy this check.

Completion gate: mark Verified only when documentation matches observed behavior and deterministic/loading plus required live/backend/TUI checks pass. If required live checks lack credentials, human access, or approval, leave this step Blocked rather than reporting a product pass. An explicitly waived check makes the affected step Accepted deviation, not Verified. No permanent installation is required to finish this gate.
Evidence: Not run.

Phase exit gate **G3**: after Step 3.2 checks, review `npm run check` outcomes, actual local loading, report quality/citations, cancellation/optional-timeout behavior, and parent/repository/configuration noninterference. Reconcile every AC below with its owning evidence. The feature is implementation-verified only for the exercised scope; full spec acceptance requires every required portion to pass. Report any explicitly owned waiver separately as an Accepted deviation, not full verification. Do not publish/install automatically after this review.
Evidence: Not run.

## Final acceptance

This table maps coverage; it is not a second execution checklist. Evidence and authoritative status stay at the linked owning steps/gates. ACs with automated and live/manual portions are not fully satisfied by only one portion.

| Spec acceptance ID | Owning step / gate | Verification and expected result | Evidence / status |
| --- | --- | --- | --- |
| AC1 | Steps 1.1, 3.1 / G3 | Strict two-profile input; invalid parameters never start work; public tool has no chain/worker/recursive path. | See [Step 1.1](#step-11--add-package-local-tooling-profiles-and-validated-configuration) and [Step 3.1](#step-31--wire-the-public-research-tool-and-compact-progress-rendering). |
| AC2 | Step 2.2 / G2 | Captured native/injected session inputs prove fresh context, literal large tasks, and no history forwarding. | See [Step 2.2](#step-22--run-a-fresh-strictly-configured-sdk-child-and-select-its-final-answer). |
| AC3 | Steps 2.1–2.2 / G2 | Native resource/MCP composition: unrelated resources never load/connect and only exact profile tools are reachable. | See [Step 2.1](#step-21--expose-ketch-through-native-mcp-and-define-isolated-child-loading) and [Step 2.2](#step-22--run-a-fresh-strictly-configured-sdk-child-and-select-its-final-answer). |
| AC4 | Steps 2.2, 3.2 / G3 | Tool/instruction fixtures plus approved representative tasks leave the repository unchanged; no claim of universal injection immunity. | See [Step 2.2](#step-22--run-a-fresh-strictly-configured-sdk-child-and-select-its-final-answer) and [Step 3.2](#step-32--document-local-setup-and-verify-actual-user-facing-behavior). |
| AC5 | Steps 2.1, 3.1–3.2 / G3 | Real native wrapper structures plus live core Ketch calls; direct calls spawn no child and researcher uses the same capabilities/backend configuration. | See Steps [2.1](#step-21--expose-ketch-through-native-mcp-and-define-isolated-child-loading), [3.1](#step-31--wire-the-public-research-tool-and-compact-progress-rendering), [3.2](#step-32--document-local-setup-and-verify-actual-user-facing-behavior). |
| AC6 | Steps 2.1–2.2, 3.2 / G3 | Injected missing-tool/setup/upstream/partial failures remain useful and nonmutating; actual setup diagnostics reviewed without configuration repair. | See Steps [2.1](#step-21--expose-ketch-through-native-mcp-and-define-isolated-child-loading), [2.2](#step-22--run-a-fresh-strictly-configured-sdk-child-and-select-its-final-answer), [3.2](#step-32--document-local-setup-and-verify-actual-user-facing-behavior). |
| AC7 | Steps 1.1, 2.2, 3.2 / G3 | Precedence/clamping/failure tests plus approved selected-runtime check; never silently choose another provider/model. | See Steps [1.1](#step-11--add-package-local-tooling-profiles-and-validated-configuration), [2.2](#step-22--run-a-fresh-strictly-configured-sdk-child-and-select-its-final-answer), [3.2](#step-32--document-local-setup-and-verify-actual-user-facing-behavior). |
| AC8 | Steps 2.2, 3.1–3.2 / G3 | Final text blocks only, capped public handoff, no transcript, and representative real reports cite evidence/gaps. | See Steps [2.2](#step-22--run-a-fresh-strictly-configured-sdk-child-and-select-its-final-answer), [3.1](#step-31--wire-the-public-research-tool-and-compact-progress-rendering), [3.2](#step-32--document-local-setup-and-verify-actual-user-facing-behavior). |
| AC9 | Steps 1.2, 3.1 / G3 | Multibyte overflow/report-storage failure cases compose through the public result; private complete artifact survives child cleanup. | See Steps [1.2](#step-12--implement-the-capped-reportdiagnostic-handoff), [3.1](#step-31--wire-the-public-research-tool-and-compact-progress-rendering). |
| AC10 | Steps 1.1, 2.3, 3.1 / G3 | No default deadline/call budget; configured deadline starts after queueing and produces timed-out, not completed. | See Steps [1.1](#step-11--add-package-local-tooling-profiles-and-validated-configuration), [2.3](#step-23--add-shared-queue-cancellation-optional-timeout-and-shutdown-ownership), [3.1](#step-31--wire-the-public-research-tool-and-compact-progress-rendering). |
| AC11 | Steps 2.3, 3.1 / G3 | Concurrent public calls respect capacity, cancel queued work without starting, and keep result/progress identity. | See Steps [2.3](#step-23--add-shared-queue-cancellation-optional-timeout-and-shutdown-ownership), [3.1](#step-31--wire-the-public-research-tool-and-compact-progress-rendering). |
| AC12 | Steps 2.3, 3.1–3.2 / G3 | Native unresponsive-process/race tests and approved Ctrl+C/shutdown checks prove owned cleanup and sibling/parent usability. | See Steps [2.3](#step-23--add-shared-queue-cancellation-optional-timeout-and-shutdown-ownership), [3.1](#step-31--wire-the-public-research-tool-and-compact-progress-rendering), [3.2](#step-32--document-local-setup-and-verify-actual-user-facing-behavior). |
| AC13 | Steps 2.2, 3.1 / G3 | SDK terminal fixtures/public result reject errors, aborts, empty or unfinished answers, while substantive no-findings succeeds. Subprocess exit-zero cases are represented by an equivalent successful transport/prompt return with failed terminal assistant status. | See Steps [2.2](#step-22--run-a-fresh-strictly-configured-sdk-child-and-select-its-final-answer), [3.1](#step-31--wire-the-public-research-tool-and-compact-progress-rendering). |
| AC14 | Steps 2.2, 3.1 / G3 | Recovery is awaited; initial agent end is not final; explicit retry creates an independent session. | See Steps [2.2](#step-22--run-a-fresh-strictly-configured-sdk-child-and-select-its-final-answer), [3.1](#step-31--wire-the-public-research-tool-and-compact-progress-rendering). |
| AC15 | Steps 2.3, 3.1–3.2 / G3 | Status/render fixtures plus human TUI and noninteractive checks distinguish every outcome without transcript injection. | See Steps [2.3](#step-23--add-shared-queue-cancellation-optional-timeout-and-shutdown-ownership), [3.1](#step-31--wire-the-public-research-tool-and-compact-progress-rendering), [3.2](#step-32--document-local-setup-and-verify-actual-user-facing-behavior). |
| AC16 | Steps 1.1, 2.1–2.3, 3.1–3.2 / G3 | Configuration/credential/model/unrelated-tool snapshots survive success, failure, and cancellation; only intended registrations/scratch/cache effects occur. | See owning phase gates G1–G3 and [Step 3.2](#step-32--document-local-setup-and-verify-actual-user-facing-behavior) for integrated/live observations. |

No separate reference-example/workspace regression suite exists to run. Final regression is this package's deterministic suite and local Pi loading; the external example directories remain unchanged reference material, not newly supported applications or runtime dependencies. Packed/published-artifact verification is not claimed for a local-source extension handoff.

## Rollback and recovery

- The new package is additive. Revert a scoped implementation step with its coupled tests/consumer changes; revert the feature as a whole by removing its local loading/configuration entry only if such an entry was explicitly added later. Do not remove either reference directory or the personal Ketch skill as cleanup.
- Initial experimentation uses one-shot loading and disposable configuration. Stopping that session is the rollback; no permanent user settings need restoration. If a later approved user install is performed, back up only the settings being edited and document its inverse separately—this plan does not authorize that install.
- Public registration/runner/schema changes in Step 3.1 are one revert unit. Keep the earlier Ketch integration functional if reverting delegation alone. Do not roll back only half of a tool contract and its consumer.
- On run failure/interruption, stop owned work, release the slot, keep any already-retained report outside ephemeral cleanup, and allow a new independent invocation. Do not auto-repair auth/configuration or indefinitely retry the entire delegation.
- A native teardown/isolation failure blocks further exposure/live acceptance until corrected. Retain only the consequential failure evidence needed to reproduce it; avoid deleting user-owned data to clear the problem.
- No irreversible migration, publication, or deployment is planned. External model/web requests consume quota and cannot be undone; require approval. Temporary overflow reports can contain sensitive data and have no durability guarantee; deletion/long-term retention remains user-managed, not a new automatic cleanup subsystem.

## Deferred checks and accepted deviations

- Accepted deviations: None. The SDK-session choice is explicitly permitted by the spec; it is recorded above, not a waiver of the context/process-cleanup contract. Process-exit-specific AC wording will be checked through equivalent SDK terminal/transport outcomes, with real native MCP process lifetime also tested; neither has been verified yet.
- Dependency installation: performed locally for Step 1.1 with lifecycle scripts disabled and a package-local lockfile. Host libraries remain peer dependencies with target-version development copies; development overrides pin transitive Pi libraries to the inspected 1.1.0 generation. No permanent Pi package installation or user configuration change was performed.
- Live model/Ketch backend, browser behavior when needed, real report quality/citations, and human TUI acceptance: not performed or waived. Keep Step 3.2's affected scope pending/blocked until approved credentials/access are available. Record an owned Accepted deviation only if the user later chooses to waive a check.
- Broad compatibility: target the inspected Pi 1.1.0/Ketch v0.18.1 and current local platform. Do not imply other versions/platforms are verified. Architecture changes needed for another version require source review and the same isolation/lifecycle gates.
- Hard budgets, enforced retrieval/network/tagging restrictions, reusable child memory, crawl/bookmarks, project profiles, richer UI, durable artifacts, automatic long-term artifact cleanup, and publication remain deferred as described in the spec.
