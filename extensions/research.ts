import { getAgentDir, type AgentToolResult, type ExtensionAPI, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig, type DispatchDefaults, type ResearchConfig } from "../lib/config.ts";
import { createDiagnosticHandoff } from "../lib/report.ts";
import {
  detailsFromStatus, formatResearchProgress, previewTask, renderResearchCall, renderResearchResult,
  type ResearchToolDetails,
} from "../lib/render.ts";
import {
  describeProfiles, discoverProfiles, loadProfileTools, parseResearchInput,
  type ProfileRegistry, type ResearchInput,
} from "../lib/profiles.ts";
import { createResearchRunner, type ResearchRunStatus, type ResearchRunner } from "../lib/runner.ts";
import { KETCH_TOOLS, validateParentKetchTransport } from "../lib/ketch.ts";
import type { SessionOutcome } from "../lib/session.ts";
import { resolveWorkspaceRoot } from "../lib/workspace.ts";

const SUBAGENT_TOOL = "subagent";
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

const LOCAL_PATH_IN_TASK = /(?:^|\s)(?:~\/|\.\.?\/|\/(?:Users|home|tmp|private|var|opt|Volumes)\/|[A-Za-z]:[\\/])\S*/u;
const EXTERNAL_URL_IN_TASK = /\bhttps?:\/\//u;

const LOCAL_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);
const EXTERNAL_TOOLS = new Set(["bash", ...KETCH_TOOLS]);

function profileTaskError(input: ResearchInput, selectedTools: readonly string[]): string | undefined {
  const canInspectLocal = selectedTools.some((tool) => LOCAL_TOOLS.has(tool));
  const canRetrieveExternal = selectedTools.some((tool) => EXTERNAL_TOOLS.has(tool));
  if (LOCAL_PATH_IN_TASK.test(input.task) && !canInspectLocal) {
    return input.agent === "researcher"
      ? "Researcher is external-only and cannot inspect local paths. Delegate local repository/file work to scout instead."
      : `${input.agent} has no selected local-capable tools and cannot inspect local paths. Delegate local repository/file work to a profile with read, write, edit, bash, grep, find, or ls.`;
  }
  if (EXTERNAL_URL_IN_TASK.test(input.task) && !canRetrieveExternal) {
    return input.agent === "scout"
      ? "Scout is local-only and cannot retrieve external URLs. Delegate web/documentation work to researcher instead."
      : `${input.agent} has no selected external-capable tools and cannot retrieve external URLs. Delegate web/documentation work to a profile with bash or Ketch access.`;
  }
  return undefined;
}

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
  workspaceDir: string,
  signal: AbortSignal | undefined,
  profileRegistry: ProfileRegistry,
): Parameters<ResearchRunner["run"]>[1] {
  return {
    cwd: ctx.cwd,
    workspaceDir,
    agentDir,
    config,
    profileRegistry,
    parent: parentDefaults(ctx),
    ...(signal ? { signal } : {}),
  };
}

