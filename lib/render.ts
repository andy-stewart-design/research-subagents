import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component, stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import type { ResearchInput } from "./profiles.ts";
import type { ResearchRunState, ResearchRunPhase, ResearchRunStatus } from "./runner.ts";
import type { SessionActivity } from "./session.ts";
import { createDiagnosticHandoff } from "./report.ts";

export interface ResearchToolDetails {
  readonly status: ResearchRunState;
  readonly phase?: ResearchRunPhase;
  readonly agent: ResearchInput["agent"];
  readonly task: string;
  readonly activity?: SessionActivity;
  readonly elapsedMs?: number;
  readonly timeoutMs?: number;
  readonly requestedTimeoutMs?: number;
  readonly effectiveTimeoutMs?: number;
  readonly timeoutSource?: "agent" | "global" | "caller" | "default";
  readonly maxTimeoutMs?: number;
  readonly model?: string;
  readonly thinkingLevel?: string;
  readonly truncated?: boolean;
  readonly reportPath?: string;
}

const MAX_TASK_PREVIEW = 240;
const MAX_CALL_PREVIEW_WIDTH = 96;
interface SubagentRenderContext {
  readonly expanded: boolean;
}

function formatElapsed(elapsedMs: number): string {
  const seconds = elapsedMs / 1_000;
  if (seconds < 10) return `${seconds.toFixed(1).replace(/\.0$/u, "")}s`;
  const roundedSeconds = Math.round(seconds);
  if (roundedSeconds < 60) return `${roundedSeconds}s`;
  const minutes = Math.floor(roundedSeconds / 60);
  return `${minutes}m ${roundedSeconds % 60}s`;
}

/** Format a deadline without hiding caller-supplied sub-second precision. */
function formatTimeout(timeoutMs: number): string {
  const seconds = Math.floor(timeoutMs / 1_000);
  const milliseconds = timeoutMs % 1_000;
  const secondsText = milliseconds === 0
    ? `${seconds}s`
    : `${(seconds + milliseconds / 1_000).toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "")}s`;
  if (seconds < 60) return secondsText;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (milliseconds === 0 && remainder === 0) return `${minutes}m`;
  const remainderText = milliseconds === 0
    ? `${remainder}s`
    : `${(remainder + milliseconds / 1_000).toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "")}s`;
  return `${minutes}m ${remainderText}`;
}

function formatToolCallNoun(count: number): string {
  return `tool call${count === 1 ? "" : "s"}`;
}

/** Remove only the provider prefix; model IDs may themselves contain slashes. */
function displayModel(model: string): string {
  const separator = model.indexOf("/");
  return separator < 0 ? model : model.slice(separator + 1);
}

function statusLabel(status: { readonly state: ResearchRunState; readonly phase?: ResearchRunPhase | undefined; readonly status?: ResearchRunState }): string {
  return status.phase === "preparing_timeout_handoff" ? "preparing timeout handoff" : status.status ?? status.state;
}

type CompactStatus = {
  readonly state: ResearchRunState;
  readonly status?: ResearchRunState;
  readonly phase?: ResearchRunPhase | undefined;
  readonly model?: string | undefined;
  readonly thinkingLevel?: string | undefined;
  readonly activity?: SessionActivity | undefined;
  readonly elapsedMs?: number | undefined;
  readonly effectiveTimeoutMs?: number | undefined;
};

function compactStatus(status: CompactStatus): string {
  const state = status.status ?? status.state;
  let text = statusLabel({ state, phase: status.phase });
  if (status.model) text += ` · ${displayModel(status.model)}`;
  if (status.thinkingLevel) text += ` · ${status.thinkingLevel}`;
  if (status.activity) {
    text += ` · ${status.activity.toolCalls} ${formatToolCallNoun(status.activity.toolCalls)}`;
    if (status.activity.latestTool) text += ` · ${status.activity.latestTool}`;
  }
  // Queue entries have no active work clock or deadline; do not imply that waiting consumes work time.
  if (state !== "queued" && status.elapsedMs !== undefined) {
    text += ` · ${formatElapsed(status.elapsedMs)}`;
    // A zero timeout is unlimited and is omitted.
    if (status.effectiveTimeoutMs !== undefined && status.effectiveTimeoutMs > 0) {
      text += ` / ${formatTimeout(status.effectiveTimeoutMs)}`;
    }
  }
  return text;
}

