import { readFileSync } from "node:fs";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { KETCH_TOOLS } from "./ketch.ts";

export const PROFILE_NAMES = Object.freeze(["scout", "researcher", "worker"] as const);
export type ProfileName = (typeof PROFILE_NAMES)[number];

export const ResearchInputSchema = Type.Object(
  {
    agent: Type.Union([Type.Literal("scout"), Type.Literal("researcher"), Type.Literal("worker")]),
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
      'Invalid research input: provide only agent ("scout", "researcher", or "worker") and a non-whitespace task.',
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

export interface ProfileDefaults {
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
}

export interface ProfilePrompt {
  readonly text: string;
  readonly defaults: ProfileDefaults;
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
  worker: Object.freeze({
    name: "worker",
    description: "General-purpose repository implementation with file edits and shell verification.",
    tools: Object.freeze(["read", "write", "edit", "bash"]),
  }),
});

export function getProfile(name: ProfileName): Profile {
  if (!Object.hasOwn(PROFILES, name)) {
    throw new Error("Unknown research profile: expected scout, researcher, or worker.");
  }
  return PROFILES[name];
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const MODEL_PATTERN = /^[^/\s]+\/\S+$/u;

function parseProfilePrompt(name: ProfileName, source: string): ProfilePrompt {
  const match = /^(?:---\r?\n([\s\S]*?)\r?\n---\r?\n?)([\s\S]*)$/u.exec(source);
  const metadata: Record<string, string> = {};
  const text = match ? match[2]! : source;
  if (match) {
    for (const line of match[1]!.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      const separator = line.indexOf(":");
      if (separator <= 0) throw new Error(`Invalid ${name} prompt frontmatter: expected key: value.`);
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (!value || !["model", "thinking"].includes(key)) {
        throw new Error(`Invalid ${name} prompt frontmatter: unsupported or empty ${key}.`);
      }
      metadata[key] = value.replace(/^("|')|("|')$/gu, "");
    }
  }
  if (!text.trim()) throw new Error(`Bundled ${name} prompt is empty.`);
  if (metadata.model !== undefined && !MODEL_PATTERN.test(metadata.model)) {
    throw new Error(`Invalid ${name} prompt model: expected provider/model.`);
  }
  if (metadata.thinking !== undefined && !THINKING_LEVELS.includes(metadata.thinking as ThinkingLevel)) {
    throw new Error(`Invalid ${name} prompt thinking level: ${metadata.thinking}.`);
  }
  return {
    text,
    defaults: Object.freeze({
      ...(metadata.model !== undefined ? { model: metadata.model } : {}),
      ...(metadata.thinking !== undefined ? { thinking: metadata.thinking as ThinkingLevel } : {}),
    }),
  };
}

export function loadProfilePrompt(name: ProfileName): string {
  return loadProfile(name).text;
}

export function loadProfileDefaults(name: ProfileName): ProfileDefaults {
  return loadProfile(name).defaults;
}

export function loadProfile(name: ProfileName): ProfilePrompt {
  const profile = getProfile(name);
  const path = new URL(`../agents/${profile.name}.md`, import.meta.url);
  return parseProfilePrompt(name, readFileSync(path, "utf8"));
}