function finalDetails(
  input: ResearchInput,
  outcome: SessionOutcome,
  finalStatus?: ResearchRunStatus,
): ResearchToolDetails {
  return {
    status: outcome.status,
    agent: input.agent,
    task: previewTask(input.task),
    activity: finalStatus?.activity ?? outcome.activity,
    ...(finalStatus?.elapsedMs !== undefined ? { elapsedMs: finalStatus.elapsedMs } : {}),
    ...(finalStatus?.timeoutMs !== undefined ? { timeoutMs: finalStatus.timeoutMs } : {}),
    ...(finalStatus?.model !== undefined ? { model: finalStatus.model } : {}),
    ...(finalStatus?.thinkingLevel !== undefined ? { thinkingLevel: finalStatus.thinkingLevel } : {}),
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

function setupFailure(input: ResearchInput, error: unknown): ResearchToolResult {
  const handoff = createDiagnosticHandoff(error instanceof Error ? error.message : "Subagent setup failed.");
  const outcome: SessionOutcome = { status: "failed", handoff, activity: { assistantMessages: 0, toolCalls: 0 } };
  return {
    content: [{ type: "text", text: handoff.text }],
    details: finalDetails(input, outcome),
    structuredContent: finalStructured(outcome),
    isError: true,
  };
}

async function executeResearch(
  runner: ResearchRunner,
  config: ResearchConfig,
  agentDir: string,
  input: ResearchInput,
  ctx: ExtensionToolContext,
  signal: AbortSignal | undefined,
  onUpdate: ((result: ResearchToolResult) => void) | undefined,
  profileRegistry: ProfileRegistry,
): Promise<ResearchToolResult> {
  const workspaceDir = resolveWorkspaceRoot(ctx.cwd);
  let finalStatus: ResearchRunStatus | undefined;
  const outcome = await runner.run(input, sessionOptions(ctx, config, agentDir, workspaceDir, signal, profileRegistry), (status) => {
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
  readonly profileRegistry?: ProfileRegistry;
  readonly loadConfig?: (agentDir: string, registry?: ProfileRegistry) => ResearchConfig;
  readonly loadProfileTools?: (agent: ResearchInput["agent"]) => readonly string[];
  readonly createRunner?: (config: ResearchConfig, registry?: ProfileRegistry) => ResearchRunner;
}

export function createResearchExtension(dependencies: ResearchExtensionDependencies = {}) {
  // One immutable snapshot is shared by the public schema, config, launch, and child session.
  // Pi reloads the extension to pick up files added or removed from the bundled agents folder.
  const profileRegistry = dependencies.profileRegistry ?? discoverProfiles();
  const getAgentDirForExtension = dependencies.getAgentDir ?? getAgentDir;
  const loadConfigForExtension = dependencies.loadConfig ?? ((agentDir: string, registry?: ProfileRegistry) => loadConfig(agentDir, registry));
  const loadProfileToolsForExtension = dependencies.loadProfileTools ?? ((agent: ResearchInput["agent"]) => loadProfileTools(agent, profileRegistry));
  const createRunnerForExtension = dependencies.createRunner ?? ((config: ResearchConfig, registry?: ProfileRegistry) =>
    createResearchRunner(config, registry ? { profileRegistry: registry } : {}));
  const profilesDescription = describeProfiles(profileRegistry);

  return function (pi: ExtensionAPI) {
    let runner: ResearchRunner | undefined;
    let runnerConfig: ResearchConfig | undefined;

    const getRunner = (agentDir: string): ResearchRunner => {
      if (!runner) {
        runnerConfig = loadConfigForExtension(agentDir, profileRegistry);
        runner = createRunnerForExtension(runnerConfig, profileRegistry);
      }
      return runner;
    };

    pi.registerTool({
      name: SUBAGENT_TOOL,
      label: "subagent",
      description: `Delegate multi-step investigations or implementation tasks to a fresh isolated child. Available profiles: ${profilesDescription}. Use direct tools for a single focused lookup.`,
      promptSnippet: "delegate multi-step investigations to a fresh isolated context",
      promptGuidelines: [
        `Choose the profile whose description and explicit tool policy fit the task: ${profilesDescription}. If a task needs both research and implementation, make separate delegated calls rather than broadening a profile's access.`,
        "For investigations spanning multiple files or external sources, delegate to subagent instead of reproducing the work in the parent with read, bash, or codemode. Delegate implementation work to worker when the child should make changes.",
        "Use direct Ketch tools only for a single focused lookup that does not need a separate investigation context.",
        "Provide a self-contained question and constraints. The child cannot see the parent transcript or implementation tools.",
      ],
      parameters: profileRegistry.inputSchema,
      outputSchema: ResearchResultSchema,
      annotations: { openWorldHint: true },
      prepareArguments(args) {
        return parseResearchInput(args, profileRegistry);
      },
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const input = parseResearchInput(params, profileRegistry);
        try {
          const selectedTools = loadProfileToolsForExtension(input.agent);
          const taskError = profileTaskError(input, selectedTools);
          if (taskError) return setupFailure(input, new Error(taskError));
          const agentDir = getAgentDirForExtension();
          if (selectedTools.some((tool) => KETCH_TOOLS.includes(tool))) {
            const parentKetchError = validateParentKetchTransport(pi, ctx.cwd, agentDir, ctx.isProjectTrusted());
            if (parentKetchError) return setupFailure(input, new Error(parentKetchError));
          }
          return await executeResearch(getRunner(agentDir), runnerConfig!, agentDir, input, ctx, signal, onUpdate, profileRegistry);
        } catch (error) {
          return setupFailure(input, error);
        }
      },
      renderCall(args, theme, context) {
        return renderResearchCall(args as ResearchInput, theme, context);
      },
      renderResult(result, options, theme, context) {
        return renderResearchResult(result as ResearchToolResult, options, theme, context);
      },
    });

    // This hook runs before the tool executes and rejects malformed programmatic/model calls even
    // if a future SDK argument normalizer would otherwise coerce them into the schema.
    pi.on("tool_call", (event) => {
      if (event.toolName === SUBAGENT_TOOL) parseResearchInput(event.input, profileRegistry);
    });

    pi.on("session_shutdown", async () => {
      const current = runner;
      runner = undefined;
      runnerConfig = undefined;
      await current?.shutdown();
    });
  };
}

export default createResearchExtension();
