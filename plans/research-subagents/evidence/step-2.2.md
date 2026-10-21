# Step 2.2 — Fresh SDK child and authoritative report

## Result and scope

**Verified for Step 2.2.** The final `npm run check` passed typecheck, **77 unit tests and 22 integration tests** (99 total), with **no skips** on this platform. This step adds 17 session tests, 4 Scout prerequisite tests, and 13 native isolation tests. `npm ls` confirms the Pi 1.1.0 family; the new host-provided `pi-ai` peer has a pinned 1.1.0 development copy, deduplicated with agent-core/coding-agent. Installation was package-local with lifecycle scripts disabled.

`lib/session.ts` now provides a real fresh-session adapter. `index.ts` remains the Ketch-only entry point: no public delegation tool, shared queue, safety deadline, or parent-shutdown run registry was added. Step 2.3 and G2 remain Pending. Live backend/model quality, actual CLI/Jiti loading, and TUI acceptance remain Phase 3 work.

## Implementation boundary

- `runResearchSession` strictly validates input before model/session creation, captures dispatch paths, selects the exact provider/model/thinking, and rejects missing model/auth availability or an SDK fallback. Thinking clamping is delegated to the native SDK.
- Each invocation creates its own model runtime, history, settings, resource loader, and extension runtime. The same seeded in-memory settings instance is passed to loader/session, including across loader reload. There are no configured package/resource sources; skills, templates, themes, ordinary extensions, context files, discovered system prompts, and append prompts are suppressed. The system prompt comes only from the bundled profile plus native required runtime/tool metadata.
- Scout loads no MCP extension. Researcher loads only the Ketch factory from Step 2.1. After binding, it awaits capabilities; both profiles must have exactly their permitted active and callable tools before prompting.
- The fixed task prefix and `expandPromptTemplates: false` prevent command/skill/template dispatch. The task after the prefix is unchanged, including whitespace, leading `/mcp`, file-like references, Unicode, and large inputs.
- Subscriptions project counts/latest permitted tool name, not arguments, tool results, thinking, or narration. The adapter waits for the whole prompt/recovery lifecycle and then selects the last finalized non-system message on the active history branch. All final text blocks are joined; missing, blank, error, aborted, length-limited, deferred/pending, and unfinished-tool outcomes cannot become successful reports.
- Usage is summed once from authoritative history entries, including recovered attempts, top-level tool-result nested usage, usage entries, and summaries/compaction. Nested execution events are not billed a second time. Reasoning/cache subsets are not added again to token totals. Malformed optional usage is omitted, not invented.
- Abort/idle and native shutdown start concurrently to avoid an idle-before-MCP-close deadlock. Shutdown is awaited before disposal; event listeners are removed and close is idempotent. Extension error-channel failures and rejected shutdown/abort/disposal paths produce bounded failures. Report overflow handling runs separately from owned-session cleanup and retains only final report text.

## Consequential SDK details

### Read-only model/auth setup

The default SDK auth/catalog file stores can create missing files and refresh credentials. That is unsuitable for the required noninterference boundary. `createChildModelRuntime` instead supplies a selected-provider read-only `CredentialStore` and `InMemoryModelsStore` through public APIs:

- Standard models.json configuration is loaded natively. The target version's selected-provider models-store.json entry is seeded into private memory, retaining native cache timestamp/overlay behavior without creating/updating the user's cache file.
- Stored credentials are read through public `readStoredCredential`. Literal keys, environment-based auth, and unexpired OAuth remain native auth operations. A needed OAuth refresh is rejected before its write/refresh callback can run; the caller must refresh/sign in through the parent and retry. Ephemeral parent runtime keys/provider registration are not copied.
- Stored configured-key strings need native interpolation/command resolution, which `readStoredCredential` deliberately does not perform. A separate metadata-only native runtime/provider resolves that value through the public config/auth API, memoized for this child; no custom shell or backend implementation is introduced. It makes no model request and is not added to the child's provider registry. Trusted user-configured credential commands remain normal Pi behavior, not a sandboxed operation. Tests use only a disposable command printing a dummy value and a provider-scoped environment value.
- Child native MCP logging is directed to `os.devNull` by default; it does not create a personal log or retain a tool transcript. Tests may inject an owned temporary log path.

