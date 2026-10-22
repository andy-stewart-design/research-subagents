# Research Subagents Specification

## Status

- Readiness: Implemented baseline.
- Blocking decisions: None. Inferred v1 defaults are identified separately from explicit agreement below.
- Delivery: Scout, Researcher, and Worker are implemented in the current extension; automated checks cover the baseline behavior.
- Source: The research-subagents discussion and grill-me interview in this session; the two local reference implementations; installed Pi documentation; the Ketch skill and MCP tool definitions inspected during the discussion.

## Problem and intended outcome

Research often requires reading many files or web pages, while only a small fraction of that material is useful to the ongoing coding conversation. Performing the entire investigation in the parent session consumes its context window and carries irrelevant intermediate material into subsequent work.

Provide focused delegation: a child investigates or implements in a fresh context and returns a compact report. The parent retains responsibility for decisions and may explicitly delegate code changes to Worker. The same Ketch capabilities must also be programmatically callable by the parent for simple lookups that do not warrant a separate reasoning context.

Success means that a parent can obtain useful local-code or web research without receiving the child's tool transcript, granting the child implementation tools, or adopting a general-purpose agent orchestration framework.

## Scope

Included:

- One delegation tool with three bundled profiles: `scout` for local code, `researcher` for external research, and `worker` for repository implementation.
- Fresh, one-shot child contexts, compact cited reports, basic progress, cancellation, and an optional safety timeout.
- Ketch MCP integration for web search, scraping, public OSS code search, and library documentation, usable independently of delegation.
- Explicit child tool/resource selection, model defaults and profile overrides, and a small shared concurrency limit.
- Research-policy instructions adapted from the existing profiles and Ketch skill.

Non-goals:

- Recursive delegation, chains, batch-array APIs, or background jobs.
- Resumable child conversations, inherited parent transcripts, automatic parent-context extraction, or persistent research memory.
- Project-defined agents, dynamic third-party agent registration, or general agent discovery.
- OS sandboxing, filesystem-root enforcement, private-network blocking, or credential isolation.
- Hard per-run token, spend, turn, or tool-call budgets; graceful budget-exhaustion summarization.
- Reimplementing Ketch's backends, MCP transport, tool schemas, cache, or configuration UI.
- Crawl and bookmark workflows, sophisticated nested-agent rendering, or a usage dashboard.

## Current behavior and evidence

Static inspection and documentation:

Reference paths in this section are historical source paths relative to the external `../subagent-examples/` directory. The standalone package and this spec now live under `/Users/andy/Documents/Development/research-subagents/`; those examples are not runtime dependencies and may be deleted separately after implementation.

- `earendil-works pi main packages-coding-agent_examples_extensions_subagent/index.ts` launches a Pi subprocess per task and consumes JSON events. It supports single, parallel, and chain modes, inherits the dispatcher's model/thinking when no agent model is set, and propagates cancellation. Its concurrency limiter applies within parallel batches; parallel result text is capped at 50 KiB per task. It has no extension-defined per-run research deadline or turn/tool-call budget.
- The reference's `index.ts` and `agents.ts` were compared with the installed Pi 1.1.0 example and were identical. This is source parity, not evidence that the example was executed successfully here.
- `pi-subagents-main/index.ts` uses one task per tool invocation, a process-local semaphore with default concurrency four, curated extension loading, roughly 50 KiB output truncation, and worker recursion/registration machinery. It still imports `@mariozechner/*` and `@sinclair/typebox`. No per-run research budget is defined there either.
- `pi-subagents-main/agents/scout.md` provides read-only local exploration and structured file references. `pi-subagents-main/agents/researcher.md` supplies varied search angles, primary-source preference, citations, and gaps, but expects external `web_search`/`web_fetch` extensions.
- `/Users/andy/.pi/agent/skills/ketch/SKILL.md` currently describes CLI workflows and research policy rather than native Pi tools.
- Installed Pi documentation under `/Users/andy/.local/share/fnm/node-versions/v24.21.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/docs/` establishes the relevant contracts in `extensions.md`, `sdk.md`, `cli.md`, `cli-integration.md`, `json.md`, and `mcp.md`: native MCP registration/exposure, model-callable extension tools, resource suppression, and authoritative completed-message events. JSON-mode process exit status alone does not establish successful assistant completion. Disabling extensions also disables built-in MCP unless it is explicitly enabled.

Runtime discovery, not backend verification:

