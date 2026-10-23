import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component, stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import type { ResearchInput } from "./profiles.ts";
import type { ResearchRunState, ResearchRunStatus } from "./runner.ts";
import type { SessionActivity } from "./session.ts";
import { createDiagnosticHandoff } from "./report.ts";

export interface ResearchToolDetails {
  readonly status: ResearchRunState;
  readonly agent: ResearchInput["agent"];
  readonly task: string;
  readonly activity?: SessionActivity;
  readonly elapsedMs?: number;
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
    agent: status.agent ?? "scout",
    task: previewTask(status.task ?? ""),
    ...(status.activity ? { activity: status.activity } : {}),
    ...(status.elapsedMs !== undefined ? { elapsedMs: status.elapsedMs } : {}),
    ...(status.model !== undefined ? { model: status.model } : {}),
    ...(status.thinkingLevel !== undefined ? { thinkingLevel: status.thinkingLevel } : {}),
  };
}

export function formatResearchProgress(status: ResearchRunStatus): string {
  const model = status.model ? `; model ${status.model}` : "";
  const thinking = status.thinkingLevel ? `; ${status.thinkingLevel}` : "";
  const activity = status.activity?.latestTool
    ? `; latest tool ${status.activity.latestTool}`
    : status.activity ? `; ${status.activity.toolCalls} tool call(s)` : "";
  const elapsed = status.elapsedMs !== undefined ? `; ${formatElapsed(status.elapsedMs)}` : "";
  return `Subagent ${status.state}: ${status.agent ?? "unknown"}${model}${thinking}${activity}${elapsed}`;
}

export function renderResearchCall(args: ResearchInput, theme: Theme, context?: SubagentRenderContext): Component {
  const expanded = context?.expanded ?? false;
  // Truncation inserts full ANSI resets, which would clear the surrounding tool box's background.
  // The preview is plain text; strip those resets before applying theme colors.
  const task = expanded
    ? stripTerminalSequences(args.task).replace(/[\u0000\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    : stripTerminalSequences(truncateToWidth(previewTask(args.task), MAX_CALL_PREVIEW_WIDTH));
  const separator = expanded ? "\n\n" : " — ";
  return new Text(
    `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.agent)}${task ? theme.fg("muted", `${separator}${task}`) : ""}`,
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
    if (!details) return new Text(theme.fg("warning", "Subagent running…"), 0, 0);
    let progress = `Subagent ${details.status}`;
    if (details.model) progress += ` · ${details.model}`;
    if (details.thinkingLevel) progress += ` · ${details.thinkingLevel}`;
    if (details.activity) {
      progress += ` · ${details.activity.toolCalls} tool call(s)`;
      if (details.activity.latestTool) progress += ` · ${details.activity.latestTool}`;
    }
    if (details.elapsedMs !== undefined) progress += ` · ${formatElapsed(details.elapsedMs)}`;
    return new Text(theme.fg("warning", progress), 0, 0);
  }
  if (!details) {
    const diagnostic = createDiagnosticHandoff(resultText(result)).text;
    const visible = options.expanded ? diagnostic : diagnostic.split("\n")[0] ?? diagnostic;
    return new Text(theme.fg("error", visible || "Subagent result unavailable."), 0, 0);
  }

  const statusColor = details.status === "completed" ? "success"
    : details.status === "cancelled" || details.status === "timed_out" ? "warning" : "error";
  let text = theme.fg(statusColor, `Subagent ${details.status}`);
  if (details.model) text += theme.fg("dim", ` · ${details.model}`);
  if (details.thinkingLevel) text += theme.fg("dim", ` · ${details.thinkingLevel}`);
  if (details.activity) {
    text += theme.fg("dim", ` · ${details.activity.toolCalls} tool call(s)`);
    if (details.activity.latestTool) text += theme.fg("dim", ` · ${details.activity.latestTool}`);
  }
  if (details.elapsedMs !== undefined) text += theme.fg("dim", ` · ${formatElapsed(details.elapsedMs)}`);
  if (details.truncated) text += theme.fg("warning", " · report clipped");
  if (details.reportPath && options.expanded) text += `\n${theme.fg("dim", `Full report: ${details.reportPath}`)}`;
  if (options.expanded) {
    const report = resultText(result);
    if (report) text += `\n${report}`;
  }
  return new Text(text, 0, 0);
}
