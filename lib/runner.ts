import { createDiagnosticHandoff } from "./report.ts";
import { selectModel } from "./config.ts";
import {
  DEFAULT_PROFILE_REGISTRY, loadProfile, parseResearchInput,
  type ProfilePrompt, type ProfileRegistry, type ResearchInput,
} from "./profiles.ts";
import {
  runResearchSession,
  type ResearchSessionOptions,
  type ResearchTimeoutMetadata,
  type ResearchTimeoutSource,
  type SessionOutcome,
  type SessionServices,
} from "./session.ts";

export type ResearchRunState = "queued" | "running" | "completed" | "failed" | "cancelled" | "timed_out";
/** A live running phase; terminal statuses deliberately carry no phase. */
export type ResearchRunPhase = "preparing_timeout_handoff";

export interface ResearchRunStatus {
  readonly id: number;
  readonly state: ResearchRunState;
  readonly phase?: ResearchRunPhase;
  readonly agent?: ResearchInput["agent"];
  readonly task?: string;
  readonly queuedAt: number;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly elapsedMs?: number;
  /** Backward-compatible finite effective deadline; absent when unlimited. */
  readonly timeoutMs?: number;
  readonly requestedTimeoutMs?: number;
  /** Effective deadline in milliseconds; zero means unlimited. */
  readonly effectiveTimeoutMs?: number;
  readonly timeoutSource?: ResearchTimeoutSource;
  /** Effective configured ceiling; zero means unlimited. */
  readonly maxTimeoutMs?: number;
  readonly model?: string;
  readonly thinkingLevel?: string;
  readonly activity?: SessionOutcome["activity"];
}

export const DEFAULT_TIMEOUT_GRACE_MS = 30_000;
export const MAX_TIMER_MS = 2_147_483_647;

export interface ResearchRunnerOptions {
  readonly maxConcurrency: number;
  /** Global timeout policy in milliseconds; undefined/zero are unlimited unless an agent maxTimeout overrides it. */
  readonly timeoutMs?: number;
  /** Injectable for deterministic lifecycle tests; production contract is 30 seconds. */
  readonly timeoutGraceMs?: number;
  readonly services?: Partial<SessionServices>;
  readonly profileRegistry?: ProfileRegistry;
  readonly runSession?: typeof runResearchSession;
  readonly now?: () => number;
  readonly onStatus?: (status: ResearchRunStatus) => void;
}

interface RunEntry {
  readonly id: number;
  readonly input: ResearchInput;
  readonly options: ResearchSessionOptions;
  readonly resolve: (outcome: SessionOutcome) => void;
  readonly queuedAt: number;
  readonly controller: AbortController;
  readonly profileRegistry: ProfileRegistry | undefined;
  readonly onStatus: ((status: ResearchRunStatus) => void) | undefined;
  removeCallerAbort?: () => void;
  completion: Promise<void>;
  state: "queued" | "running";
  startedAt?: number;
  /** Work-clock elapsed at the deadline; excludes timeout grace/handoff time. */
  workElapsedMs?: number;
  phase?: ResearchRunPhase | undefined;
  model?: string;
  thinkingLevel?: string;
  timer: ReturnType<typeof setTimeout> | undefined;
  readonly deadlineController: AbortController;
  readonly timeout: ResearchTimeoutMetadata;
  timedOut: boolean;
  interruption: "cancelled" | "timed_out" | undefined;
  cancellationRequested: boolean;
  shutdownRequested: boolean;
  settled: boolean;
}

function initialActivity(): SessionOutcome["activity"] {
  return { assistantMessages: 0, toolCalls: 0 };
}

function snapshotActivity(activity: SessionOutcome["activity"]): SessionOutcome["activity"] {
  return {
    ...activity,
    ...(activity.toolHistory ? { toolHistory: activity.toolHistory.map((call) => ({ ...call })) } : {}),
  };
}

function profileTimeoutMs(agent: string, registry: ProfileRegistry): number | undefined {
  const seconds = registry.prompts[agent]?.maxTimeout;
  return seconds === undefined ? undefined : seconds * 1000;
}