The cache layout and this auth adapter are explicitly **Pi 1.1.0-sensitive**, not a claim of cross-version compatibility. Auth values are never written to scratch files or included in outcomes.

### Scout native binary prerequisites

A final source review found that Pi's native `grep`/`find` call an automatic rg/fd downloader when binaries are absent. Suppressing package discovery alone does not prevent that side effect. `lib/scout.ts` now checks existing managed/PATH executables (including `fdfind`) without running probes, installing anything, or modifying the process environment. Scout fails before model/session creation when prerequisites are missing.

Public `createGrepToolDefinition`/`createFindToolDefinition` and `defineTool` supply schema/renderer-preserving wrappers through SDK `customTools`, overriding only those two names in the child. Each invocation rechecks availability immediately before calling the native implementation, also guarding a prerequisite that disappears after startup. There is no replacement grep/find backend or extra extension/tool. This follows Pi 1.1.0's lookup policy; it is not an OS-level guarantee against another process maliciously changing executables between filesystem checks.

Tests cover metadata-only discovery with an execution trap, aliases/broken managed entries, startup denial, and per-call denial. Native grep/find execution also passed against the already-installed binaries on this platform; that test explicitly skips rather than downloading on a host lacking those prerequisites. The final gate ran this native search check successfully without a skip; a future host with missing prerequisites must not treat its skip as runtime proof.

### Terminal answer versus next-request context

Pi's next-request context can compact away an answer or omit a failed retry attempt using context edits. Selecting the last assistant from that projection could lose a complete report or resurrect earlier narration. The adapter reads the raw finalized message on the active branch after overall prompt completion instead. Tests cover both retain-none compaction and an omitted terminal failure; compaction summaries and earlier narration are never fallback reports.

### Native scripted transport

Integration tests replace public `ModelRuntime.streamSimple` **before** constructing a session, while retaining native agent/tool/session execution. `Agent` has no public `streamFn` setter; an initial harness attempt using that nonexistent setter was corrected before the passing gate. That failed fixture used a reserved `.invalid` hostname and dummy credentials, not a real model service. Final gate runs use the scripted transport exclusively.

## Verification and limits

`test/integration/isolation.test.ts` creates disposable agent/project trees with user/project/ancestor context sentinels, system/append prompts, skills/templates/themes, a mutating extension, unrelated MCP configuration, and configured npm packages. Native resource reload and emitted request contexts demonstrate suppression; parent data and project/agent directory contents remain unchanged. A separate negative control invokes the native package manager with the disposable **denial executable**, proving the trap intercepts an attempted install without invoking npm or fetching a package. Its expected stderr line is not a product failure.

Native model streams exercise local reads, forbidden write/delegation attempts, exact tool sets, profile overrides/model IDs containing slashes, native thinking clamping, large literal tasks, independent invocations, native automatic retry/settlement, and reported usage. Researcher tests use real native MCP stdio with the existing fake server, observe no first model request before tools exist, and verify responsive server PIDs exit on success/startup failure. No live Ketch/model service is used; request credentials are disposable dummy values.

Unit and Scout fixtures additionally cover missing-binary denial, terminal failure variants, authoritative history versus misleading events, no-findings success, constructor/binding failures, lifecycle error-channel failures, late-created session cancellation, concurrent abort/shutdown, activity callback failures, capped errors, and retained final-only overflow artifacts.

Reproduce from the package root:

```text
node --import tsx --test test/scout.test.ts test/session.test.ts test/report.test.ts
node --import tsx --test test/integration/isolation.test.ts
npm run check
```

This proves adapter/resource/tool/answer plumbing with scripted data, not model judgment, citation accuracy, prompt-injection immunity, live provider interoperability, or hostile lifecycle behavior. Shared capacity, optional timeout, shutdown/reload ownership, unresponsive/descendant process cleanup, cancellation races, and parent/sibling connection noninterference still require Step 2.3/G2. No permanent installation, personal configuration/credential change, staging, or commit was performed.
