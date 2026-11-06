import { readFileSync } from "node:fs";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { KETCH_TOOLS } from "./ketch.ts";

export const PROFILE_NAMES = Object.freeze(["scout", "researcher", "worker"] as const);
export type ProfileName = (typeof PROFILE_NAMES)[number];

/** Built-in Pi tools that may be selected by a bundled profile. */
export const NATIVE_TOOLS = Object.freeze(["read", "write", "edit", "bash", "grep", "find", "ls"] as const);
export const SUPPORTED_TOOLS = Object.freeze([...NATIVE_TOOLS, ...KETCH_TOOLS] as const);
export type SupportedToolName = (typeof SUPPORTED_TOOLS)[number];

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
  /** Effective allowlist from markdown, or the profile's current default when omitted. */
  readonly tools: readonly string[];
}

// These are the fallback defaults used when a profile omits tools frontmatter; markdown remains the source of truth when present.
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

function stripInlineComment(value: string): string {
  let quote: string | undefined;
  let escaped = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (quote === "\"" && escaped) {
      escaped = false;
      continue;
    }
    if (quote === "\"" && character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === "#" && (index === 0 || /\s/u.test(value[index - 1]!))) {
      return value.slice(0, index).trim();
    }
  }
  return value.trim();
}

function splitToolList(value: string): string[] {
  let source = value.trim();
  const array = source.startsWith("[");
  if (array !== source.endsWith("]")) throw new Error("expected an inline YAML array or comma-separated list");
  if (array) source = source.slice(1, -1).trim();
  if (!source) return [];

  const values: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!;
    if (quote) {
      if (quote === "\"" && character === "\\" && index + 1 < source.length) {
        current += source[++index]!;
      } else if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
    } else if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === ",") {
      values.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (quote) throw new Error("unterminated quote");
  values.push(current.trim());
  return values.map((tool) => {
    if (!tool) throw new Error("tool names must not be empty");
    return tool;
  });
}

function unwrapScalar(value: string): string {
  const quote = value[0];
  if (quote !== "\"" && quote !== "'") return value;
  let escaped = false;
  for (let index = 1; index < value.length; index++) {
    const character = value[index]!;
    if (quote === "\"" && escaped) { escaped = false; continue; }
    if (quote === "\"" && character === "\\") { escaped = true; continue; }
    if (character === quote) return index === value.length - 1 ? value.slice(1, -1) : value;
  }
  return value;
}

function parseTools(name: ProfileName, raw: string | undefined, defaults: readonly string[]): readonly string[] {
  if (raw === undefined) return defaults;
  const value = stripInlineComment(raw);
  if (!value) throw new Error(`Invalid ${name} prompt tools: expected [] or a comma-separated list.`);
  const unwrapped = unwrapScalar(value);
  if (!unwrapped.trim() && !/^\[\s*\]$/u.test(value)) {
    throw new Error(`Invalid ${name} prompt tools: expected [] or a comma-separated list.`);
  }
  let tools: string[];
  try { tools = splitToolList(unwrapped); }
  catch (error) {
    throw new Error(`Invalid ${name} prompt tools: ${error instanceof Error ? error.message : "invalid list"}.`);
  }
  const seen = new Set<string>();
  for (const tool of tools) {
    if (!(SUPPORTED_TOOLS as readonly string[]).includes(tool)) {
      throw new Error(`Invalid ${name} prompt tool "${tool}": unsupported tool name.`);
    }
    if (seen.has(tool)) throw new Error(`Invalid ${name} prompt tools: duplicate tool "${tool}".`);
    seen.add(tool);
  }
  return Object.freeze(tools);
}

export function parseProfilePrompt(name: ProfileName, source: string): ProfilePrompt {
  const match = /^(?:---\r?\n([\s\S]*?)\r?\n---\r?\n?)([\s\S]*)$/u.exec(source);
  const metadata: Record<string, string> = {};
  const text = match ? match[2]! : source;
  if (match) {
    for (const line of match[1]!.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      const separator = line.indexOf(":");
      if (separator <= 0) throw new Error(`Invalid ${name} prompt frontmatter: expected key: value.`);
      const key = line.slice(0, separator).trim();
      const value = stripInlineComment(line.slice(separator + 1));
      if (!value && key !== "tools") {
        throw new Error(`Invalid ${name} prompt frontmatter: unsupported or empty ${key}.`);
      }
      if (!["model", "thinking", "tools"].includes(key)) {
        throw new Error(`Invalid ${name} prompt frontmatter: unsupported or empty ${key}.`);
      }
      if (Object.hasOwn(metadata, key)) {
        throw new Error(`Invalid ${name} prompt frontmatter: duplicate ${key}.`);
      }
      metadata[key] = value;
    }
  }
  if (!text.trim()) throw new Error(`Bundled ${name} prompt is empty.`);
  const model = metadata.model?.replace(/^("|')|("|')$/gu, "");
  const thinking = metadata.thinking?.replace(/^("|')|("|')$/gu, "");
  if (model !== undefined && !MODEL_PATTERN.test(model)) {
    throw new Error(`Invalid ${name} prompt model: expected provider/model.`);
  }
  if (thinking !== undefined && !THINKING_LEVELS.includes(thinking as ThinkingLevel)) {
    throw new Error(`Invalid ${name} prompt thinking level: ${thinking}.`);
  }
  const defaults = getProfile(name).tools;
  return {
    text,
    tools: parseTools(name, metadata.tools, defaults),
    defaults: Object.freeze({
      ...(model !== undefined ? { model } : {}),
      ...(thinking !== undefined ? { thinking: thinking as ThinkingLevel } : {}),
    }),
  };
}

/** Add the request-local tool policy that frontmatter cannot convey after it is stripped. */
export function renderProfileSystemPrompt(profile: ProfilePrompt): string {
  const tools = profile.tools.length ? profile.tools.map((tool) => JSON.stringify(tool)).join(", ") : "none";
  return `${profile.text.trimEnd()}\n\nRuntime tool policy: this child session has exactly these effective tools (and no others): ${tools}.`;
}

export function loadProfilePrompt(name: ProfileName): string {
  return loadProfile(name).text;
}

export function loadProfileDefaults(name: ProfileName): ProfileDefaults {
  return loadProfile(name).defaults;
}

export function loadProfileTools(name: ProfileName): readonly string[] {
  return loadProfile(name).tools;
}

export function loadProfile(name: ProfileName): ProfilePrompt {
  const profile = getProfile(name);
  const path = new URL(`../agents/${profile.name}.md`, import.meta.url);
  return parseProfilePrompt(name, readFileSync(path, "utf8"));
}
