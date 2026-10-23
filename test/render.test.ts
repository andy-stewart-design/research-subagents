import assert from "node:assert/strict";
import test from "node:test";
import { formatResearchProgress, previewTask, renderResearchCall, renderResearchResult } from "../lib/render.ts";
import { Box, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { ResearchToolDetails } from "../lib/render.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => `**${text}**`,
} as any;

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
  assert.match(text, /Evidence only/);
  assert.doesNotMatch(text, /reasoning|tool transcript/i);
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