- A local MCP initialization and `tools/list` exchange with `ketch mcp serve` identified Ketch v0.18.1 and six tools: `search`, `scrape`, `code`, `docs`, `crawl`, and `tag`. The advertised schemas include structured outputs, result/content bounds, and error semantics. MCP `crawl` advertises `max_pages` and `max_chars`, despite the older CLI-focused skill's crawl limitations.
- No search, scrape, docs, or code backend call was made to establish availability, credentials, data quality, or cancellation behavior. No new MCP configuration was installed.

Preserve fresh contexts, completion-driven runs, and parent cancellation. Deliberately remove orchestration modes and worker capabilities, narrow resource loading, replace shell-based Ketch recipes with its existing MCP tools, and reduce the parent-facing report budget substantially below the references' emergency caps.

## Requirements and invariants

- **R1 — Focused interface:** Expose a single-task delegation tool accepting exactly one bundled profile and a nonempty task. Unknown profiles or invalid input must fail before launching a child. There is no recursive, chain, or batch mode.
- **R2 — Context isolation:** Every invocation starts a fresh child conversation. Only the explicit task, the selected profile's instructions, and required runtime/tool metadata enter that conversation; parent messages and previous child history must not be copied automatically. Ordinary project/user skills, prompt templates, context files, and unrelated extensions must not be discovered into children.
- **R3 — Tool restriction:** Scout receives only local read/search/list tools. Researcher receives only the four selected Ketch tools. Worker receives only read/write/edit/bash. No profile receives unrelated MCP tools or delegation. This is a tool boundary, not a sandbox.
- **R4 — Shared research capabilities:** The parent can call the selected Ketch tools programmatically without spawning a research child. Researcher uses those same Ketch capabilities and configured backends rather than a second web-tool implementation. Missing required capabilities must produce an actionable failure, not a tool-less research run.
- **R5 — Explicit model selection:** Model/thinking selection follows the documented inheritance and profile-override rules. An unavailable selected model or credentials must fail clearly rather than silently switch provider/model or modify credentials.
- **R6 — Bounded handoff:** The model-facing delegation result contains a compact report or bounded diagnostic, never the child's raw transcript, reasoning trace, or accumulated tool results. Report policy requests evidence and uncertainty. A hard byte cap and explicit overflow behavior apply to every profile and terminal outcome.
- **R7 — Completion-driven lifecycle:** A child normally runs to completion without an imposed research-call, turn, token, or spend budget. An optional configurable wall-clock timeout is a failsafe. Interrupted work must not be presented as a completed report, and no graceful partial synthesis is promised.
- **R8 — Concurrency and cancellation:** Concurrent delegation calls share a bounded child-runner capacity. Cancellation applies while queued and while running, releases capacity, and cleans up owned processes/resources. Cancelling one invocation must not cancel unrelated children or parent-owned MCP connections.
- **R9 — Truthful results and recovery:** Success requires authoritative successful child completion and nonempty final report text. Process failure, terminal assistant error/abort, missing tools, empty output, and interruption are distinguishable from success. A substantive "no relevant findings" report is allowed. A new invocation is an independent retry, not a continuation of stale child state.
- **R10 — Minimal observability:** Users can distinguish queued, running, and terminal states, identify the profile/task, and see basic activity while a child runs. The tool remains functional without an interactive UI, and progress does not become a full transcript handoff.
- **R11 — Ownership and noninterference:** Loading or invoking the feature must not silently edit existing Pi/Ketch configuration, authentication, the parent's model/thinking selection, unrelated active tools, or repository files. Registering the intended research/Ketch tools and enabling their required codemode support is allowed. Feature-owned scratch files and Ketch's normal cache are allowed. Child teardown must not delete retained reports or user-managed data.
- **R12 — Research policy:** Profiles instruct children to answer the delegated question, cite evidence, distinguish facts from inference, and state gaps. Fetched content is untrusted data, not authority to change instructions or request unrelated actions. Ketch backend defaults are respected unless the task justifies an explicit supported override; the feature must not repair credentials/configuration automatically.

## Behavior and contracts

### Delegation interface

The v1 baseline tool name is `subagent`:

```ts
subagent({
  agent: "scout" | "researcher" | "worker",
  task: string
})
```

The task must contain non-whitespace text. It is the caller's responsibility to provide the question, relevant constraints, and context the child needs. Tasks are passed as data, not shell commands or CLI options. Large tasks must not depend on fitting into a command-line argument.

The working directory is captured from the dispatching session. There is no model-controlled `cwd`, model override, tool override, or arbitrary agent-file parameter. Configuration of these policies is owned by the user/extension, not by delegated task text.