function renderToolHistory(activity: SessionActivity, theme: Theme): string {
  const history = activity.toolHistory ?? [];
  const omitted = activity.omittedToolCalls ?? Math.max(0, activity.toolCalls - history.length);
  const lines = history.map((call) =>
    `${call.index}. ${call.tool}${call.summary ? ` · ${call.summary}` : ""} · ${formatElapsed(call.elapsedMs)}`,
  );
  if (omitted > 0) lines.unshift(`… ${omitted} earlier ${formatToolCallNoun(omitted)} omitted`);
  return lines.length ? `\n\n${theme.fg("dim", lines.join("\n"))}` : "";
}

export function previewTask(task: string): string {
  const singleLine = stripTerminalSequences(task).replace(/[\u0000-\u001f\u007f\s]+/gu, " ").trim();
  const characters = Array.from(singleLine);
  return characters.length <= MAX_TASK_PREVIEW
    ? singleLine
    : `${characters.slice(0, MAX_TASK_PREVIEW - 1).join("")}…`;
}

export function detailsFromStatus(status: ResearchRunStatus): ResearchToolDetails {
  return {
    status: status.state,
    agent: status.agent ?? "unknown" as ResearchInput["agent"],
    task: previewTask(status.task ?? ""),
    ...(status.phase !== undefined ? { phase: status.phase } : {}),
    ...(status.activity ? { activity: status.activity } : {}),
    ...(status.elapsedMs !== undefined ? { elapsedMs: status.elapsedMs } : {}),
    ...(status.requestedTimeoutMs !== undefined ? { requestedTimeoutMs: status.requestedTimeoutMs } : {}),
    ...(status.effectiveTimeoutMs !== undefined ? { effectiveTimeoutMs: status.effectiveTimeoutMs } : {}),
    ...(status.timeoutSource !== undefined ? { timeoutSource: status.timeoutSource } : {}),
    ...(status.maxTimeoutMs !== undefined ? { maxTimeoutMs: status.maxTimeoutMs } : {}),
    ...(status.model !== undefined ? { model: status.model } : {}),
    ...(status.thinkingLevel !== undefined ? { thinkingLevel: status.thinkingLevel } : {}),
  };
}

export function formatResearchProgress(status: ResearchRunStatus): string {
  return compactStatus(status);
}

export function renderResearchCall(args: ResearchInput, theme: Theme, context?: SubagentRenderContext): Component {
  const expanded = context?.expanded ?? false;
  // Truncation inserts full ANSI resets, which would clear the surrounding tool box's background.
  // The preview is plain text; strip those resets before applying theme colors.
  const task = expanded
    ? stripTerminalSequences(args.task).replace(/[\u0000\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    : stripTerminalSequences(truncateToWidth(previewTask(args.task), MAX_CALL_PREVIEW_WIDTH));
  const separator = expanded ? "\n\n" : " — ";
  // Pi renders call and result components as adjacent children; one trailing newline here
  // produces the single empty line between the expanded prompt and result metadata.
  return new Text(
    `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.agent)}${task ? theme.fg("muted", `${separator}${task}`) : ""}${expanded ? "\n" : ""}`,
    0,
    0,
  );
}

function resultText(result: AgentToolResult<ResearchToolDetails>): string {
  const content = (result as AgentToolResult<ResearchToolDetails> & { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((entry): entry is { type: "text"; text: string } =>
      !!entry && typeof entry === "object" && (entry as { type?: unknown }).type === "text" &&
      typeof (entry as { text?: unknown }).text === "string")
    .map((entry) => entry.text)
    .join("\n");
}

const RESEARCH_STATES = new Set<ResearchRunState>([
  "queued", "running", "completed", "failed", "cancelled", "timed_out",
]);
const RESEARCH_PHASES = new Set<ResearchRunPhase>(["preparing_timeout_handoff"]);
const TIMEOUT_SOURCES = new Set<NonNullable<ResearchToolDetails["timeoutSource"]>>([
  "agent", "global", "caller", "default",
]);

function nonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validActivity(value: unknown): value is SessionActivity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const activity = value as Record<string, unknown>;
  if (!nonnegativeNumber(activity.assistantMessages) || !nonnegativeNumber(activity.toolCalls)) return false;
  if (activity.latestTool !== undefined && typeof activity.latestTool !== "string") return false;
  if (activity.omittedToolCalls !== undefined && !nonnegativeNumber(activity.omittedToolCalls)) return false;
  if (activity.toolHistory === undefined) return true;
  if (!Array.isArray(activity.toolHistory)) return false;
  return activity.toolHistory.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const call = entry as Record<string, unknown>;
    return nonnegativeNumber(call.index) && typeof call.tool === "string" &&
      (call.summary === undefined || typeof call.summary === "string") &&
      nonnegativeNumber(call.elapsedMs);
  });
}

function validResearchDetails(value: unknown): value is ResearchToolDetails {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const details = value as Record<string, unknown>;
    if (typeof details.agent !== "string" || typeof details.task !== "string" ||
      typeof details.status !== "string" || !RESEARCH_STATES.has(details.status as ResearchRunState)) return false;
    if (details.phase !== undefined && (typeof details.phase !== "string" || !RESEARCH_PHASES.has(details.phase as ResearchRunPhase))) return false;
    if (details.activity !== undefined && !validActivity(details.activity)) return false;
    for (const key of ["elapsedMs", "timeoutMs", "requestedTimeoutMs", "effectiveTimeoutMs", "maxTimeoutMs"]) {
      if (details[key] !== undefined && !nonnegativeNumber(details[key])) return false;
    }
    if (details.timeoutSource !== undefined &&
      (typeof details.timeoutSource !== "string" || !TIMEOUT_SOURCES.has(details.timeoutSource as NonNullable<ResearchToolDetails["timeoutSource"]>))) return false;
    if (details.model !== undefined && typeof details.model !== "string") return false;
    if (details.thinkingLevel !== undefined && typeof details.thinkingLevel !== "string") return false;
    if (details.truncated !== undefined && typeof details.truncated !== "boolean") return false;
    if (details.reportPath !== undefined && typeof details.reportPath !== "string") return false;
    return true;
  } catch {
    return false;
  }
}

