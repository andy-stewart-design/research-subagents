import { getAgentDir, type AgentToolResult, type ExtensionAPI, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { KETCH_SERVER, createKetchServerConfig, waitForKetchCapabilities } from "./lib/ketch.ts";
import { loadConfig, type DispatchDefaults, type ResearchConfig } from "./lib/config.ts";
import {
  detailsFromStatus, formatResearchProgress, previewTask, renderResearchCall, renderResearchResult,
  type ResearchToolDetails,
} from "./lib/render.ts";
import { ResearchInputSchema, parseResearchInput } from "./lib/profiles.ts";
import { createResearchRunner, type ResearchRunStatus, type ResearchRunner } from "./lib/runner.ts";
import type { SessionOutcome } from "./lib/session.ts";

const RESEARCH_TOOL = "research";
const ResearchStatusSchema = Type.Union([
  Type.Literal("completed"), Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("timed_out"),
]);
const ResearchResultSchema = Type.Object({
  status: ResearchStatusSchema,
  report: Type.String(),
  truncated: Type.Boolean(),
  reportPath: Type.Optional(Type.String()),
}, { additionalProperties: false });

type ResearchToolResult = AgentToolResult<ResearchToolDetails>;

function parentDefaults(ctx: ExtensionToolContext): DispatchDefaults {
  return {
    ...(ctx.model ? { model: { provider: ctx.model.provider, id: ctx.model.id } } : {}),
    ...(ctx.thinkingLevel !== undefined ? { thinkingLevel: ctx.thinkingLevel } : {}),
  };
}

function sessionOptions(
  ctx: ExtensionToolContext,
  config: ResearchConfig,
  agentDir: string,
  signal: AbortSignal | undefined,
): Parameters<ResearchRunner["run"]>[1] {
  return {
    cwd: ctx.cwd,
    workspaceDir: ctx.cwd,
    agentDir,
    config,
    parent: parentDefaults(ctx),
    ...(signal ? { signal } : {}),
  };
}

function finalDetails(
  input: { agent: "scout" | "researcher"; task: string },
  outcome: SessionOutcome,
  finalStatus?: ResearchRunStatus,
): ResearchToolDetails {
  return {
    status: outcome.status,
    agent: input.agent,
    task: previewTask(input.task),
    activity: finalStatus?.activity ?? outcome.activity,
    ...(finalStatus?.elapsedMs !== undefined ? { elapsedMs: finalStatus.elapsedMs } : {}),
    ...(outcome.handoff.truncated ? { truncated: true } : {}),
    ...(outcome.handoff.reportPath ? { reportPath: outcome.handoff.reportPath } : {}),
  };
}

function finalStructured(outcome: SessionOutcome) {
  return {
    status: outcome.status,
    report: outcome.handoff.text,
    truncated: outcome.handoff.truncated,
    ...(outcome.handoff.reportPath ? { reportPath: outcome.handoff.reportPath } : {}),
  };
}

function progressResult(status: ResearchRunStatus): ResearchToolResult {
  return {
    content: [{ type: "text", text: formatResearchProgress(status) }],
    details: detailsFromStatus(status),
  };
}

async function executeResearch(
  runner: ResearchRunner,
  config: ResearchConfig,
  agentDir: string,
  input: { agent: "scout" | "researcher"; task: string },
  ctx: ExtensionToolContext,
  signal: AbortSignal | undefined,
  onUpdate: ((result: ResearchToolResult) => void) | undefined,
): Promise<ResearchToolResult> {
  let finalStatus: ResearchRunStatus | undefined;
  const outcome = await runner.run(input, sessionOptions(ctx, config, agentDir, signal), (status) => {
    finalStatus = status;
    try { onUpdate?.(progressResult(status)); } catch { /* Progress is never execution-critical. */ }
  });
  const details = finalDetails(input, outcome, finalStatus);
  return {
    content: [{ type: "text", text: outcome.handoff.text }],
    details,
    structuredContent: finalStructured(outcome),
    ...(outcome.usage ? { usage: outcome.usage } : {}),
    ...(outcome.status === "completed" && !outcome.handoff.isError ? {} : { isError: true }),
  };
}

export interface ResearchExtensionDependencies {
  readonly getAgentDir?: () => string;
  readonly loadConfig?: (agentDir: string) => ResearchConfig;
  readonly createRunner?: (config: ResearchConfig) => ResearchRunner;
}

export function createResearchExtension(dependencies: ResearchExtensionDependencies = {}) {
  const getAgentDirForExtension = dependencies.getAgentDir ?? getAgentDir;
  const loadConfigForExtension = dependencies.loadConfig ?? loadConfig;
  const createRunnerForExtension = dependencies.createRunner ?? createResearchRunner;

  return function (pi: ExtensionAPI) {
  if (!pi.getMcpServers().some((server) => server.name === KETCH_SERVER)) {
    pi.registerMcpServer(KETCH_SERVER, createKetchServerConfig("codemode"));
  }

  let startup: AbortController | undefined;
  let runner: ResearchRunner | undefined;
  let runnerConfig: ResearchConfig | undefined;

  const getRunner = (agentDir: string): ResearchRunner => {
    if (!runner) {
      runnerConfig = loadConfigForExtension(agentDir);
      runner = createRunnerForExtension(runnerConfig);
    }
    return runner;
  };

  pi.registerTool({
    name: RESEARCH_TOOL,
    label: "research",
    description: "Delegate one focused, read-only local or external research task to a fresh child context and return a compact evidence-backed report.",
    promptSnippet: "delegate focused research to a fresh isolated context",
    promptGuidelines: [
      "Use direct Ketch tools for simple lookups; use research for multi-step investigations that benefit from a fresh context.",
      "Provide a self-contained question and constraints. The child cannot see the parent transcript or implementation tools.",
    ],
    parameters: ResearchInputSchema,
    outputSchema: ResearchResultSchema,
    annotations: { openWorldHint: true },
    prepareArguments(args) {
      return parseResearchInput(args);
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const input = parseResearchInput(params);
      const agentDir = getAgentDirForExtension();
      return executeResearch(getRunner(agentDir), runnerConfig!, agentDir, input, ctx, signal, onUpdate);
    },
    renderCall(args, theme) {
      return renderResearchCall(args, theme);
    },
    renderResult(result, options, theme) {
      return renderResearchResult(result as ResearchToolResult, options, theme);
    },
  });

  // This hook runs before the tool executes and rejects malformed programmatic/model calls even
  // if a future SDK argument normalizer would otherwise coerce them into the schema.
  pi.on("tool_call", (event) => {
    if (event.toolName === RESEARCH_TOOL) parseResearchInput(event.input);
  });

  pi.on("session_start", (_event, ctx) => {
    startup?.abort();
    const current = new AbortController();
    startup = current;
    void waitForKetchCapabilities(pi, { mode: "parent", signal: current.signal })
      .then(() => {
        if (!current.signal.aborted && !pi.getActiveTools().includes("codemode")) {
          ctx.ui.notify("Ketch is available, but codemode is inactive. Enable Pi's native codemode tool to call Ketch programmatically.", "warning");
        }
      })
      .catch((error: unknown) => {
        if (!current.signal.aborted) {
          ctx.ui.notify(error instanceof Error ? error.message : "Ketch startup failed.", "warning");
        }
      });
  });

  pi.on("session_shutdown", async () => {
    startup?.abort();
    startup = undefined;
    const current = runner;
    runner = undefined;
    runnerConfig = undefined;
    await current?.shutdown();
  });
  };
}

export default createResearchExtension();