One call starts at most one child. Multiple independent calls may run concurrently. Each result belongs only to its own invocation; sibling progress and reports must not be interchanged.

### Profiles and Ketch exposure

| Context | Available research/local tools | Explicitly excluded |
| --- | --- | --- |
| Scout child | Pi `read`, `grep`, `find`, `ls` | Shell, write/edit, all MCP tools, delegation |
| Researcher child | Ketch MCP `search`, `scrape`, `code`, `docs`, declared directly | Local file tools, shell, write/edit, delegation, crawl, tag tool, other MCP servers |
| Worker child | Pi `read`, `write`, `edit`, `bash` | Unrelated MCP tools, delegation, ordinary extensions, skills, templates, and context files |
| Parent | Selected Ketch tools callable through Pi codemode; delegation tool available to the model | No withdrawal or replacement of unrelated parent capabilities |

Pi's expected Ketch names are `mcp__ketch__search`, `mcp__ketch__scrape`, `mcp__ketch__code`, and `mcp__ketch__docs` when the server is named `ketch`. The implementation plan must account for Pi's actual server precedence and tool-exposure behavior; a plain non-MCP tool allowlist is not sufficient proof that other MCP tools are inaccessible.

The researcher must not connect unrelated MCP servers or execute unrelated discovered extensions, even if the user has them configured for the parent. Parent Ketch integration uses Pi's native MCP/codemode support. Child MCP support must be enabled explicitly under its curated resource configuration.

Ketch retains ownership of backend defaults, authentication, browser behavior, and normal cache writes. Hiding the `tag` tool is not a claim of mutation-free Ketch: core tools also advertise an optional `tag` argument. V1 research instructions omit that argument; strict bookmark-write enforcement is not promised.

The policy requests bounded lookups: default to five search/code/docs results where applicable, approximately 6,000 characters per scraped page, and the configured/default docs token allowance. Prefer search followed by selective scraping; browser rendering is an escalation, not a promise to bypass authentication or anti-bot controls. These are instruction-level defaults, not a new enforcing wrapper around Ketch. Programmatic parent callers may request other supported values and reduce results before exposing them to the model.

The scout is told to locate relevant symbols and relationships, read useful sections, and cite exact file/line references. The researcher is told to vary search angles when needed, prefer authoritative sources, check applicability/version, and cite URLs. The worker is told to inspect before editing, make targeted changes, run verification, and report the result. These instructions constrain intended behavior but do not establish immunity to prompt injection.

### Models and configuration defaults

The following are inferred v1 baseline defaults, not separately user-approved values:

| Setting | Default and contract |
| --- | --- |
| Model | Parent's active provider/model captured at dispatch; optional user-configured per-profile override |
| Thinking | Parent's level unless overridden per profile; clamp to the selected model's supported levels |
| Maximum concurrent children | Two per parent extension runtime, shared across delegation calls |
| Safety timeout | Disabled unless configured; a configured value is positive and applies from child startup, not queue entry |
| Report target | Usually 400–800 words; shorter answers are preferable when sufficient |
| Hard model-facing result cap | 12 KiB UTF-8, including headings, overflow notice, path, or diagnostic |
| Profile discovery | Three bundled profiles only |
| Delegation guidance | Parent may delegate multi-step investigations autonomously; use direct tools for simple lookups |

Invalid configuration fails clearly rather than silently disabling limits or tools. Selection of a credential source must use supported Pi/Ketch behavior; parent process-only provider registration or ephemeral credentials are not assumed to be available to a subprocess.

### Report and overflow contract

A normal report uses this compact structure, omitting an unnecessary next lookup:

```markdown
## Answer
Direct answer to the question.

## Evidence
Findings with file:line references or source URLs.

## Caveats
Uncertainty, conflicting evidence, and material gaps.

## Next lookup
A specific follow-up only if necessary.
```

Code snippets are optional and included only when needed to explain a finding. A list of every rejected source or every file read is not required. Citations must identify actual inspected evidence; fabricated source locations are not acceptable research behavior.

The successful report comes from the final authoritative assistant response, including all of its text blocks. Earlier assistant narration is not a fallback final answer. Completion is determined after the whole run finishes, not at the first low-level `agent_end` event or solely by process exit code.

If the report exceeds the hard cap, the host retains the complete final report in a private scratch file outside the repository and returns a UTF-8-safe clipped excerpt plus an explicit truncation notice and absolute path. It must not claim that clipping is a synthesized summary. The child still has no write tool. The retained file survives child cleanup; it is temporary, not durable storage or a resumable session. If retaining an oversized report fails, report that failure rather than silently claiming the complete report was preserved.