/** Resolve the ceiling and request without ever clamping an invalid request. */
export function resolveResearchTimeoutPolicy(
  input: ResearchInput,
  globalTimeoutMs: number | undefined,
  registry?: ProfileRegistry,
): ResearchTimeoutMetadata {
  const activeRegistry = registry ?? DEFAULT_PROFILE_REGISTRY;
  const agentTimeout = profileTimeoutMs(input.agent, activeRegistry);
  // A declared agent value, including zero, overrides the global value.
  const ceiling = agentTimeout !== undefined ? agentTimeout : globalTimeoutMs;
  const timeoutSource: ResearchTimeoutSource = agentTimeout !== undefined
    ? "agent"
    : globalTimeoutMs !== undefined ? "global" : "default";
  const requested = input.timeout_ms;
  if (requested !== undefined && requested > 0 && ceiling !== undefined && ceiling > 0 && requested > ceiling) {
    throw new Error(`Invalid timeout_ms for ${input.agent}: ${requested} milliseconds exceeds the maximum of ${ceiling} milliseconds.`);
  }
  const callerImposed = requested !== undefined && requested > 0;
  const effectiveTimeoutMs = callerImposed ? requested : ceiling ?? 0;
  return {
    ...(requested !== undefined ? { requestedTimeoutMs: requested } : {}),
    effectiveTimeoutMs,
    timeoutSource: callerImposed ? "caller" : timeoutSource,
    maxTimeoutMs: ceiling ?? 0,
  };
}

export function resolveResearchTimeout(
  input: ResearchInput,
  globalTimeoutMs: number | undefined,
  registry?: ProfileRegistry,
): number | undefined {
  const effective = resolveResearchTimeoutPolicy(input, globalTimeoutMs, registry).effectiveTimeoutMs;
  return effective > 0 ? effective : undefined;
}

function selectedModel(
  input: ResearchInput,
  options: ResearchSessionOptions,
  profile: ProfilePrompt,
  registry?: ProfileRegistry,
): { model?: string; thinkingLevel?: string } {
  try {
    const selection = selectModel(
      input.agent, options.config, options.parent, profile.defaults, registry ?? options.profileRegistry,
    );
    return {
      model: `${selection.provider}/${selection.modelId}`,
      ...(selection.thinkingLevel !== undefined ? { thinkingLevel: selection.thinkingLevel } : {}),
    };
  } catch {
    return {};
  }
}

function interruptionMessage(message: string, result?: SessionOutcome): string {
  if (!result?.handoff.isError || !result.handoff.text || result.handoff.text === message) return message;
  return `${message}\n${result.handoff.text}`;
}

function timeoutDuration(value: number): string {
  if (value === 0) return "unlimited";
  if (value % 60_000 === 0) return `${value / 60_000} minute${value === 60_000 ? "" : "s"}`;
  if (value % 1_000 === 0) return `${value / 1_000} second${value === 1_000 ? "" : "s"}`;
  return `${value} milliseconds`;
}

function timeoutSummary(timeout: ResearchTimeoutMetadata): string {
  const requested = timeout.requestedTimeoutMs === undefined
    ? "omitted"
    : timeoutDuration(timeout.requestedTimeoutMs);
  const source = timeout.timeoutSource === "caller"
    ? `caller value ${requested}`
    : `${timeout.timeoutSource} policy`;
  return `requested timeout_ms: ${requested}; deadline source: ${source}; effective: ${timeoutDuration(timeout.effectiveTimeoutMs)}; configured maximum: ${timeoutDuration(timeout.maxTimeoutMs)}`;
}

function withTimeoutMetadata(outcome: SessionOutcome, timeout: ResearchTimeoutMetadata): SessionOutcome {
  return {
    ...outcome,
    ...timeout,
    ...(timeout.effectiveTimeoutMs > 0 ? { timeoutMs: timeout.effectiveTimeoutMs } : {}),
  };
}

