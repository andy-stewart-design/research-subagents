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
import { selectModel, type DispatchDefaults, type ModelSelection, type ResearchConfig } from "./config.ts";
import { createResearcherMcpExtension, waitForKetchCapabilities } from "./ketch.ts";
import { getProfile, loadProfilePrompt, parseResearchInput } from "./profiles.ts";
import { createDiagnosticHandoff, createReportHandoff, type ReportHandoff } from "./report.ts";
import { createScoutTools, hasScoutBinary, requireScoutBinary, type ScoutBinaryCheck } from "./scout.ts";

export interface SessionActivity {
  readonly assistantMessages: number;
  readonly toolCalls: number;
  readonly latestTool?: string;
}
export interface ResearchSessionOptions {
  readonly cwd: string;
  readonly workspaceDir: string;
  readonly agentDir: string;
  readonly config: ResearchConfig;
  readonly parent: DispatchDefaults;
  readonly signal?: AbortSignal;
  readonly scratchDir?: string;
  readonly onActivity?: (activity: SessionActivity) => void;
}
export interface SessionOutcome {
  readonly status: "completed" | "failed" | "cancelled";
  readonly handoff: ReportHandoff;
  readonly activity: SessionActivity;
  readonly usage?: Usage;
}

// A narrow SDK seam for deterministic fixtures, never supplied by model arguments.
export interface ChildSession extends Pick<AgentSession,
  "prompt" | "subscribe" | "bindExtensions" | "getAllTools" | "getActiveToolNames" |
  "getCallableToolNames" | "abort" | "dispose" | "model"