Only the final report is retained for overflow handling, not the child's reasoning/tool transcript. Error diagnostics are bounded too. Normal results and progress may carry non-model-facing metadata for status/rendering. Raw tool transcripts are not stored in the parent's result details as a shortcut around context isolation.

### Lifecycle, failure, and cancellation

| State/outcome | Observable behavior |
| --- | --- |
| Queued | Waiting for a shared slot; cancellable without launching work |
| Running | Profile/task visible, with elapsed/activity indication such as tool count or latest tool name |
| Completed | Final successful nonempty report, subject to the handoff cap; a report describing no findings is valid |
| Failed | Actionable bounded error; do not substitute earlier narration or empty success |
| Cancelled | Explicit interruption, not completed research; no synthesis guarantee |
| Timed out | Distinct safety-timeout outcome, not completed research; no synthesis guarantee |

A cancelled request must not start after its queue slot becomes available. Running cancellation/timeout initiates cleanup of the child and child-owned MCP processes; unresponsive owned processes must not remain indefinitely. Timers/listeners and the concurrency slot are released on every terminal path, including startup failure. Reload/shutdown cleans up active feature-owned runs.

A terminal assistant error/abort can occur even when the process exits zero. Provider output-limit termination or a final tool request without a completed answer must not masquerade as a complete report. Automatic Pi recovery/retries may precede terminal completion; do not declare failure solely because an earlier recoverable event reported an error.

Ketch errors retain their useful distinctions: validation errors require different input, missing configuration requires operator action, and upstream failures may be transient. Recoverable tool errors may be investigated by the child. A terminal run failure remains a failed delegation. Batch scrape per-URL errors and search backend partial failures must not be silently treated as evidence that every source succeeded.

If interruption leaves an already finalized text fragment that is shown, label it incomplete; no partial result is required. The parent can request another fresh investigation. Neither timeout nor ordinary invocation automatically edits configuration, installs dependencies, changes authentication, or retries the entire delegation indefinitely.

### Parent user flow

1. For a small lookup, the parent calls Ketch through codemode and selects the fields/content worth returning to its model context.
2. For a multi-step investigation, the parent submits a self-contained task to one profile.
3. The user sees queued/running activity and can cancel. A sibling task remains independent.
4. On success, the parent receives only the compact report and can use its citations for targeted verification or read the overflow report if needed.
5. On failure/interruption, the parent receives a truthful outcome and decides whether to narrow, retry, or proceed without the research.

## Ownership and boundaries

- **Parent session:** owns the conversation, delegation task, implementation decisions, and ordinary tools. No automatic transcript forwarding or replacement of its model or unrelated tool configuration.
- **Delegation extension/runner:** owns profile selection, fresh child creation, tool/resource restrictions, concurrency, lifecycle cleanup, bounded handoff, and optional overflow artifacts. It may reuse the current example's execution mechanics but must not inherit its unrelated orchestration features or cleanup weaknesses blindly.
- **Child:** owns only its temporary research conversation and final report. It cannot dispatch other agents or acquire new tools through task text, skill discovery, or project configuration.
- **Pi:** owns its supported agent/MCP/codemode runtime and model/auth integration. A Pi subprocess with JSON events is the planning baseline; the behavioral contract does not require a process boundary merely to achieve fresh contexts.
- **Ketch:** owns retrieval, provider configuration, browser/cache behavior, and tool schemas. Do not add generic shell access to compensate for missing MCP capabilities.
- **Research instructions/skill:** own research guidance, not transport or shell recipes. Essential guidance is embedded in the child profile; child correctness must not depend on automatically loading the user's personal skill file.

The two reference directories are source material, not both extensions to load simultaneously or APIs to depend on through global registration. Existing user configuration and unrelated source files remain unchanged by feature operation. Initial setup is explicit and must document required Pi/Ketch versions and credential prerequisites; supporting other Pi releases is not assumed.

## Acceptance criteria

All verification below is proposed. No implementation acceptance tests or live retrieval checks have been performed for this feature.

