import assert from "node:assert/strict";
import test from "node:test";
import { formatResearchProgress, previewTask, renderResearchCall, renderResearchResult } from "../lib/render.ts";
import { Box, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { ResearchToolDetails } from "../lib/render.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => `**${text}**`,
} as any;

function visibleLines(lines: string[]): string[] {
  return lines.map((line) => stripTerminalSequences(line).trim());
}

test("research rendering keeps default output compact and strips unsafe task display text", () => {
  const task = "  inspect\n\u001b[31mprivate\u001b[0m files 🙂 ".repeat(30);
  const component = renderResearchCall({ agent: "scout", task }, theme);
  const lines = component.render(24);
  assert.ok(lines.length > 0);
  assert.doesNotMatch(stripTerminalSequences(lines.join("\n")), /\u001b\[/);
  assert.ok(Array.from(previewTask(task)).length <= 240);
});

test("expanded call rendering reveals the complete task while running", () => {
  const task = "First line\nSecond line with \u001b[31munsafe\u001b[0m text and a long implementation request.";
  const component = renderResearchCall({ agent: "worker", task }, theme, { expanded: true });
  const text = stripTerminalSequences(component.render(80).join("\n"));
  assert.match(text, /First line/);
  assert.match(text, /Second line with unsafe text and a long implementation request\./);
  assert.doesNotMatch(text, /\u001b\[/);
});

test("expanded prompt and live metadata have one separating blank line", () => {
  const call = renderResearchCall({ agent: "scout", task: "Expanded prompt" }, theme, { expanded: true });
  const result = renderResearchResult({
    content: [], details: { status: "running", agent: "scout", task: "Expanded prompt" },
  }, { expanded: true, isPartial: true }, theme);
  const lines = visibleLines([...call.render(80), ...result.render(80)]);
  const promptIndex = lines.indexOf("Expanded prompt");
  assert.ok(promptIndex >= 0);
  assert.deepEqual(lines.slice(promptIndex, promptIndex + 3), ["Expanded prompt", "", "Subagent running"]);
  assert.notEqual(lines[promptIndex + 2], "");
});

test("truncated call previews preserve the surrounding box background through trailing padding", () => {
  const ansiTheme = {
    fg: (_color: string, text: string) => `\u001b[37m${text}\u001b[39m`,
    bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
  } as any;
  for (const task of ["Inspect the source files and document the setup steps. ".repeat(4), "Inspect 界🙂 sources. ".repeat(12)]) {
    for (const background of ["\u001b[43m", "\u001b[42m", "\u001b[45m"]) {
      const backgroundEnd = "\u001b[49m";
      const box = new Box(1, 1, (text) => `${background}${text}${backgroundEnd}`);
      box.addChild(renderResearchCall({ agent: "researcher", task }, ansiTheme));
      const line = box.render(160)[1]!;
      assert.ok(line.startsWith(background));
      assert.ok(line.endsWith(backgroundEnd));
      assert.equal(visibleWidth(line), 160);
      assert.match(stripTerminalSequences(line), /\.\.\.\s+$/u);
      assert.doesNotMatch(line.slice(0, -backgroundEnd.length), /\u001b\[(?:0|49)m/u,
        "inner resets must not clear the box background before its trailing padding");
    }
  }
});

test("progress and expanded result rendering expose status/activity without a transcript", () => {
  const status = {
    id: 1, state: "running" as const, agent: "researcher" as const, task: "question",
    queuedAt: 0, startedAt: 10, elapsedMs: 40_960,
    model: "openai-codex/gpt-5.6-luna", thinkingLevel: "low",
    activity: { assistantMessages: 1, toolCalls: 2, latestTool: "mcp__ketch__search" },
  };
  assert.match(formatResearchProgress(status), /running/);
  assert.match(formatResearchProgress(status), /mcp__ketch__search/);
  assert.match(formatResearchProgress(status), /41s/);
  assert.match(formatResearchProgress({ ...status, elapsedMs: 68_000 }), /1m 8s/);
  assert.doesNotMatch(formatResearchProgress(status), /ms/);
  assert.match(formatResearchProgress(status), /gpt-5\.6-luna/);
  assert.match(formatResearchProgress(status), /; low/);
  for (const [toolCalls, label] of [[0, "0 tool calls"], [1, "1 tool call"], [2, "2 tool calls"]] as const) {
    assert.match(formatResearchProgress({
      ...status,
      activity: { assistantMessages: 1, toolCalls },
    }), new RegExp(`; ${label}`));
  }
  const details: ResearchToolDetails = {
    status: "completed", agent: "researcher", task: "question",
    model: "openai-codex/gpt-5.6-luna", thinkingLevel: "low",
    activity: { assistantMessages: 2, toolCalls: 3, latestTool: "mcp__ketch__scrape" },
  };
  const component = renderResearchResult({
    content: [{ type: "text", text: "## Answer\nEvidence only." }], details,
  }, { expanded: true, isPartial: false }, theme);
  const text = component.render(40).join("\n");
  assert.match(text, /Subagent completed/);
  assert.match(text, /gpt-5\.6-luna/);
  assert.match(text, /· low/);
  assert.match(text, /· 3 tool\s+calls/);
  assert.match(text, /Evidence only/);
  assert.doesNotMatch(text, /reasoning|tool transcript/i);
});

test("expanded results show the retained ordered tool history while collapsed results stay compact", () => {
  const activity = {
    assistantMessages: 1, toolCalls: 7, latestTool: "bash",
    omittedToolCalls: 6,
    toolHistory: [{ index: 7, tool: "bash", summary: "pnpm test", elapsedMs: 256_000 }],
  } as const;
  const details: ResearchToolDetails = { status: "completed", agent: "worker", task: "question", activity };
  const expanded = renderResearchResult({ content: [], details }, { expanded: true, isPartial: false }, theme).render(80).join("\n");
  const collapsed = renderResearchResult({ content: [], details }, { expanded: false, isPartial: false }, theme).render(80).join("\n");
  const partial = renderResearchResult({ content: [], details: { ...details, status: "running" } }, { expanded: true, isPartial: true }, theme).render(80).join("\n");
  const singularOmitted = renderResearchResult({
    content: [],
    details: {
      ...details,
      activity: { ...activity, toolCalls: 2, omittedToolCalls: 1, toolHistory: [{ index: 2, tool: "bash", elapsedMs: 0 }] },
    },
  }, { expanded: true, isPartial: false }, theme).render(80).join("\n");
  assert.match(expanded, /· 7 tool calls/);
  assert.match(expanded, /… 6 earlier tool calls omitted/);
  assert.match(expanded, /7\. bash · pnpm test · 4m 16s/);
  assert.match(partial, /· 7 tool calls/);
  assert.match(partial, /7\. bash · pnpm test · 4m 16s/);
  assert.match(singularOmitted, /… 1 earlier tool call omitted/);
  assert.doesNotMatch(collapsed, /pnpm test|earlier tool call/);

  const partialLines = visibleLines(renderResearchResult(
    { content: [], details: { ...details, status: "running" } },
    { expanded: true, isPartial: true },
    theme,
  ).render(80));
  const partialHistoryIndex = partialLines.findIndex((line) => line.startsWith("… 6 earlier"));
  assert.ok(partialHistoryIndex > 0);
  assert.equal(partialLines[partialHistoryIndex - 1], "");
  assert.notEqual(partialLines[partialHistoryIndex - 2], "");
});

test("expanded completed sections separate history, report path, and report", () => {
  const details: ResearchToolDetails = {
    status: "completed", agent: "worker", task: "question",
    activity: {
      assistantMessages: 1, toolCalls: 1,
      toolHistory: [{ index: 1, tool: "bash", elapsedMs: 1 }],
    },
    truncated: true,
    reportPath: "/tmp/report.md",
  };
  const lines = visibleLines(renderResearchResult({
    content: [{ type: "text", text: "Final report" }], details,
  }, { expanded: true, isPartial: false }, theme).render(80));
  assert.deepEqual(lines, [
    "Subagent completed · 1 tool call · report clipped",
    "",
    "1. bash · 0s",
    "",
    "Full report: /tmp/report.md",
    "",
    "Final report",
  ]);
  assert.doesNotMatch(lines.join("\n"), /\n\n\n/);
});

test("expanded reports keep a blank boundary even when there is no tool history", () => {
  const lines = visibleLines(renderResearchResult({
    content: [{ type: "text", text: "Final report" }],
    details: { status: "completed", agent: "scout", task: "question", activity: { assistantMessages: 1, toolCalls: 0 } },
  }, { expanded: true, isPartial: false }, theme).render(80));
  assert.deepEqual(lines, ["Subagent completed · 0 tool calls", "", "Final report"]);
});

test("setup diagnostics remain visible when a result has no renderer details", () => {
  const component = renderResearchResult({
    content: [{ type: "text", text: "Configuration failed: operator action required." }], details: undefined as any,
  }, { expanded: true, isPartial: false }, theme);
  assert.match(component.render(40).join("\n"), /Configuration failed/);
});

test("partial rendering remains useful without a TUI-specific dependency", () => {
  const details: ResearchToolDetails = { status: "running", agent: "scout", task: "question" };
  const component = renderResearchResult({ content: [], details }, { expanded: false, isPartial: true }, theme);
  assert.match(component.render(20).join("\n"), /Subagent running/);
});