function cancelled(message: string, result?: SessionOutcome, timeout?: ResearchTimeoutMetadata): SessionOutcome {
  const outcome: SessionOutcome = {
    status: "cancelled",
    handoff: createDiagnosticHandoff(interruptionMessage(message, result)),
    activity: result?.activity ?? initialActivity(),
    ...(result?.usage ? { usage: result.usage } : {}),
  };
  return timeout ? withTimeoutMetadata(outcome, timeout) : outcome;
}

function timedOut(message: string, result: SessionOutcome | undefined, timeout: ResearchTimeoutMetadata): SessionOutcome {
  const diagnostic = createDiagnosticHandoff(
    `${message} ${timeoutSummary(timeout)}. No completed report is claimed.` +
    (result?.handoff.isError && result.handoff.text ? `\n${result.handoff.text}` : ""),
  );
  const outcome: SessionOutcome = result?.status === "timed_out"
    ? {
      ...result,
      status: "timed_out",
      handoff: { ...diagnostic, ...(result.handoff.reportPath ? { reportPath: result.handoff.reportPath } : {}) },
    }
    : {
      status: "timed_out",
      handoff: diagnostic,
      activity: result?.activity ?? initialActivity(),
      ...(result?.usage ? { usage: result.usage } : {}),
    };
  return withTimeoutMetadata(outcome, timeout);
}

/**
 * Owns the feature's shared child capacity. The runner deliberately has no normal deadline of
 * its own: a timer exists only when the resolved global/agent/call policy is finite. A slot is
 * granted before that timer is armed, so queue time never consumes the research deadline.
 */
export class ResearchRunner {
  private readonly maxConcurrency: number;
  private readonly timeoutMs: number | undefined;
  private readonly timeoutGraceMs: number;
  private readonly services: Partial<SessionServices> | undefined;
  private readonly profileRegistry: ProfileRegistry | undefined;
  private readonly runSession: typeof runResearchSession;
  private readonly now: () => number;
  private readonly onStatus: ((status: ResearchRunStatus) => void) | undefined;
  private readonly queue: RunEntry[] = [];
  private readonly active = new Set<RunEntry>();
  private nextId = 1;
  private shutdownPromise: Promise<void> | undefined;
  private shuttingDown = false;

  constructor(options: ResearchRunnerOptions) {
    if (!Number.isSafeInteger(options.maxConcurrency) || options.maxConcurrency < 1) {
      throw new Error("Research concurrency must be a positive integer.");
    }
    if (options.timeoutMs !== undefined &&
      (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0)) {
      throw new Error("Research timeout must be zero or a nonnegative safe integer in milliseconds.");
    }
    if (options.timeoutGraceMs !== undefined &&
      (!Number.isSafeInteger(options.timeoutGraceMs) || options.timeoutGraceMs < 0 || options.timeoutGraceMs > MAX_TIMER_MS)) {
      throw new Error("Research timeout grace must be a nonnegative safe integer within the supported timer range.");
    }
    this.maxConcurrency = options.maxConcurrency;
    this.timeoutMs = options.timeoutMs;
    this.timeoutGraceMs = options.timeoutGraceMs ?? DEFAULT_TIMEOUT_GRACE_MS;
    this.services = options.services;
    this.profileRegistry = options.profileRegistry;
    this.runSession = options.runSession ?? runResearchSession;
    this.now = options.now ?? Date.now;
    this.onStatus = options.onStatus;
  }

  get activeCount(): number { return this.active.size; }
  get queuedCount(): number { return this.queue.length; }

