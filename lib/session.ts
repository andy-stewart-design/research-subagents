import { readFile } from "node:fs/promises";
import { devNull } from "node:os";
import { isAbsolute, join } from "node:path";
import { InMemoryModelsStore, type CredentialStore, type ModelsStoreEntry, type Usage } from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, readStoredCredential,
  SessionManager, SettingsManager,
  type AgentSession, type CreateAgentSessionOptions, type ExtensionError,
  type McpExtensionOptions, type SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { selectModel, type DispatchDefaults, type ModelSelection, type ResearchConfig } from "./config.ts";
import { KETCH_TOOLS, createResearcherMcpExtension, waitForKetchCapabilities } from "./ketch.ts";
import {
  loadProfile, parseResearchInput, renderProfileSystemPrompt,
  type ProfileName, type ProfilePrompt, type ProfileRegistry,
} from "./profiles.ts";
import { createDiagnosticHandoff, createReportHandoff, type ReportHandoff } from "./report.ts";
import { createScoutTools, hasScoutBinary, requireScoutBinary, type ScoutBinaryCheck } from "./scout.ts";

export interface SessionToolCall {
  /** One-based position in the complete child run, retained when older calls are capped. */
  readonly index: number;
  /** A policy-approved tool name, or the bounded placeholder for an unknown tool. */
  readonly tool: string;
  /** A short, sanitized argument summary; tool output and reasoning are never included. */
  readonly summary?: string;
  /** Elapsed time from the child run start when execution began (not tool duration). */
  readonly elapsedMs: number;
}

export interface SessionActivity {
  readonly assistantMessages: number;
  readonly toolCalls: number;
  readonly latestTool?: string;
  readonly toolHistory?: readonly SessionToolCall[];
  readonly omittedToolCalls?: number;
}
export interface ResearchSessionOptions {
  readonly cwd: string;
  readonly workspaceDir: string;
  readonly agentDir: string;
  readonly config: ResearchConfig;
  readonly parent: DispatchDefaults;
  /** Discovery snapshot shared by schema, config, model selection, and this child. */
  readonly profileRegistry?: ProfileRegistry;
  /** Parent/user cancellation. Timeout is delivered separately and tagged on the compatibility signal. */
  readonly signal?: AbortSignal;
  /** Parent cancellation kept separate from the runner's tagged timeout wake-up. */
  readonly cancellationSignal?: AbortSignal;
  /** Soft deadline signal; queueing never consumes it. */
  readonly deadlineSignal?: AbortSignal;
  /** Effective per-run deadline after global/agent/call policy resolution; zero/undefined is unlimited. */
  readonly timeoutMs?: number;
  /** Production value is 30 seconds; tests inject a small deterministic grace. */
  readonly timeoutGraceMs?: number;
  /** Bound native abort/shutdown cleanup; production defaults to two seconds. */
  readonly cleanupTimeoutMs?: number;
  readonly scratchDir?: string;
  /** Runner-provided clock/start let activity timestamps share the run's elapsed-time origin. */
  readonly now?: () => number;
  readonly startedAt?: number;
  readonly onActivity?: (activity: SessionActivity) => void;
}
export interface SessionOutcome {
  readonly status: "completed" | "failed" | "cancelled" | "timed_out";
  /** Effective deadline metadata is retained on timeout outcomes. */
  readonly timeoutMs?: number;
  readonly handoff: ReportHandoff;
  readonly activity: SessionActivity;
  readonly usage?: Usage;
}

// A narrow SDK seam for deterministic fixtures, never supplied by model arguments.
export interface ChildSession extends Pick<AgentSession,
  "prompt" | "subscribe" | "bindExtensions" | "getAllTools" | "getActiveToolNames" |
  "getCallableToolNames" | "abort" | "dispose" | "model"
> {
  /** Pi 1.1 uses this to change the next model request's declared tools. */
  readonly setActiveToolsByName?: (toolNames: string[]) => void;
  readonly setActiveTools?: (toolNames: string[]) => void;
  readonly extensionRunner: { emit(event: SessionShutdownEvent): Promise<void> };
}
export interface SessionServices {
  createModelRuntime(agentDir: string, selection: ModelSelection, signal?: AbortSignal): Promise<ModelRuntime>;
  createSession(options: CreateAgentSessionOptions): Promise<{ session: ChildSession; modelFallbackMessage?: string }>;
  readonly mcpOptions?: Pick<McpExtensionOptions, "createTransport" | "logPath">;
  readonly startupTimeoutMs?: number;
  hasScoutBinary: ScoutBinaryCheck;
  /** Injectable profile loader for isolated tests and hosts with a profile source of truth. */
  loadProfile?: (name: ProfileName) => ProfilePrompt;
}