> {
  readonly extensionRunner: { emit(event: SessionShutdownEvent): Promise<void> };
}
export interface SessionServices {
  createModelRuntime(agentDir: string, selection: ModelSelection, signal?: AbortSignal): Promise<ModelRuntime>;
  createSession(options: CreateAgentSessionOptions): Promise<{ session: ChildSession; modelFallbackMessage?: string }>;
  readonly mcpOptions?: Pick<McpExtensionOptions, "createTransport" | "logPath">;
  readonly startupTimeoutMs?: number;
  hasScoutBinary: ScoutBinaryCheck;
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
  const { signal, cwd, agentDir, workspaceDir, scratchDir, onActivity } = options;
  let session: ChildSession | undefined;
  let history: SessionManager | undefined;
  let unsubscribe: (() => void) | undefined;
  let closePromise: Promise<void> | undefined;
  let lifecycleError: string | undefined;
  const cleanupErrors: string[] = [];
  let closing = false;
  let activity: SessionActivity = { assistantMessages: 0, toolCalls: 0 };
  let failure: string | undefined;
  let report: string | undefined;
  let interrupted = false;
  const onError = (error: ExtensionError) => {
    const message = `${error.event ?? "extension"}: ${error.error}`;
    if (closing) cleanupErrors.push(message);
    else lifecycleError ??= message;
  };
  const close = (): Promise<void> => {
    // Cancellation may arrive before createSession resolves. Do not memoize a no-session close.
    if (!session) return Promise.resolve();
    return closePromise ??= (async () => {
      closing = true;
      const owned = session!;
      // Start abort/idle concurrently with shutdown: closing MCP can unblock outstanding tools.
      const results = await Promise.allSettled([
        Promise.resolve().then(() => owned.abort()),
        Promise.resolve().then(() => owned.extensionRunner.emit({ type: "session_shutdown", reason: "quit" })),
      ]);
      for (const result of results) if (result.status === "rejected") cleanupErrors.push(errorText(result.reason));
      try { unsubscribe?.(); } catch (error) { cleanupErrors.push(errorText(error)); }
      try { owned.dispose(); } catch (error) { cleanupErrors.push(errorText(error)); }
    })();
  };
  const onAbort = () => { interrupted = true; void close(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    signal?.throwIfAborted();
    const { agent, task } = parseResearchInput(input);
    const profile = getProfile(agent);
    for (const path of [cwd, agentDir, workspaceDir]) {
      if (!isAbsolute(path)) throw new Error("Research session requires absolute workspace, cwd, and agent directory paths.");
    }
    if (agent === "scout") {
      requireScoutBinary("rg", services.hasScoutBinary);
      requireScoutBinary("fd", services.hasScoutBinary);
    }
    const selection = selectModel(agent, options.config, options.parent);
    const runtime = await services.createModelRuntime(agentDir, selection, signal);
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
      defaultTools: [...profile.tools], cacheWarming: "off", enableSkillCommands: false,
      packages: [], extensions: [], skills: [], prompts: [], themes: [], enableInstallTelemetry: false,
    });
    history = SessionManager.inMemory(cwd);
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: loadProfilePrompt(agent), appendSystemPrompt: [],
      extensionFactories: agent === "researcher"
        ? [createResearcherMcpExtension({ logPath: devNull, ...services.mcpOptions })] : [],
    });
    await resourceLoader.reload();
    const loadErrors = resourceLoader.getExtensions().errors;
    if (loadErrors.length) throw new Error(`Child extension loading failed: ${loadErrors.map((error) => error.error).join("; ")}`);
    signal?.throwIfAborted();
    const created = await services.createSession({
      cwd, agentDir, modelRuntime: runtime, model,
      ...(selection.thinkingLevel !== undefined ? { thinkingLevel: selection.thinkingLevel } : {}),
      tools: [...profile.tools], settingsManager, sessionManager: history, resourceLoader,
      ...(agent === "scout" ? { customTools: createScoutTools(cwd, services.hasScoutBinary) } : {}),
    });
    session = created.session;
    signal?.throwIfAborted();
    if (created.modelFallbackMessage || session.model?.provider !== selection.provider || session.model.id !== selection.modelId) {
      throw new Error("Child SDK did not retain the exact selected model; refusing fallback.");
    }
    unsubscribe = session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        activity = { ...activity, assistantMessages: activity.assistantMessages + 1 };
      } else if (event.type === "tool_execution_start") {
        activity = { ...activity, toolCalls: activity.toolCalls + 1, latestTool: profile.tools.includes(event.toolName) ? event.toolName : "unavailable tool" };
      } else return;
      try { onActivity?.({ ...activity }); }
      catch (error) { lifecycleError ??= `Activity callback failed: ${errorText(error)}`; }
    });
    await session.bindExtensions({ onError });
    if (agent === "researcher") {
      await waitForKetchCapabilities({ getAllTools: () => session!.getAllTools(), getActiveTools: () => session!.getActiveToolNames() }, {
        mode: "researcher", ...(signal ? { signal } : {}),
        ...(services.startupTimeoutMs !== undefined ? { timeoutMs: services.startupTimeoutMs } : {}),
      });
    }
    const active = session.getActiveToolNames();
    const callable = session.getCallableToolNames();
    if ([active, callable].some((names) => names.length !== profile.tools.length || names.some((name) => !profile.tools.includes(name)))) {
      throw new Error(`Child ${agent} tools do not match its exact policy.`);
    }
    signal?.throwIfAborted();
    if (lifecycleError) throw new Error(`Child extension failed: ${lifecycleError}`);
    // The fixed prefix is defense in depth; false also disables extension/skill/template commands.
    // Task bytes after the prefix are unchanged, including leading slashes, @paths, and whitespace.
    await session.prompt(`Research task (literal data):\n\n${task}`, { expandPromptTemplates: false, source: "extension" });
    signal?.throwIfAborted();
    if (lifecycleError) throw new Error(`Child extension failed: ${lifecycleError}`);
    // Read the last finalized message on the active branch after all automatic recovery.
    // The next-request projection can compact away an answer or omit a failed retry attempt;
    // neither a summary nor earlier narration is a replacement for that terminal response.
    const lastEntry = history.getBranch().findLast((entry) => entry.type === "message" && entry.message.role !== "system");
    const final = lastEntry?.type === "message" ? lastEntry.message : undefined;
    if (!final || final.role !== "assistant") throw new Error("Child finished without a final assistant answer.");
    if (final.stopReason !== "stop" || final.content.some((part) => part.type === "toolCall")) {
      interrupted = final.stopReason === "aborted";
      throw new Error(`Child did not complete a report (${final.stopReason}).${final.errorMessage ? ` ${final.errorMessage}` : ""}`);
    }
    report = final.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    if (!report.trim()) throw new Error("Child finished with an empty final report.");
  } catch (error) {
    failure = errorText(error);
  } finally {
    await close();
    signal?.removeEventListener("abort", onAbort);
  }
  const usage = history ? collectUsage(history) : undefined;
  const cleanup = cleanupErrors.length ? ` Cleanup failed: ${cleanupErrors.join("; ")}` : "";
  if (signal?.aborted || interrupted) {
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