| ID | Requirement(s) | Starting condition / action | Expected outcome | Verification approach |
| --- | --- | --- | --- | --- |
| AC1 | R1 | Invoke each valid profile; separately submit an unknown profile, whitespace-only task, and unsupported orchestration parameters. | Valid calls select exactly one profile; invalid calls fail before child launch. No chain, worker, or recursion path exists. | Automated schema/runner tests |
| AC2 | R1, R2 | Parent and previous child contain distinct sentinel messages; delegate a task containing a separate sentinel. Repeat with task text that resembles options and with a large task. | Child input contains the explicit task intact and required instructions only; neither history is forwarded, text is not interpreted as options/commands, and a fresh session is used each time. | Automated captured-launch/input tests |
| AC3 | R2, R3 | Configure project/user context files, skills, an extension that registers a mutating tool, and an unrelated MCP server. Start each profile. | Unrelated resources do not load or connect. Scout has exactly its four local tools; researcher has exactly the four Ketch tools, without indirect access to others. | Automated controlled-resource integration tests; inspect startup side effects and reachable tools |
| AC4 | R3, R11, R12 | Run representative local scouting in a fixture repo and web research with controlled content that includes instructions to edit files or delegate. | Repository snapshots remain unchanged; forbidden tools cannot be invoked; profile instructions explicitly treat retrieved text as data. This is not represented as proof of general prompt-injection immunity. | Tool-boundary tests, instruction review, and controlled integration checks |
| AC5 | R4, R11 | Parent Ketch tools are configured; call search/scrape/code/docs programmatically without delegation. Then launch a researcher. | Parent calls spawn no research child, provide structured MCP results, and leave unrelated parent tools/configuration intact; researcher uses the same Ketch server capabilities/configured backend choices. | Fake MCP contract tests plus explicit live smoke check during implementation verification |
| AC6 | R4, R9, R12 | Ketch executable/server, one required tool, or backend credentials are missing; separately return validation, upstream, and mixed per-URL failures. | Missing capabilities fail clearly rather than launching tool-less work; useful error distinctions and partial failures remain visible; nothing installs software or changes configuration automatically. | Automated failure injection; manual setup/error smoke check |
| AC7 | R5 | Dispatch with a parent model/thinking level, then profile overrides, an unsupported thinking level, and an unavailable model/credentials. | Correct precedence is used, thinking is clamped, and unavailable selection fails without silent provider/model fallback or authentication changes. | Automated selection tests and supported-runtime integration check |
| AC8 | R6, R12 | A child produces a normal cited report after many tool calls and several interim assistant messages. | Parent receives the final report with all final text blocks, not interim messages, reasoning, or tool transcript; report instructions request evidence and gaps. | Automated event/result tests; representative manual report review |
| AC9 | R6, R11 | A final report exceeds 12 KiB and contains multibyte text; separately make scratch-file retention fail. | Full report is retained outside the repo and survives run cleanup; returned excerpt/notice/path fit the UTF-8 byte cap. Storage failure is explicit, never a false preservation claim. | Automated boundary and filesystem-failure tests |
| AC10 | R7, R9 | With timeout unset, a responsive fake child continues beyond an arbitrary number of calls; then configure a short timeout for a stalled child. | No research-call/turn budget stops the first run. The second ends as timed out, never as a completed or fabricated partial report. Invalid timeout configuration is rejected. | Automated fake-clock/lifecycle tests |
| AC11 | R8, R10 | Submit more than two calls, cancel a queued call, complete a running call, then submit another. | At most two children run under the default; queued cancellation never launches; capacity is reusable and results/progress remain associated with their invocation. | Automated concurrency/race tests |
| AC12 | R8, R11 | Cancel one of two active children, including an unresponsive child with an owned MCP process; separately trigger startup failure and extension shutdown. | Target-owned work is cleaned up, slots/timers/listeners are released, and no indefinite orphan remains. The sibling and parent MCP connection remain usable except when shutdown intentionally ends all feature-owned runs. | Automated process-lifecycle tests and shutdown integration check |
| AC13 | R6, R9 | Process exits zero with terminal assistant error/abort, empty output, output-limit termination, or unfinished tool request; separately provide a substantive no-findings report. | Invalid/incomplete cases are not successful reports and diagnostics remain capped; the no-findings report succeeds. | Automated terminal-event fixtures |
| AC14 | R9 | Emit a recoverable error and low-level agent end, then successful recovery and final settlement; retry a separately failed delegation. | No premature completion/failure; eventual final answer is returned. Explicit retry creates a fresh child without old context. | Automated multi-event/retry fixtures |
| AC15 | R10 | Run queued, active, successful, failed, cancelled, and timed-out calls with and without a TUI. | Status/profile/task and basic activity are understandable in the UI; noninteractive results remain usable with the same semantics and without transcript injection. | Automated progress contract tests; manual TUI/non-TUI smoke checks |
| AC16 | R11, R12 | Snapshot user/repo configuration, credentials, parent model/thinking, and unrelated active tools; load the feature and run successful, failing, and cancelled requests. | Snapshotted configuration, credentials, model/thinking, and unrelated tool activations are unchanged. Intended research/Ketch/codemode activation and documented scratch/cache effects are allowed. No deployment, login, package installation, or automatic configuration repair is triggered. | Automated noninterference fixtures; manual setup review |

