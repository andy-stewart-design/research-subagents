import { readFileSync } from "node:fs";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { KETCH_TOOLS } from "./ketch.ts";

export const PROFILE_NAMES = Object.freeze(["scout", "researcher"] as const);
export type ProfileName = (typeof PROFILE_NAMES)[number];

export const ResearchInputSchema = Type.Object(
  {
    agent: Type.Union([Type.Literal("scout"), Type.Literal("researcher")]),
    task: Type.String({
      minLength: 1,
      pattern: "\\S",
      description: "Self-contained research question and necessary context.",
    }),
  },
  { additionalProperties: false },
);

export type ResearchInput = Static<typeof ResearchInputSchema>;

export function parseResearchInput(input: unknown): ResearchInput {
  if (!Value.Check(ResearchInputSchema, input)) {
    throw new Error(
      'Invalid research input: provide only agent ("scout" or "researcher") and a non-whitespace task.',
    );
  }
  const { agent, task } = input as ResearchInput;
  // Keep the task literal: validation must not trim, expand, or execute it.
  return { agent, task };
}

export interface Profile {
  readonly name: ProfileName;
  readonly description: string;
  readonly tools: readonly string[];
}

// These are policy, not editable frontmatter or model-controlled tool overrides.
export const PROFILES: Readonly<Record<ProfileName, Profile>> = Object.freeze({
  scout: Object.freeze({
    name: "scout",
    description: "Read-only local code investigation with precise file references.",
    tools: Object.freeze(["read", "grep", "find", "ls"]),
  }),
  researcher: Object.freeze({
    name: "researcher",
    description: "External research with sourced, compact findings.",
    tools: KETCH_TOOLS,
  }),
});

export function getProfile(name: ProfileName): Profile {
  if (!Object.hasOwn(PROFILES, name)) {
    throw new Error("Unknown research profile: expected scout or researcher.");
  }
  return PROFILES[name];
}

export function loadProfilePrompt(name: ProfileName): string {
  const profile = getProfile(name);
  const path = new URL(`../agents/${profile.name}.md`, import.meta.url);
  const prompt = readFileSync(path, "utf8");
  if (!prompt.trim()) {
    throw new Error(`Bundled ${name} prompt is empty.`);
  }
  return prompt;
}