/** Read normal configuration through native services, without creating/updating auth or catalog files. */
export async function createChildModelRuntime(agentDir: string, selection: ModelSelection, signal?: AbortSignal): Promise<ModelRuntime> {
  signal?.throwIfAborted();
  if (!isAbsolute(agentDir)) throw new Error("Child model runtime requires an absolute agent directory.");
  const authPath = join(agentDir, "auth.json");
  const stored = readStoredCredential(selection.provider, authPath);
  // AuthStorage normally resolves these strings. Reuse the native provider-config resolver instead
  // of implementing credential commands/interpolation or giving a child a writable auth store.
  const configuredKey = stored?.type === "api_key" && stored.key &&
    (stored.key.startsWith("!") || stored.key.includes("$")) ? stored.key : undefined;
  let keyResolver: ModelRuntime | undefined;
  let resolvedKey: Promise<string> | undefined;
  if (configuredKey) {
    // A metadata-only provider gives us the public native config-value resolver without
    // provider-specific auth transformations. It never makes a model request.
    keyResolver = await ModelRuntime.create({
      modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false,
      credentials: { read: async () => undefined, list: async () => [],
        modify: async () => { throw new Error("Read-only credentials"); }, delete: async () => { throw new Error("Read-only credentials"); } },
    });
    signal?.throwIfAborted();
    keyResolver.registerProvider("research-credential", {
      api: "openai-completions", baseUrl: "https://unused.invalid", apiKey: configuredKey,
    });
  }
  const credentials: CredentialStore = {
    async read(provider, options) {
      options?.signal?.throwIfAborted();
      if (provider !== selection.provider) return undefined;
      const value = readStoredCredential(provider, authPath);
      if (keyResolver && value?.type === "api_key") {
        resolvedKey ??= keyResolver.getAuth("research-credential", {
          ...(value.env ? { env: value.env } : {}), ...(options?.signal ? { signal: options.signal } : {}),
        }).then((result) => {
          if (!result?.auth.apiKey) throw new Error("Configured child credential could not be resolved.");
          return result.auth.apiKey;
        });
        return { ...value, key: await resolvedKey };
      }
      return value;
    },
    async list(options) {
      options?.signal?.throwIfAborted();
      const value = readStoredCredential(selection.provider, authPath);
      return value ? [{ providerId: selection.provider, type: value.type }] : [];
    },
    async modify() { throw new Error("Research children cannot refresh/change authentication. Refresh credentials in the parent and retry."); },
    async delete() { throw new Error("Research children cannot change authentication."); },
  };
  const modelsStore = new InMemoryModelsStore();
  // Restore the target version's cached catalog into private memory, not its writable FileModelsStore.
  const cachePath = join(agentDir, "models-store.json");
  let cache: string | undefined;
  try { cache = await readFile(cachePath, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Unable to read model cache ${cachePath}.`); }
  if (cache !== undefined) {
    try {
      const data = JSON.parse(cache.replace(/^\uFEFF/u, "")) as Record<string, ModelsStoreEntry>;
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid cache");
      const entry = Object.hasOwn(data, selection.provider) ? data[selection.provider] : undefined;
      if (entry !== undefined) {
        if (!Array.isArray(entry.models)) throw new Error("Invalid cache entry");
        await modelsStore.write(selection.provider, entry);
      }
    } catch { throw new Error(`Invalid model cache ${cachePath}.`); }
  }
  signal?.throwIfAborted();
  const runtime = await ModelRuntime.create({
    credentials, modelsStore, modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false, refreshOnCreate: false, ...(signal ? { signal } : {}),
  });
  await runtime.refresh({ providers: [selection.provider], allowNetwork: false, ...(signal ? { signal } : {}) });
  return runtime;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown child-session error.";
}

/** Internal marker used to wake compatibility runners without treating a deadline as cancellation. */
export interface ResearchTimeoutAbortReason { readonly researchTimeout: true; readonly message?: string }
export function isResearchTimeoutAbortReason(reason: unknown): reason is ResearchTimeoutAbortReason {
  return !!reason && typeof reason === "object" && (reason as { researchTimeout?: unknown }).researchTimeout === true;
}

function finalAssistant(history: SessionManager): { text?: string; valid: boolean; aborted?: boolean } {
  const entry = history.getBranch().findLast((candidate) => candidate.type === "message" && candidate.message.role !== "system");
  const message = entry?.type === "message" ? entry.message : undefined;
  if (!message || message.role !== "assistant") return { valid: false };
  if (message.stopReason !== "stop" || message.content.some((part) => part.type === "toolCall")) {
    return { valid: false, aborted: message.stopReason === "aborted" };
  }
  const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  return { valid: !!text.trim(), text };
}

/** Keep the activity side channel useful without making it a transcript or an unbounded store. */
export const MAX_TOOL_HISTORY = 50;
export const MAX_TOOL_SUMMARY = 120;

function truncateSummary(value: string, limit = MAX_TOOL_SUMMARY): string {
  if (limit <= 0) return "";
  const characters = Array.from(value);
  return characters.length <= limit
    ? value
    : `${characters.slice(0, limit - 1).join("")}…`;
}

function safeSummaryPart(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // Keep the existing side-channel privacy posture: obvious credential/private sentinels are
  // not made visible merely because they arrived in an otherwise displayable argument.
  if (/(?:secret|token|password|credential|private)/iu.test(value)) return undefined;
  const clean = stripTerminalSequences(value).replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  return clean ? truncateSummary(clean) : undefined;
}

function arraySummary(values: readonly unknown[]): string | undefined {
  let summary = "";
  for (const value of values) {
    const part = safeSummaryPart(value);
    if (!part) continue;
    const separator = summary ? ", " : "";
    const remaining = MAX_TOOL_SUMMARY - Array.from(summary).length - separator.length;
    if (remaining <= 0) break;
    if (Array.from(part).length > remaining) {
      summary += separator + truncateSummary(part, remaining);
      break;
    }
    summary += separator + part;
  }
  return summary || undefined;
}

function argumentSummary(toolName: string, args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const values = args as Record<string, unknown>;
  // These names mirror Pi 1.1.0's local tool schemas and Ketch v0.18.1's MCP schemas:
  // grep/find use pattern, search/code/docs use query, and scrape uses url or urls.
  const keys = toolName === "bash" ? ["command"]
    : ["read", "write", "edit", "ls"].includes(toolName) ? ["path"]
    : toolName === "grep" ? ["pattern", "path"]
    : toolName === "find" ? ["pattern", "path"]
    : toolName === "mcp__ketch__scrape" ? ["url", "urls"]
    : ["mcp__ketch__search", "mcp__ketch__code", "mcp__ketch__docs"].includes(toolName) ? ["query"]
    : [];
  for (const key of keys) {
    const value = values[key];
    const summary = Array.isArray(value) ? arraySummary(value) : safeSummaryPart(value);
    if (summary) return summary;
  }
  return undefined;
}

function activitySnapshot(activity: SessionActivity): SessionActivity {
  return {
    ...activity,
    ...(activity.toolHistory ? { toolHistory: activity.toolHistory.map((call) => ({ ...call })) } : {}),
  };
}

function collectUsage(history: SessionManager): Usage | undefined {
  let total: Usage | undefined;
  for (const entry of history.getEntries()) {
    const usage = entry.type === "message"
      ? (entry.message.role === "assistant" || entry.message.role === "toolResult" ? entry.message.usage : undefined)
      : (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary" ? entry.usage : undefined);
    if (!usage) continue;
    // Optional billing metadata must not turn a valid report into an uncaught exception or
    // silently return partial/invented totals when a provider supplies malformed usage.
    if (!usage.cost || [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens,
      usage.reasoning ?? 0, usage.cacheWrite1h ?? 0, usage.cost.input, usage.cost.output,
      usage.cost.cacheRead, usage.cost.cacheWrite, usage.cost.total,
    ].some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) return undefined;
    total ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) total[key] += usage[key];
    for (const key of ["reasoning", "cacheWrite1h"] as const) {
      if (usage[key] !== undefined) total[key] = (total[key] ?? 0) + usage[key];
    }
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) total.cost[key] += usage.cost[key];
  }
  return total;
}

/** One fresh invocation. Shared capacity, deadlines, and parent-shutdown ownership belong to the runner. */
export async function runResearchSession(
  input: unknown, options: ResearchSessionOptions, overrides: Partial<SessionServices> = {},
): Promise<SessionOutcome> {
  const services: SessionServices = { createModelRuntime: createChildModelRuntime, createSession: createAgentSession, hasScoutBinary, ...overrides };
  const { signal, cancellationSignal, deadlineSignal, cwd, agentDir, workspaceDir, scratchDir, onActivity } = options;
  const now = options.now ?? Date.now;
  const startedAt = options.startedAt ?? now();
  let session: ChildSession | undefined;
  let sessionCreation: Promise<{ session: ChildSession; modelFallbackMessage?: string }> | undefined;
  let history: SessionManager | undefined;
  let unsubscribe: (() => void) | undefined;
  let closePromise: Promise<void> | undefined;
  let noSessionClosePromise: Promise<void> | undefined;
  let resolveNoSessionClose: (() => void) | undefined;
  let noSessionCloseTimer: ReturnType<typeof setTimeout> | undefined;
  let lifecycleError: string | undefined;
  const cleanupErrors: string[] = [];
  let closing = false;
  let activity: SessionActivity = { assistantMessages: 0, toolCalls: 0 };
  let ketchCalls = 0;
  let failure: string | undefined;
  let report: string | undefined;
  let interrupted = false;
  let timedOut = false;
  let timeoutHandoff: ReportHandoff | undefined;
  let primaryOperation: Promise<void> | undefined;
  let startupOperation: Promise<void> | undefined;
  let runtimeForHandoff: ModelRuntime | undefined;
  let timeoutWorkflow: Promise<void> | undefined;
  let resolveTimeoutDone: (() => void) | undefined;
  const timeoutDone = new Promise<void>((resolve) => { resolveTimeoutDone = resolve; });
  let resolveCancellation: (() => void) | undefined;
  const cancellation = new Promise<void>((resolve) => { resolveCancellation = resolve; });
  let abortPromise: Promise<void> | undefined;
  let timeoutStarted = false;
  let closeRequested = false;
  const graceMs = options.timeoutGraceMs ?? 30_000;
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 2_000;
  const lateStartupWaitMs = Math.min(cleanupTimeoutMs, 100);
  const onError = (error: ExtensionError) => {
    const message = `${error.event ?? "extension"}: ${error.error}`;
    if (closing) cleanupErrors.push(message);
    else lifecycleError ??= message;
  };
  const requestAbort = (): Promise<void> => {
    if (!session) return Promise.resolve();
    return abortPromise ??= Promise.resolve().then(() => session!.abort());
  };
  const close = (): Promise<void> => {
    // Cancellation/timeout can arrive before createSession resolves. Mark ownership immediately;
    // the late-created session is closed by the assignment below rather than leaked.
    const waitingForLateResource = closeRequested;
    closeRequested = true;
    if (!session) {
      if (!waitingForLateResource) return Promise.resolve();
      noSessionClosePromise ??= new Promise<void>((resolve) => {
        resolveNoSessionClose = resolve;
        noSessionCloseTimer = setTimeout(resolve, lateStartupWaitMs);
      });
      return noSessionClosePromise;
    }
    const ownedClose = closePromise ??= (async () => {
      closing = true;
      const owned = session!;
      // Start abort/idle concurrently with shutdown: closing MCP can unblock outstanding tools.
      const cleanup = Promise.allSettled([
        requestAbort(),
        Promise.resolve().then(() => owned.extensionRunner.emit({ type: "session_shutdown", reason: "quit" })),
      ]);
      let cleanupResults: PromiseSettledResult<void>[] | undefined;
      const observed = cleanup.then((results) => { cleanupResults = results; });
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      const cleanupDeadline = new Promise<void>((resolve) => { cleanupTimer = setTimeout(resolve, cleanupTimeoutMs); });
      await Promise.race([observed, cleanupDeadline]);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      if (!cleanupResults) cleanupErrors.push("Owned child cleanup remained pending; process termination is uncertain.");
      for (const result of cleanupResults ?? []) if (result.status === "rejected") cleanupErrors.push(errorText(result.reason));
      try { unsubscribe?.(); } catch (error) { cleanupErrors.push(errorText(error)); }
      try { owned.dispose(); } catch (error) { cleanupErrors.push(errorText(error)); }
    })();
    void ownedClose.then(() => {
      if (noSessionCloseTimer) clearTimeout(noSessionCloseTimer);
      resolveNoSessionClose?.();
      resolveNoSessionClose = undefined;
    }, () => {
      if (noSessionCloseTimer) clearTimeout(noSessionCloseTimer);
      resolveNoSessionClose?.();
      resolveNoSessionClose = undefined;
    });
    return ownedClose;
  };
  const onCancellation = () => {
    if (interrupted) return;
    interrupted = true;
    closeRequested = true;
    resolveCancellation?.();
    void close();
  };
  const onAbort = () => {
    if (isResearchTimeoutAbortReason(signal?.reason)) { beginTimeout(); return; }
    onCancellation();
  };
  // Assigned below, but listeners can fire during startup.
  let beginTimeout: () => void = () => { timedOut = true; };
  const timeoutFallback = (reason: string): ReportHandoff => createDiagnosticHandoff(
    `Research timed out; incomplete work is not a completed report. ${reason} ` +
    `Last active tool: ${activity.latestTool ?? "none"}. The original operation may still be running; ` +
    `files and verification state are uncertain. Do not assume late work completed.`,
  );
  const disableTools = (): boolean => {
    if (!session) return false;
    try {
      if (session.setActiveToolsByName) session.setActiveToolsByName([]);
      else if (session.setActiveTools) session.setActiveTools([]);
      else return false;
      return session.getActiveToolNames().length === 0 && session.getCallableToolNames().length === 0;
    } catch (error) {
      cleanupErrors.push(`Unable to disable child tools for timeout handoff: ${errorText(error)}`);
      return false;
    }
  };
  const handleTimeout = async (): Promise<void> => {
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<"grace">((resolve) => { graceTimer = setTimeout(() => resolve("grace"), graceMs); });
    try {
      if (!session || !primaryOperation) {
        const first = await Promise.race([grace, cancellation.then(() => "cancelled" as const)]);
        if (first !== "cancelled" && !interrupted) timeoutHandoff = timeoutFallback("The child was interrupted before its original operation settled; termination is unconfirmed.");
        return;
      }
      // Start abort before waiting. The grace deadline covers abort, settlement, summary, and
      // persistence rather than only the final model request.
      const abort = requestAbort().then(() => "settled" as const, () => "abort_failed" as const);
      const operation = primaryOperation.then(() => "settled" as const, () => "operation_failed" as const);
      const first = await Promise.race([
        Promise.all([operation, abort]).then(([, abortResult]) => abortResult === "abort_failed" ? "abort_failed" as const : "settled" as const),
        grace,
        cancellation.then(() => "cancelled" as const),
      ]);
      if (first === "cancelled" || interrupted) return;
      if (first !== "settled") {
        timeoutHandoff = timeoutFallback(first === "abort_failed" ? "Abort/idle did not settle during the grace period; operation termination is unconfirmed." : "Grace period expired before the child became idle; operation termination is unconfirmed.");
        return;
      }
      if (!disableTools()) {
        timeoutHandoff = timeoutFallback("The SDK could not make every model and callable tool unavailable.");
        return;
      }
      let restoreSummaryRuntime: (() => void) | undefined;
      try {
        // Pi 1.1 has no per-prompt option on AgentSession, but the session dispatches through its
        // child-owned ModelRuntime. Scope a real provider maxTokens cap to this tool-free request.
        const runtime = runtimeForHandoff;
        if (runtime) {
          const original = runtime.streamSimple;
          runtime.streamSimple = function(this: ModelRuntime, model, context, requestOptions) {
            const { reasoning: _reasoning, ...withoutReasoning } = requestOptions ?? {};
            return original.call(this, model, context, {
              ...withoutReasoning, maxTokens: Math.min(requestOptions?.maxTokens ?? 1024, 1024),
            });
          };
          restoreSummaryRuntime = () => { runtime.streamSimple = original; };
        }
        const summaryRequest = session.prompt(
          "The prior research operation timed out and is now settled. Produce ONE concise, tool-free incomplete handoff (no tools are available). Include exactly: completed work and files changed; unfinished/current work; actual verification including failures or unverified changes; any operation that might still be running; blockers and next steps. State uncertainty plainly. Keep it under 1200 words and do not retry or perform more work.",
          { expandPromptTemplates: false, source: "extension" },
        );
        const summaryFinished = await Promise.race([
          summaryRequest.then(() => true, (error) => { throw error; }),
          grace.then(() => false),
          cancellation.then(() => "cancelled" as const),
        ]);
        restoreSummaryRuntime?.(); restoreSummaryRuntime = undefined;
        if (summaryFinished === "cancelled" || interrupted) return;
        if (!summaryFinished) {
          timeoutHandoff = timeoutFallback("Grace period expired while producing the timeout summary; operation termination is unconfirmed.");
          return;
        }
        const summary = history ? finalAssistant(history) : { valid: false as const };
        if (!summary.valid || !summary.text) throw new Error("summary did not produce one bounded final assistant answer");
        const savedPromise = createReportHandoff(
          `Research timed out; incomplete handoff.\n\n${summary.text}`,
          { workspaceDir, ...(scratchDir !== undefined ? { scratchDir } : {}), forcePersist: true },
        );
        const saved = await Promise.race([
          savedPromise,
          grace.then(() => undefined),
          cancellation.then(() => "cancelled" as const),
        ]);
        if (saved === "cancelled" || interrupted) return;
        if (!saved) {
          timeoutHandoff = timeoutFallback("Grace period expired while persisting the timeout handoff; operation termination is unconfirmed.");
          return;
        }
        timeoutHandoff = saved.isError
          ? timeoutFallback(`Persisting the bounded timeout handoff failed: ${saved.text}`)
          : { ...saved, isError: true };
      } catch (error) {
        timeoutHandoff = timeoutFallback(`Tool-free timeout summary failed: ${errorText(error)}`);
      } finally {
        restoreSummaryRuntime?.();
      }
    } finally {
      if (graceTimer) clearTimeout(graceTimer);
    }
  };
  beginTimeout = () => {
    // An explicit cancellation that was already ready wins over a timeout
    // handoff, including when both signals are pre-aborted.
    if (timeoutStarted || interrupted) return;
    timeoutStarted = true;
    timedOut = true;
    timeoutWorkflow = handleTimeout().finally(() => resolveTimeoutDone?.());
  };
  const onDeadline = () => beginTimeout();
  signal?.addEventListener("abort", onAbort, { once: true });
  cancellationSignal?.addEventListener("abort", onCancellation, { once: true });
  deadlineSignal?.addEventListener("abort", onDeadline, { once: true });
  // AbortSignal does not replay an earlier abort to a newly-added listener.
  // Process ready signals synchronously so startup cannot wait forever for the
  // cancellation promise, and let explicit cancellation win over a handoff.
  if (cancellationSignal?.aborted) onCancellation();
  if (isResearchTimeoutAbortReason(signal?.reason)) onAbort();
  if (deadlineSignal?.aborted) onDeadline();
  if (signal?.aborted && !isResearchTimeoutAbortReason(signal.reason)) onAbort();
  try {
    startupOperation = (async () => {
    signal?.throwIfAborted();
    if (interrupted || cancellationSignal?.aborted || timedOut || deadlineSignal?.aborted) {
      throw new Error(interrupted ? "Research cancelled before startup." : "Research interrupted before startup.");
    }
    const { agent, task } = parseResearchInput(input, options.profileRegistry);
    const loadedProfile = overrides.loadProfile
      ? overrides.loadProfile(agent)
      : loadProfile(agent, options.profileRegistry);
    const profilePrompt = renderProfileSystemPrompt(loadedProfile);
    const selectedTools = loadedProfile.tools;
    const profileDefaults = loadedProfile.defaults;
    const selectedKetchTools = selectedTools.filter((tool) => KETCH_TOOLS.includes(tool));
    for (const path of [cwd, agentDir, workspaceDir]) {
      if (!isAbsolute(path)) throw new Error("Research session requires absolute workspace, cwd, and agent directory paths.");
    }
    if (selectedTools.includes("grep")) requireScoutBinary("rg", services.hasScoutBinary);
    if (selectedTools.includes("find")) requireScoutBinary("fd", services.hasScoutBinary);
    const selection = selectModel(agent, options.config, options.parent, profileDefaults, options.profileRegistry);
    const runtime = await services.createModelRuntime(agentDir, selection, signal);
    runtimeForHandoff = runtime;
    signal?.throwIfAborted();
    const modelError = runtime.getError();
    if (modelError) throw new Error(`Child model configuration failed: ${modelError}`);
    const model = runtime.getModel(selection.provider, selection.modelId);
    if (!model || model.provider !== selection.provider || model.id !== selection.modelId) {
      throw new Error(`Selected model ${selection.provider}/${selection.modelId} is unavailable in the child. Parent-only providers are not inherited; no fallback was selected.`);
    }
    const available = await runtime.getAvailable(selection.provider, signal ? { signal } : {});
    if (!available.some((candidate) => candidate.provider === model.provider && candidate.id === model.id)) {
      throw new Error(`Selected model ${model.provider}/${model.id} has no usable child credentials or is unavailable. Configure it in Pi before retrying; no fallback was selected.`);
    }
    try {
      if (!await runtime.getAuth(model, signal ? { signal } : {})) throw new Error("No request authentication");
    } catch {
      signal?.throwIfAborted();
      throw new Error(`Cannot resolve credentials for ${model.provider}/${model.id}. Refresh/sign in from the parent if needed and retry; children do not change authentication.`);
    }
    signal?.throwIfAborted();
    const settingsManager = SettingsManager.inMemory({
      defaultTools: [...selectedTools], cacheWarming: "off", enableSkillCommands: false,
      packages: [], extensions: [], skills: [], prompts: [], themes: [], enableInstallTelemetry: false,
    });
    history = SessionManager.inMemory(cwd);
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: profilePrompt, appendSystemPrompt: [],
      extensionFactories: selectedKetchTools.length
        ? [createResearcherMcpExtension({ logPath: devNull, ...services.mcpOptions, tools: selectedKetchTools })] : [],
    });
    await resourceLoader.reload();
    const loadErrors = resourceLoader.getExtensions().errors;
    if (loadErrors.length) throw new Error(`Child extension loading failed: ${loadErrors.map((error) => error.error).join("; ")}`);
    signal?.throwIfAborted();
    sessionCreation = services.createSession({
      cwd, agentDir, modelRuntime: runtime, model,
      ...(selection.thinkingLevel !== undefined ? { thinkingLevel: selection.thinkingLevel } : {}),
      tools: [...selectedTools], settingsManager, sessionManager: history, resourceLoader,
      ...((selectedTools.includes("grep") || selectedTools.includes("find"))
        ? { customTools: createScoutTools(cwd, services.hasScoutBinary, selectedTools) } : {}),
    });
    const created = await sessionCreation;
    session = created.session;
    if (closeRequested) { await close(); return; }
    signal?.throwIfAborted();
    if (created.modelFallbackMessage || session.model?.provider !== selection.provider || session.model.id !== selection.modelId) {
      throw new Error("Child SDK did not retain the exact selected model; refusing fallback.");
    }
    unsubscribe = session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        activity = { ...activity, assistantMessages: activity.assistantMessages + 1 };
      } else if (event.type === "tool_execution_start") {
        const knownTool = selectedTools.includes(event.toolName);
        if (knownTool && selectedKetchTools.includes(event.toolName)) ketchCalls++;
        const tool = knownTool ? event.toolName : "unavailable tool";
        const index = activity.toolCalls + 1;
        const previous = activity.toolHistory ?? [];
        const call: SessionToolCall = {
          index,
          tool,
          elapsedMs: Math.max(0, now() - startedAt),
          ...(knownTool ? (() => {
            const summary = argumentSummary(event.toolName, event.args);
            return summary ? { summary } : {};
          })() : {}),
        };
        const history = [...previous, call];
        activity = {
          ...activity,
          toolCalls: index,
          latestTool: tool,
          toolHistory: history.length > MAX_TOOL_HISTORY ? history.slice(-MAX_TOOL_HISTORY) : history,
          ...(history.length > MAX_TOOL_HISTORY ? { omittedToolCalls: index - MAX_TOOL_HISTORY } : {}),
        };
      } else return;
      try { onActivity?.(activitySnapshot(activity)); }
      catch (error) { lifecycleError ??= `Activity callback failed: ${errorText(error)}`; }
    });
    await session.bindExtensions({ onError });
    if (selectedKetchTools.length) {
      await waitForKetchCapabilities({ getAllTools: () => session!.getAllTools(), getActiveTools: () => session!.getActiveToolNames() }, {
        mode: "researcher", tools: selectedKetchTools, allowedTools: selectedTools, ...(signal ? { signal } : {}),
        ...(services.startupTimeoutMs !== undefined ? { timeoutMs: services.startupTimeoutMs } : {}),
      });
    }
    const active = session.getActiveToolNames();
    const callable = session.getCallableToolNames();
    if ([active, callable].some((names) => names.length !== selectedTools.length || names.some((name) => !selectedTools.includes(name)))) {
      throw new Error(`Child ${agent} tools do not match its exact policy.`);
    }
    signal?.throwIfAborted();
    if (lifecycleError) throw new Error(`Child extension failed: ${lifecycleError}`);
    if (timedOut || interrupted || cancellationSignal?.aborted || deadlineSignal?.aborted) {
      throw new Error("Research interrupted before the child operation could start.");
    }
    // The fixed prefix is defense in depth; false also disables extension/skill/template commands.
    // Task bytes after the prefix are unchanged, including leading slashes, @paths, and whitespace.
    primaryOperation = session.prompt(`Subagent task (literal data):\n\n${task}`, { expandPromptTemplates: false, source: "extension" });
    // Always attach a rejection handler: a late provider/tool result after timeout must not become
    // an unhandled rejection or mutate the already irreversible timed-out outcome.
    await Promise.race([
      primaryOperation.then(() => undefined, (error) => { failure = errorText(error); }),
      cancellation,
      timeoutDone,
    ]);
    if (timedOut) {
      await timeoutWorkflow;
    } else if (interrupted || signal?.aborted) {
      // Explicit cancellation skips every handoff, including while timeout grace is active.
      throw new Error("Research cancelled; no completed report is claimed.");
    } else {
      if (lifecycleError) throw new Error(`Child extension failed: ${lifecycleError}`);
      const final = finalAssistant(history);
      if (final.aborted) interrupted = true;
      if (!final.valid || !final.text) throw new Error("Child finished without a final assistant answer.");
      report = final.text;
      if (agent === "researcher" && selectedKetchTools.length && ketchCalls === 0) {
        throw new Error("Researcher finished without using an external Ketch lookup; no sourced report is claimed. Use scout for local repository work.");
      }
    }
    })();
    // Startup includes model/catalog/auth loading, extension readiness, session creation, and
    // submission. Never let an SDK promise that ignores AbortSignal pin the runner indefinitely.
    await Promise.race([startupOperation, cancellation, timeoutDone]);
  } catch (error) {
    failure = errorText(error);
  } finally {
    // Timeout handoff persistence happens in handleTimeout before this disposal boundary.
    await close();
    // If createSession ignored cancellation, give its late result one bounded opportunity to reach
    // the ownership assignment and disposal path. Do not wait on arbitrary startup promises.
    if (!session && sessionCreation) {
      const lateClose = sessionCreation.then((created) => {
        session = created.session;
        return close();
      }, () => undefined);
      await Promise.race([
        lateClose,
        new Promise<void>((resolve) => setTimeout(resolve, cleanupTimeoutMs)),
      ]);
    }
    signal?.removeEventListener("abort", onAbort);
    cancellationSignal?.removeEventListener("abort", onCancellation);
    deadlineSignal?.removeEventListener("abort", onDeadline);
  }
  const usage = history ? collectUsage(history) : undefined;
  const cleanup = cleanupErrors.length ? ` Cleanup failed: ${cleanupErrors.join("; ")}` : "";
  const addTimeoutCleanup = (handoff: ReportHandoff): ReportHandoff => {
    if (!cleanup) return { ...handoff, isError: true };
    const diagnostic = createDiagnosticHandoff(`${handoff.text}\n\n${cleanup} Operation termination is unconfirmed.`);
    return { ...handoff, text: diagnostic.text, truncated: diagnostic.truncated, isError: true };
  };
  if ((signal?.aborted && !isResearchTimeoutAbortReason(signal.reason)) || interrupted) {
    return { status: "cancelled", handoff: createDiagnosticHandoff(`Research cancelled; no completed report is claimed.${cleanup}`), activity, ...(usage ? { usage } : {}) };
  }
  if (timedOut) {
    const handoff = addTimeoutCleanup(timeoutHandoff ?? timeoutFallback(
      `${failure ?? "No safe timeout handoff was produced."}${cleanup}`,
    ));
    return {
      status: "timed_out", handoff, activity,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(usage ? { usage } : {}),
    };
  }
  if (signal?.aborted) {
    return { status: "cancelled", handoff: createDiagnosticHandoff(`Research cancelled; no completed report is claimed.${cleanup}`), activity, ...(usage ? { usage } : {}) };
  }
  if (failure || lifecycleError || cleanup || report === undefined) {
    return { status: "failed", handoff: createDiagnosticHandoff(`Research failed: ${failure ?? lifecycleError ?? (cleanup ? "child cleanup did not complete cleanly" : "no completed report")}.${cleanup}`), activity, ...(usage ? { usage } : {}) };
  }
  const handoff = await createReportHandoff(report, {
    workspaceDir, ...(scratchDir !== undefined ? { scratchDir } : {}),
  });
  return { status: handoff.isError ? "failed" : "completed", handoff, activity, ...(usage ? { usage } : {}) };
}