## Assumptions

The user explicitly accepted a tool-restricted rather than sandboxed boundary, and completion-driven research with cancellation and an optional safety timeout. The broader accepted direction is three fixed profiles plus native Ketch MCP capabilities, without recursive orchestration.

The following are inferred implementation baselines, not decisions individually approved in the interview:

- `subagent` is the tool name; two concurrent children, inherited models with profile overrides, a disabled-by-default safety timeout, 400–800-word guidance, and a 12 KiB result cap keep v1 simple. Confirm these as configurable/default behavior in planning; no additional interview is required unless implementation uncovers a consequential conflict.
- Parent delegation may be autonomous for multi-step investigations. This is guidance, not forced routing or a guarantee of when a model delegates; assess it using representative tasks.
- The parent uses codemode for Ketch while children receive direct Ketch declarations. The four core tools are sufficient initially. Validate actual availability and structured result behavior with Ketch v0.18.1 during implementation verification, not from discovery alone.
- Bundled profiles and suppressed automatic context-file loading are preferable to project customization for predictable context/tool isolation. The parent must put relevant project-specific constraints into the task.
- A Pi subprocess is the simplest reuse baseline, but strict child-only MCP loading and supported auth/model availability must be checked in the implementation plan. An in-process fresh session is acceptable if it preserves every boundary and avoids more complexity.
- Oversized final reports are retained as temporary private files for targeted recovery. This is an inferred overflow policy; no cross-session persistence, saved transcript browser, or artifact-management UI is implied.
- The target is the user's current Pi 1.1.0/Ketch v0.18.1 environment. Version prerequisites are documented rather than promising legacy compatibility or assuming Anthropic credentials.

## Risks and open decisions

- **Blocking:** None at specification time. Readiness authorizes planning only, not implementation or changes to user configuration.
- **Child MCP isolation:** Pi's configuration precedence and indirect tool exposure can defeat a naive allowlist. Planning must demonstrate how only Ketch connects and only selected tools are reachable. If the subprocess path cannot achieve this with supported APIs, choose an explicit isolated session configuration rather than weakening R2–R4.
- **Sensitive data/network access:** Scout can read files accessible to the account, and Ketch can fetch internal/private addresses. Cache writes and optional tagging also mean tool-restricted is not mutation-free. These are accepted boundary limitations, not claims of sandbox safety.
- **Unpredictable cost/latency:** No normal hard research budget exists. Narrow tasks, basic activity, cancellation, and the optional timeout mitigate but do not eliminate runaway expense.
- **Prompt injection and synthesis loss:** Remote text and local files can mislead the model, and a short report can omit decisive detail. Restricted tools, evidence references, explicit gaps, and targeted parent verification reduce exposure without guaranteeing correctness.
- **Retrieval bounds:** Ketch content/result bounds are requested through policy, not forcibly clamped. The delegation-result cap protects the parent after research; it does not bound child context growth or direct programmatic callers' chosen output.
- **Auth portability:** Ephemeral parent credentials or extension-registered providers may not exist in a child process. Fail transparently; do not load unrelated extensions or silently switch models to hide the problem.
- **Temporary reports:** Overflow files may contain sensitive findings and can expire with OS cleanup. They must be private and outside the repository; durable retention and automatic long-term cleanup policy are deferred.
- **External availability:** Discovery verified schemas only. Live backend auth, browser setup, output quality, and process cancellation remain implementation-verification obligations, not established facts.

## Deferred work

- Hard research budgets and graceful partial synthesis, if completion-driven runs prove too costly or slow.
- Enforced retrieval limits, URL/network restrictions, or bookmark-write prevention if instruction-level policy is insufficient.
- Crawl and durable bookmark tools if multi-page or repeated research warrants them.
- Reusable child sessions or persisted research artifacts if fresh invocations repeatedly duplicate work.
- Project-local profiles, dynamic registration, additional roles, or richer rendering only after the two-profile workflow demonstrates a concrete need.
- OS sandboxing, credential isolation, and cross-platform/version compatibility beyond the target environment as separately scoped work.
