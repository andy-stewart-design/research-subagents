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
  return result.content
    .filter((content): content is { type: "text"; text: string } => content.type === "text")
    .map((content) => content.text)
    .join("\n");
}

export function renderResearchResult(
  result: AgentToolResult<ResearchToolDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
  _context?: SubagentRenderContext,
): Component {
  const details = result.details;
  if (options.isPartial) {
    if (!details) return new Text(theme.fg("warning", "running…"), 0, 0);
    let progress = compactStatus({
      state: details.status, phase: details.phase, model: details.model,
      thinkingLevel: details.thinkingLevel, activity: details.activity,
      elapsedMs: details.elapsedMs, effectiveTimeoutMs: details.effectiveTimeoutMs,
    });
    if (options.expanded && details.activity) progress += renderToolHistory(details.activity, theme);
    return new Text(theme.fg("warning", progress), 0, 0);
  }
  if (!details) {
    const diagnostic = createDiagnosticHandoff(resultText(result)).text;
    const visible = options.expanded ? diagnostic : diagnostic.split("\n")[0] ?? diagnostic;
    return new Text(theme.fg("error", visible || "Subagent result unavailable."), 0, 0);
  }

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
