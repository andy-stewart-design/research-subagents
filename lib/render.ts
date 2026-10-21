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
  readonly truncated?: boolean;
  readonly reportPath?: string;
}

const MAX_TASK_PREVIEW = 240;
const MAX_CALL_PREVIEW_WIDTH = 96;

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
  };
}

export function formatResearchProgress(status: ResearchRunStatus): string {
  const activity = status.activity?.latestTool
    ? `; latest tool ${status.activity.latestTool}`
    : status.activity ? `; ${status.activity.toolCalls} tool call(s)` : "";
  const elapsed = status.elapsedMs !== undefined ? `; ${Math.round(status.elapsedMs)}ms` : "";
  return `Research ${status.state}: ${status.agent ?? "research"}${activity}${elapsed}`;
}

export function renderResearchCall(args: ResearchInput, theme: Theme): Component {
  const task = truncateToWidth(previewTask(args.task), MAX_CALL_PREVIEW_WIDTH);
  return new Text(
    `${theme.fg("toolTitle", theme.bold("research "))}${theme.fg("accent", args.agent)}${task ? theme.fg("muted", ` — ${task}`) : ""}`,
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
): Component {
  const details = result.details;
  if (options.isPartial) {
    if (!details) return new Text(theme.fg("warning", "Research running…"), 0, 0);
    let progress = `Research ${details.status}`;
    if (details.activity) {
      progress += ` · ${details.activity.toolCalls} tool call(s)`;
      if (details.activity.latestTool) progress += ` · ${details.activity.latestTool}`;
    }
    if (details.elapsedMs !== undefined) progress += ` · ${Math.round(details.elapsedMs)}ms`;
    return new Text(theme.fg("warning", progress), 0, 0);
  }
  if (!details) {
    const diagnostic = createDiagnosticHandoff(resultText(result)).text;
    const visible = options.expanded ? diagnostic : diagnostic.split("\n")[0] ?? diagnostic;
    return new Text(theme.fg("error", visible || "Research result unavailable."), 0, 0);
  }

  const statusColor = details.status === "completed" ? "success"
    : details.status === "cancelled" || details.status === "timed_out" ? "warning" : "error";
  let text = theme.fg(statusColor, `Research ${details.status}`);
  if (details.activity) {
    text += theme.fg("dim", ` · ${details.activity.toolCalls} tool call(s)`);
    if (details.activity.latestTool) text += theme.fg("dim", ` · ${details.activity.latestTool}`);
  }
  if (details.elapsedMs !== undefined) text += theme.fg("dim", ` · ${Math.round(details.elapsedMs)}ms`);
  if (details.truncated) text += theme.fg("warning", " · report clipped");
  if (details.reportPath && options.expanded) text += `\n${theme.fg("dim", `Full report: ${details.reportPath}`)}`;
  if (options.expanded) {
    const report = resultText(result);
    if (report) text += `\n${report}`;
  }
  return new Text(text, 0, 0);
}
