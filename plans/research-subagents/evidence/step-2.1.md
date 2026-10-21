# Step 2.1 — Native Ketch integration

## Result

**Verified for the Step 2.1 scope.** `npm run check` passed typecheck, 56 unit tests, and 9 native integration tests. This includes the existing foundation regressions plus 10 Ketch unit tests and 9 new integration tests. `npm ls` confirmed the target Pi 1.1.0 family and native MCP 1.1.0; no compatibility with other versions is implied.

The entry point now registers parent Ketch capabilities through Pi's native MCP support. It does not register a placeholder `research` tool, create a delegated session, or install/configure the extension in the user's Pi settings. Full child-session isolation belongs to Step 2.2, lifecycle races/unresponsive processes to Step 2.3, and actual Pi/Jiti loading and live acceptance to Step 3.2. G2 has not run.

## What changed

- `index.ts` registers the default `ketch mcp serve` server only when another extension has not already registered that name. It schedules a session-owned readiness diagnostic, respects inactive codemode, and cancels its pending check on shutdown. No process or timer starts in the factory.
- `lib/ketch.ts` shares the existing fixed researcher allowlist. Parent defaults expose search/scrape/code/docs through codemode and hide everything else. Researcher configuration returns a fresh Ketch-only native MCP configuration with four direct tools, no default file loading, and no indirect-tool autoactivation.
- Capability checking distinguishes callable parent tools from the researcher's direct active declarations. A researcher with unexpected reachable tools fails closed. Missing capabilities have a finite, cancellable startup wait and an actionable message; this is not a timeout or budget on research.
- The manifest declares only `./index.ts`. Native MCP is added as a pinned development-only dependency for public `StdioTransport` testing; production code uses the host-provided coding-agent API and native MCP extension, not a custom client.

## Verification setup and observations

The integration fixture creates disposable project/agent directories, in-memory history/settings, a model runtime with network catalog refresh disabled, and a bundled model descriptor. It never calls `prompt()` or requests a model response. A scripted assistant fixture is appended through the authoritative history API solely because native nested tool execution requires an issuing assistant message.

Native Pi MCP clients connect through native `StdioTransport` to `test/fixtures/fake-mcp-server.mjs`, a local JSONL server that makes no network/model requests. Native tool wrappers and actual codemode scripts execute against that server. The tests establish:

- All four core operations return structured MCP values programmatically without a research child. The parent retains its ordinary `read` tool, model selection, and an unrelated server when present.
- Hidden tag/crawl/arbitrary extra tools and MCP resource tools are not callable; hidden tools remain hidden when activation is attempted and are absent from codemode discovery.
- Researcher MCP composition starts only Ketch and declares/reaches exactly the four selected tools, without codemode/tool-search activation or connection to fixture user/project MCP sentinels.
- Native configured-entry precedence wins over default registration. An incompatible configured entry is reported instead of starting a fallback or repairing files. **Configured entries are supplied through the native `loadConfig` test hook:** this proves merge/exposure behavior, not actual user-file parsing or the CLI loader.
- Error prefixes and `isError` survive adaptation, including codemode resolving an MCP error as a structured result. Batch per-URL errors and partial search backend errors remain visible rather than becoming blanket success claims.
- Missing executables, missing tools, late discovery, and cancelled readiness cannot incorrectly pass the capability barrier. Fixture configuration contents remain unchanged.
- Teardown emits native session shutdown before disposal and observes exit of responsive fixture-server PIDs. Hostile descendant/process races and unresponsive-server proof remain Step 2.3 work.

Reproduce from the package root:

```text
node --import tsx --test test/ketch.test.ts
node --import tsx --test test/integration/ketch-mcp.test.ts
npm run check
```

## Consequential API details

- Native MCP maps configured `codemode` exposure onto registered `deferred` tools. Readiness checks actual callability rather than assuming the configured label is the runtime label.
- Native codemode is `model-only`: it cannot recursively invoke itself through `ctx.executeTool`. The scripted top-level codemode test uses public agent-core `runToolCall`; its inner Ketch operations go through native SDK nested-tool validation/hooks. No LLM or conversational agent loop is exercised.
- Native `validateToolArguments` normalizes/coerces inputs before validation. Ketch intentionally keeps native MCP semantics. Step 3.1 is clarified to validate raw `research` input in a `tool_call` hook before coercion, as well as at execution, so strict delegation input is not weakened accidentally.

## Limits and remaining acceptance

No real Ketch binary/backend/auth/browser call, actual model run, permanent installation, or personal Pi/Ketch configuration change was performed. Schema fidelity to every live Ketch option, live retrieval quality, file-config loading under the actual CLI, and report/cancellation behavior through delegated reasoning remain unverified. Existing user-controlled overrides are respected, not semantically certified as Ketch merely because their tools have matching names.