  run(
    input: unknown,
    options: ResearchSessionOptions,
    onStatus?: (status: ResearchRunStatus) => void,
  ): Promise<SessionOutcome> {
    let parsed: ResearchInput;
    let activeRegistry: ProfileRegistry | undefined;
    let profile: ProfilePrompt;
    try {
      if (this.profileRegistry && options.profileRegistry && this.profileRegistry !== options.profileRegistry) {
        throw new Error("Research profile registry snapshot mismatch between the runner and session options.");
      }
      activeRegistry = this.profileRegistry ?? options.profileRegistry;
      parsed = parseResearchInput(input, activeRegistry);
      // Validate relational timeout policy before anything enters the queue.
      resolveResearchTimeoutPolicy(parsed, this.timeoutMs, activeRegistry);
    } catch (error) {
      return Promise.resolve({
        status: "failed",
        handoff: createDiagnosticHandoff(error instanceof Error ? error.message : "Invalid research input."),
        activity: initialActivity(),
      });
    }

    const timeout = resolveResearchTimeoutPolicy(parsed, this.timeoutMs, activeRegistry);
    if (this.shuttingDown) {
      return Promise.resolve(cancelled("Research cancelled because the parent session is shutting down.", undefined, timeout));
    }
    if (options.signal?.aborted) {
      return Promise.resolve(cancelled("Research cancelled before it entered the queue.", undefined, timeout));
    }

    try {
      // Capture the profile once. A host-provided loader can be mutable, so the runner's
      // display and the child session must consume the same effective profile snapshot.
      profile = this.services?.loadProfile
        ? this.services.loadProfile(parsed.agent)
        : loadProfile(parsed.agent, activeRegistry ?? options.profileRegistry);
    } catch (error) {
      return Promise.resolve({
        status: "failed",
        handoff: createDiagnosticHandoff(error instanceof Error ? error.message : "Unable to load the research profile."),
        activity: initialActivity(),
      });
    }

    const queuedAt = this.now();
    const sessionOptions = { ...options, profileSnapshot: profile };
    const display = selectedModel(parsed, sessionOptions, profile, activeRegistry);
    return new Promise<SessionOutcome>((resolve) => {
      const controller = new AbortController();
      const entry: RunEntry = {
        id: this.nextId++, input: parsed, options: sessionOptions, resolve, queuedAt, controller,
        profileRegistry: activeRegistry, onStatus, ...display,
        state: "queued", completion: Promise.resolve(), timer: undefined,
        deadlineController: new AbortController(), timeout,
        timedOut: false,
        interruption: undefined, cancellationRequested: false, shutdownRequested: false, settled: false,
      };
      const onCallerAbort = () => {
        entry.cancellationRequested = true;
        // Explicit parent cancellation during timeout grace suppresses the incomplete handoff.
        entry.interruption = "cancelled";
        this.clearTimer(entry);
        if (entry.state === "queued") this.cancelQueued(entry, "Research cancelled while queued; no child was started.");
        else controller.abort(options.signal?.reason);
      };
      if (options.signal) {
        options.signal.addEventListener("abort", onCallerAbort, { once: true });
        entry.removeCallerAbort = () => options.signal?.removeEventListener("abort", onCallerAbort);
        // Abort can be delivered between the initial check above and listener
        // registration. Re-check synchronously before publishing this entry so
        // a pre-aborted caller can never be queued or started.
        if (options.signal.aborted) {
          onCallerAbort();
          return;
        }
      }
      // Keep the queue free of entries settled by the registration race (and of
      // any entry whose controller was synchronously aborted by its callback).
      if (entry.settled || entry.controller.signal.aborted) {
        this.cancelQueued(entry, "Research cancelled while queued; no child was started.");
        return;
      }
      this.queue.push(entry);
      this.emit(entry, "queued");
      this.pump();
    });
  }

