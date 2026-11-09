import { createResearchInputSchema, type Profile, type ProfilePrompt, type ProfileRegistry } from "../../lib/profiles.ts";

/**
 * A process-local discovery snapshot for tests. It intentionally has no profile
 * maxTimeout, so runner timeout options remain the policy under test rather than
 * inheriting a user's agents/*.md ceiling.
 */
const names = Object.freeze(["scout", "researcher", "worker"]);
const tools = {
  scout: Object.freeze(["read", "grep", "find", "ls"]),
  researcher: Object.freeze(["mcp__ketch__search", "mcp__ketch__scrape", "mcp__ketch__code", "mcp__ketch__docs"]),
  worker: Object.freeze(["read", "write", "edit", "bash"]),
} as const;

const prompts: Record<string, ProfilePrompt> = Object.freeze({
  scout: Object.freeze({ text: "Fixture scout profile.", defaults: { thinking: "high" as const }, tools: tools.scout }),
  researcher: Object.freeze({ text: "Fixture researcher profile.", defaults: { thinking: "high" as const }, tools: tools.researcher }),
  worker: Object.freeze({ text: "Fixture worker profile.", defaults: { thinking: "high" as const }, tools: tools.worker }),
});
const profiles: Record<string, Profile> = Object.fromEntries(names.map((name) => [name, Object.freeze({
  name,
  description: `Fixture ${name} profile.`,
  tools: tools[name as keyof typeof tools],
})])) as Record<string, Profile>;

const snapshot = { names, profiles: Object.freeze(profiles), prompts } as ProfileRegistry;
/** Stable registry membership, tool policy, and timeout policy for unit/integration fixtures. */
export const TEST_PROFILE_REGISTRY: ProfileRegistry = Object.freeze({
  ...snapshot,
  inputSchema: createResearchInputSchema(snapshot),
});
