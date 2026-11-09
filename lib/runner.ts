import { createDiagnosticHandoff } from "./report.ts";
import { selectModel } from "./config.ts";
import {
  DEFAULT_PROFILE_REGISTRY, loadProfileDefaults, parseResearchInput, type ProfileRegistry, type ResearchInput,
} from "./profiles.ts";
import {
  runResearchSession,
  type ResearchSessionOptions,
  type SessionOutcome,
  type SessionServices,
} from "./session.ts";

export type ResearchRunState = "queued" | "running" | "completed" | "failed" | "cancelled" | "timed_out";

export interface ResearchRunStatus {
  readonly id: number;
  readonly state: ResearchRunState;
  readonly agent?: ResearchInput["agent"];
  readonly task?: string;
  readonly queuedAt: number;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly elapsedMs?: number;
  readonly timeoutMs?: number;
  readonly model?: string;
  readonly thinkingLevel?: string;
  readonly activity?: SessionOutcome["activity"];
}

export const DEFAULT_TIMEOUT_GRACE_MS = 30_000;
export const MAX_TIMER_MS = 2_147_483_647;

export interface ResearchRunnerOptions {
  readonly maxConcurrency: number;
  /** Undefined and zero mean that no research deadline is allocated. */
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
  model?: string;
  thinkingLevel?: string;
  timer: ReturnType<typeof setTimeout> | undefined;
  readonly deadlineController: AbortController;
  readonly effectiveTimeoutMs?: number;
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

function profileTimeoutMs(agent: string, registry?: ProfileRegistry): number | undefined {
  const seconds = registry?.prompts[agent]?.maxTimeout;
  return seconds === undefined ? undefined : seconds * 1000;
}

/** Resolve the ceiling and request without ever clamping an invalid request. */
export function resolveResearchTimeout(
  input: ResearchInput,
  globalTimeoutMs: number | undefined,
  registry?: ProfileRegistry,
): number | undefined {
  const agentTimeout = profileTimeoutMs(input.agent, registry ?? DEFAULT_PROFILE_REGISTRY);
  // A declared agent value, including zero, overrides the global value.
  const ceiling = agentTimeout !== undefined ? agentTimeout : globalTimeoutMs;
  const requested = input.timeout_ms;
  if (requested === undefined) return ceiling && ceiling > 0 ? ceiling : undefined;
  if (requested === 0) {
    if (ceiling !== undefined && ceiling > 0) {
      throw new Error(`Invalid timeout_ms for ${input.agent}: 0 (unlimited) exceeds the finite maximum of ${ceiling} milliseconds.`);
    }
    return undefined;
  }
  if (ceiling !== undefined && ceiling > 0 && requested > ceiling) {
    throw new Error(`Invalid timeout_ms for ${input.agent}: ${requested} milliseconds exceeds the maximum of ${ceiling} milliseconds.`);
  }
  return requested;
}

function selectedModel(
  input: ResearchInput,
  options: ResearchSessionOptions,
  registry?: ProfileRegistry,
): { model?: string; thinkingLevel?: string } {
  try {
    const selection = selectModel(
      input.agent, options.config, options.parent,
      loadProfileDefaults(input.agent, registry ?? options.profileRegistry), registry ?? options.profileRegistry,
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

function cancelled(message: string, result?: SessionOutcome): SessionOutcome {
  return {
    status: "cancelled",
    handoff: createDiagnosticHandoff(interruptionMessage(message, result)),
    activity: result?.activity ?? initialActivity(),
    ...(result?.usage ? { usage: result.usage } : {}),
  };
}

function timedOut(message: string, result?: SessionOutcome, timeoutMs?: number): SessionOutcome {
  if (result?.status === "timed_out") {
    return {
      ...result,
      status: "timed_out",
      handoff: { ...result.handoff, isError: true },
      ...(timeoutMs !== undefined && result.timeoutMs === undefined ? { timeoutMs } : {}),
    };
  }
  return {
    status: "timed_out",
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    handoff: createDiagnosticHandoff(interruptionMessage(message, result)),
    activity: result?.activity ?? initialActivity(),
    ...(result?.usage ? { usage: result.usage } : {}),
  };
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
    try {
      if (this.profileRegistry && options.profileRegistry && this.profileRegistry !== options.profileRegistry) {
        throw new Error("Research profile registry snapshot mismatch between the runner and session options.");
      }
      activeRegistry = this.profileRegistry ?? options.profileRegistry;
      parsed = parseResearchInput(input, activeRegistry);
      // Validate relational timeout policy before anything enters the queue.
      resolveResearchTimeout(parsed, this.timeoutMs, activeRegistry);
    } catch (error) {
      return Promise.resolve({
        status: "failed",
        handoff: createDiagnosticHandoff(error instanceof Error ? error.message : "Invalid research input."),
        activity: initialActivity(),
      });
    }

    if (this.shuttingDown) {
      return Promise.resolve(cancelled("Research cancelled because the parent session is shutting down."));
    }
    if (options.signal?.aborted) {
      return Promise.resolve(cancelled("Research cancelled before it entered the queue."));
    }

    const queuedAt = this.now();
    const display = selectedModel(parsed, options, activeRegistry);
    return new Promise<SessionOutcome>((resolve) => {
      const controller = new AbortController();
      const effectiveTimeoutMs = resolveResearchTimeout(parsed, this.timeoutMs, activeRegistry);
      const entry: RunEntry = {
        id: this.nextId++, input: parsed, options, resolve, queuedAt, controller,
        profileRegistry: activeRegistry, onStatus, ...display,
        state: "queued", completion: Promise.resolve(), timer: undefined,
        deadlineController: new AbortController(),
        ...(effectiveTimeoutMs !== undefined ? { effectiveTimeoutMs } : {}),
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
    if (entry.effectiveTimeoutMs !== undefined) this.armTimeout(entry);
    let result: SessionOutcome;
    try {
      const childOptions: ResearchSessionOptions = {
        ...entry.options,
        ...(entry.profileRegistry ? { profileRegistry: entry.profileRegistry } : {}),
        signal: entry.controller.signal,
        ...(entry.options.signal ? { cancellationSignal: entry.options.signal } : {}),
        ...(entry.effectiveTimeoutMs !== undefined ? { timeoutMs: entry.effectiveTimeoutMs } : {}),
        deadlineSignal: entry.deadlineController.signal,
        timeoutGraceMs: this.timeoutGraceMs,
        ...(entry.startedAt !== undefined ? { startedAt: entry.startedAt } : {}),
        now: this.now,
        onActivity: (activity) => {
          const snapshot = snapshotActivity(activity);
          this.emit(entry, "running", undefined, snapshot);
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
        : "Research cancelled; no completed report is claimed.", result);
    } else if (entry.interruption === "timed_out" || entry.controller.signal.aborted) {
      result = timedOut("Research timed out; no completed report is claimed.", result, entry.effectiveTimeoutMs);
    }
    this.finish(entry, result);
  }

  private armTimeout(entry: RunEntry): void {
    const timeoutMs = entry.effectiveTimeoutMs;
    if (timeoutMs === undefined || timeoutMs <= 0) return;
    const schedule = () => {
      const elapsed = this.now() - entry.startedAt!;
      const remaining = timeoutMs - elapsed;
      if (remaining <= 0) {
        if (entry.interruption !== undefined) return;
        entry.timedOut = true;
        entry.interruption = "timed_out";
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
    const outcome = cancelled(message);
    this.emit(entry, "cancelled", outcome);
    entry.resolve(outcome);
    this.pump();
  }

  private finish(entry: RunEntry, outcome: SessionOutcome): void {
    if (entry.settled) return;
    entry.settled = true;
    this.active.delete(entry);
    const state: ResearchRunState = outcome.status;
    this.emit(entry, state, outcome);
    entry.resolve(outcome);
    this.pump();
  }

  private emit(entry: RunEntry, state: ResearchRunState, outcome?: SessionOutcome, activity?: SessionOutcome["activity"]): void {
    if (!this.onStatus && !entry.onStatus) return;
    const now = this.now();
    const startedAt = entry.startedAt;
    const currentActivity = outcome?.activity ?? activity;
    const status: ResearchRunStatus = {
      id: entry.id, state, agent: entry.input.agent, task: entry.input.task,
      queuedAt: entry.queuedAt,
      ...(entry.model !== undefined ? { model: entry.model } : {}),
      ...(entry.thinkingLevel !== undefined ? { thinkingLevel: entry.thinkingLevel } : {}),
      ...(startedAt !== undefined ? { startedAt, elapsedMs: now - startedAt } : {}),
      ...(entry.effectiveTimeoutMs !== undefined ? { timeoutMs: entry.effectiveTimeoutMs } : {}),
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