  /** Abort all owned queued/running work and wait for child cleanup before returning. */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = (async () => {
      for (const entry of [...this.queue]) {
        entry.shutdownRequested = true;
        this.cancelQueued(entry, "Research cancelled because the parent session is shutting down.");
      }
      for (const entry of this.active) {
        entry.shutdownRequested = true;
        entry.cancellationRequested = true;
        entry.interruption = "cancelled";
        this.clearTimer(entry);
        entry.controller.abort();
      }
      // Active entries are removed only after runResearchSession has awaited native shutdown and
      // disposal. Do not resolve this method merely because an abort signal was delivered.
      while (this.active.size > 0) await Promise.all([...this.active].map((entry) => entry.completion));
    })();
    return this.shutdownPromise;
  }

  private pump(): void {
    while (!this.shuttingDown && this.active.size < this.maxConcurrency && this.queue.length) {
      const entry = this.queue.shift()!;
      if (entry.settled || entry.controller.signal.aborted) {
        this.cancelQueued(entry, "Research cancelled while queued; no child was started.");
        continue;
      }
      this.active.add(entry);
      entry.state = "running";
      entry.startedAt = this.now();
      this.emit(entry, "running");
      void this.start(entry);
    }
  }

  private async start(entry: RunEntry): Promise<void> {
    const completion = this.execute(entry);
    entry.completion = completion;
    await completion;
  }

  private async execute(entry: RunEntry): Promise<void> {
    if (entry.timeout.effectiveTimeoutMs > 0) this.armTimeout(entry);
    let result: SessionOutcome;
    try {
      const childOptions: ResearchSessionOptions = {
        ...entry.options,
        ...(entry.profileRegistry ? { profileRegistry: entry.profileRegistry } : {}),
        signal: entry.controller.signal,
        ...(entry.options.signal ? { cancellationSignal: entry.options.signal } : {}),
        ...(entry.timeout.effectiveTimeoutMs > 0 ? { timeoutMs: entry.timeout.effectiveTimeoutMs } : {}),
        deadlineSignal: entry.deadlineController.signal,
        timeoutGraceMs: this.timeoutGraceMs,
        ...(entry.startedAt !== undefined ? { startedAt: entry.startedAt } : {}),
        now: this.now,
        onActivity: (activity) => {
          // A child can deliver a queued callback after its operation has finished. Once a
          // cancellation has won, those callbacks must not resurrect a terminal TUI row. The
          // timeout path is intentionally still allowed to report during its handoff grace.
          if (
            entry.settled ||
            entry.cancellationRequested ||
            entry.shutdownRequested ||
            entry.interruption === "cancelled"
          ) return;
          const snapshot = snapshotActivity(activity);
          this.emit(entry, "running", undefined, snapshot);
          // A status observer may request cancellation synchronously while the live update is
          // being published; do not forward that same stale callback to the caller observer.
          if (entry.settled || entry.cancellationRequested || entry.shutdownRequested) return;
          entry.options.onActivity?.(snapshot);
        },
      };
      result = await this.runSession(entry.input, childOptions, this.services);
    } catch (error) {
      result = {
        status: "failed",
        handoff: createDiagnosticHandoff(error instanceof Error ? error.message : "Research session failed."),
        activity: initialActivity(),
      };
    } finally {
      this.clearTimer(entry);
      entry.removeCallerAbort?.();
    }

    if (entry.interruption === "cancelled" || entry.cancellationRequested || entry.shutdownRequested) {
      result = cancelled(entry.shutdownRequested
        ? "Research cancelled because the parent session is shutting down."
        : "Research cancelled; no completed report is claimed.", result, entry.timeout);
    } else if (entry.interruption === "timed_out" || entry.controller.signal.aborted) {
      result = timedOut("Research timed out;", result, entry.timeout);
    } else {
      result = withTimeoutMetadata(result, entry.timeout);
    }
    this.finish(entry, result);
  }

  private armTimeout(entry: RunEntry): void {
    const timeoutMs = entry.timeout.effectiveTimeoutMs;
    if (timeoutMs <= 0) return;
    const schedule = () => {
      const elapsed = this.now() - entry.startedAt!;
      const remaining = timeoutMs - elapsed;
      if (remaining <= 0) {
        if (entry.interruption !== undefined) return;
        entry.timedOut = true;
        entry.interruption = "timed_out";
        // Preserve the work clock for the live handoff phase and terminal snapshot. Grace is
        // separate from the effective work timeout and must not inflate elapsed/deadline display.
        entry.workElapsedMs = Math.min(timeoutMs, Math.max(0, elapsed));
        entry.phase = "preparing_timeout_handoff";
        this.emit(entry, "running");
        const reason = { researchTimeout: true, message: "Research safety timeout elapsed." };
        // deadlineSignal is the explicit soft-interruption channel. The tagged abort on the
        // compatibility signal lets older injected runners wake up without making this a cancel.
        entry.deadlineController.abort(reason);
        entry.controller.abort(reason);
        return;
      }
      entry.timer = setTimeout(schedule, Math.min(remaining, MAX_TIMER_MS));
    };
    entry.timer = setTimeout(schedule, Math.min(timeoutMs, MAX_TIMER_MS));
  }

  private clearTimer(entry: RunEntry): void {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
  }

  private cancelQueued(entry: RunEntry, message: string): void {
    if (entry.settled) return;
    const index = this.queue.indexOf(entry);
    if (index >= 0) this.queue.splice(index, 1);
    entry.settled = true;
    entry.removeCallerAbort?.();
    const outcome = cancelled(message, undefined, entry.timeout);
    this.emit(entry, "cancelled", outcome);
    entry.resolve(outcome);
    this.pump();
  }

  private finish(entry: RunEntry, outcome: SessionOutcome): void {
    if (entry.settled) return;
    entry.settled = true;
    this.active.delete(entry);
    entry.phase = undefined;
    const state: ResearchRunState = outcome.status;
    this.emit(entry, state, outcome);
    entry.resolve(outcome);
    this.pump();
  }

  private emit(entry: RunEntry, state: ResearchRunState, outcome?: SessionOutcome, activity?: SessionOutcome["activity"]): void {
    const terminal = state === "completed" || state === "failed" || state === "cancelled" || state === "timed_out";
    // Terminal emission happens after finish marks the entry settled, but no later live update
    // may replace that terminal snapshot. Explicit cancellation also wins over live updates;
    // timeout grace remains valid because its interruption is timed_out.
    if (
      (entry.settled && !terminal) ||
      (!terminal && (entry.cancellationRequested || entry.shutdownRequested || entry.interruption === "cancelled"))
    ) return;
    if (!this.onStatus && !entry.onStatus) return;
    const now = this.now();
    const startedAt = entry.startedAt;
    const currentActivity = outcome?.activity ?? activity;
    const status: ResearchRunStatus = {
      id: entry.id, state, agent: entry.input.agent, task: entry.input.task,
      queuedAt: entry.queuedAt,
      ...(entry.phase !== undefined ? { phase: entry.phase } : {}),
      ...(entry.model !== undefined ? { model: entry.model } : {}),
      ...(entry.thinkingLevel !== undefined ? { thinkingLevel: entry.thinkingLevel } : {}),
      ...(startedAt !== undefined ? { startedAt, elapsedMs: entry.workElapsedMs ?? now - startedAt } : {}),
      ...(entry.timeout.effectiveTimeoutMs > 0 ? { timeoutMs: entry.timeout.effectiveTimeoutMs } : {}),
      ...(entry.timeout.requestedTimeoutMs !== undefined ? { requestedTimeoutMs: entry.timeout.requestedTimeoutMs } : {}),
      effectiveTimeoutMs: entry.timeout.effectiveTimeoutMs,
      timeoutSource: entry.timeout.timeoutSource,
      maxTimeoutMs: entry.timeout.maxTimeoutMs,
      ...(state === "completed" || state === "failed" || state === "cancelled" || state === "timed_out"
        ? { finishedAt: now } : {}),
      ...(currentActivity ? { activity: snapshotActivity(currentActivity) } : {}),
    };
    try { this.onStatus?.(status); } catch { /* Observability cannot affect execution. */ }
    try { entry.onStatus?.(status); } catch { /* Observability cannot affect execution. */ }
  }
}

export function createResearchRunner(
  config: Pick<ResearchRunnerOptions, "maxConcurrency" | "timeoutMs">,
  options: Omit<ResearchRunnerOptions, "maxConcurrency" | "timeoutMs"> = {},
): ResearchRunner {
  return new ResearchRunner({ ...options, ...config });
}