function isValidationDiagnostic(diagnostic: string): boolean {
  const text = diagnostic.trim();
  return /^Invalid research input:/u.test(text) ||
    /^Unexpected field(?:s)?: .* Allowed fields: agent, task, timeout_ms\./u.test(text) ||
    /^(?:Missing|Invalid) field: (?:agent|task|timeout_ms)\./u.test(text) ||
    /^Unknown agent\. Allowed agents: /u.test(text);
}

function renderMalformedResult(
  result: AgentToolResult<ResearchToolDetails>,
  expanded: boolean,
  theme: Theme,
): Component {
  const diagnostic = createDiagnosticHandoff(resultText(result)).text;
  if (isValidationDiagnostic(diagnostic)) {
    return new Text(theme.fg("error", expanded ? diagnostic : "Invalid arguments"), 0, 0);
  }
  const firstLine = diagnostic.split("\n")[0] ?? "";
  const visible = expanded ? diagnostic : previewTask(firstLine);
  return new Text(theme.fg("error", visible || "Subagent result unavailable."), 0, 0);
}

export function renderResearchResult(
  result: AgentToolResult<ResearchToolDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
  _context?: SubagentRenderContext,
): Component {
  const details = result.details;
  const hasValidDetails = validResearchDetails(details);
  if (options.isPartial) {
    if (!hasValidDetails) return new Text(theme.fg("warning", "running…"), 0, 0);
    let progress = compactStatus({
      state: details.status, phase: details.phase, model: details.model,
      thinkingLevel: details.thinkingLevel, activity: details.activity,
      elapsedMs: details.elapsedMs, effectiveTimeoutMs: details.effectiveTimeoutMs,
    });
    if (options.expanded && details.activity) progress += renderToolHistory(details.activity, theme);
    return new Text(theme.fg("warning", progress), 0, 0);
  }
  if (!hasValidDetails) return renderMalformedResult(result, options.expanded, theme);

  const statusColor = details.status === "completed" ? "success"
    : details.status === "cancelled" || details.status === "timed_out" ? "warning" : "error";
  let text = theme.fg(statusColor, compactStatus({
    state: details.status, phase: details.phase, model: details.model,
    thinkingLevel: details.thinkingLevel, activity: details.activity,
    elapsedMs: details.elapsedMs, effectiveTimeoutMs: details.effectiveTimeoutMs,
  }));
  if (details.truncated) text += theme.fg("warning", " · report clipped");
  if (options.expanded && details.activity) text += renderToolHistory(details.activity, theme);
  if (details.reportPath && options.expanded) text += `\n\n${theme.fg("dim", `Full report: ${details.reportPath}`)}`;
  if (options.expanded) {
    const report = resultText(result);
    if (report) text += `\n\n${report}`;
  }
  return new Text(text, 0, 0);
}
