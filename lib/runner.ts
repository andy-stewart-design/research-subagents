import { createDiagnosticHandoff } from "./report.ts";
import { parseResearchInput, type ResearchInput } from "./profiles.ts";
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
  readonly activity?: SessionOutcome["activity"];
}

export interface ResearchRunnerOptions {
  readonly maxConcurrency: number;
  /** Undefined means that no research deadline is allocated. */
  readonly timeoutMs?: number;
  readonly services?: Partial<SessionServices>;
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
  readonly onStatus: ((status: ResearchRunStatus) => void) | undefined;
  removeCallerAbort?: () => void;
  completion: Promise<void>;
  state: "queued" | "running";
  startedAt?: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  timedOut: boolean;
  interruption: "cancelled" | "timed_out" | undefined;
  cancellationRequested: boolean;
  shutdownRequested: boolean;
  settled: boolean;
}

const MAX_TIMER_MS = 2_147_483_647;

function initialActivity(): SessionOutcome["activity"] {
  return { assistantMessages: 0, toolCalls: 0 };
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

function timedOut(message: string, result?: SessionOutcome): SessionOutcome {
  return {
    status: "timed_out",
    handoff: createDiagnosticHandoff(interruptionMessage(message, result)),
    activity: result?.activity ?? initialActivity(),
    ...(result?.usage ? { usage: result.usage } : {}),
  };
}

/**
 * Owns the feature's shared child capacity. The runner deliberately has no normal deadline of
 * its own: a timer exists only when the user supplied timeoutMs. A slot is granted before that
 * timer is armed, so queue time never consumes the research deadline.
 */
export class ResearchRunner {
  private readonly maxConcurrency: number;
  private readonly timeoutMs: number | undefined;
  private readonly services: Partial<SessionServices> | undefined;
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
      (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new Error("Research timeout must be a positive finite number.");
    }
    this.maxConcurrency = options.maxConcurrency;
    this.timeoutMs = options.timeoutMs;
    this.services = options.services;
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
    try {
      parsed = parseResearchInput(input);
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
    return new Promise<SessionOutcome>((resolve) => {
      const controller = new AbortController();
      const entry: RunEntry = {
        id: this.nextId++, input: parsed, options, resolve, queuedAt, controller, onStatus,
        state: "queued", completion: Promise.resolve(), timer: undefined, timedOut: false,
        interruption: undefined, cancellationRequested: false, shutdownRequested: false, settled: false,
      };
      const onCallerAbort = () => {
        entry.cancellationRequested = true;
        if (entry.interruption === undefined) entry.interruption = "cancelled";
        this.clearTimer(entry);
        if (entry.state === "queued") this.cancelQueued(entry, "Research cancelled while queued; no child was started.");
        else controller.abort(options.signal?.reason);
      };
      if (options.signal) {
        options.signal.addEventListener("abort", onCallerAbort, { once: true });
        entry.removeCallerAbort = () => options.signal?.removeEventListener("abort", onCallerAbort);
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
        if (entry.interruption === undefined) entry.interruption = "cancelled";
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
    if (this.timeoutMs !== undefined) this.armTimeout(entry);
    let result: SessionOutcome;
    try {
      const childOptions: ResearchSessionOptions = {
        ...entry.options,
        signal: entry.controller.signal,
        onActivity: (activity) => {
          this.emit(entry, "running", undefined, activity);
          entry.options.onActivity?.(activity);
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

    if (entry.interruption === "timed_out") {
      result = timedOut("Research timed out; no completed report is claimed.", result);
    } else if (entry.interruption === "cancelled" || entry.cancellationRequested || entry.shutdownRequested || entry.controller.signal.aborted) {
      result = cancelled(entry.shutdownRequested
        ? "Research cancelled because the parent session is shutting down."
        : "Research cancelled; no completed report is claimed.", result);
    }
    this.finish(entry, result);
  }

  private armTimeout(entry: RunEntry): void {
    const timeoutMs = this.timeoutMs!;
    const schedule = () => {
      const elapsed = this.now() - entry.startedAt!;
      const remaining = timeoutMs - elapsed;
      if (remaining <= 0) {
        if (entry.interruption !== undefined) return;
        entry.timedOut = true;
        entry.interruption = "timed_out";
        entry.controller.abort(new Error("Research safety timeout elapsed."));
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
      ...(startedAt !== undefined ? { startedAt, elapsedMs: now - startedAt } : {}),
      ...(state === "completed" || state === "failed" || state === "cancelled" || state === "timed_out"
        ? { finishedAt: now } : {}),
      ...(currentActivity ? { activity: currentActivity } : {}),
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
