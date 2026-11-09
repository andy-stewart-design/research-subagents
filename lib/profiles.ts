import { readFileSync, readdirSync, type Dirent } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Type, type TSchema } from "typebox";
import { KETCH_TOOLS } from "./ketch.ts";

/** Built-in Pi tools that may be selected by a bundled profile. */
export const NATIVE_TOOLS = Object.freeze(["read", "write", "edit", "bash", "grep", "find", "ls"] as const);
export const SUPPORTED_TOOLS = Object.freeze([...NATIVE_TOOLS, ...KETCH_TOOLS] as const);
export type SupportedToolName = (typeof SUPPORTED_TOOLS)[number];

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const MODEL_PATTERN = /^[^/\s]+\/\S+$/u;
const SAFE_PROFILE_NAME = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u;
/** Keep seconds-to-milliseconds conversion exact and timer scheduling bounded by safe integers. */
export const MAX_TIMEOUT_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 1000);
const RESERVED_PROFILE_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const DEFAULT_AGENTS_DIR = fileURLToPath(new URL("../agents/", import.meta.url));

interface BundledFallback {
  readonly description: string;
  readonly tools: readonly string[];
}

const BUNDLED_FALLBACKS: Readonly<Record<string, BundledFallback>> = Object.freeze({
  scout: Object.freeze({
    description: "Read-only local code investigation with precise file references.",
    tools: Object.freeze(["read", "grep", "find", "ls"]),
  }),
  researcher: Object.freeze({
    description: "External research with sourced, compact findings.",
    tools: KETCH_TOOLS,
  }),
  worker: Object.freeze({
    description: "General-purpose repository implementation with file edits and shell verification.",
    tools: Object.freeze(["read", "write", "edit", "bash"]),
  }),
});

export interface Profile {
  readonly name: string;
  readonly description: string;
  readonly tools: readonly string[];
  /** Optional per-agent ceiling in seconds; zero explicitly means unlimited. */
  readonly maxTimeout?: number;
}

export interface ProfileDefaults {
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
}

export interface ProfilePrompt {
  readonly text: string;
  readonly defaults: ProfileDefaults;
  /** Optional per-agent ceiling in nonnegative seconds; zero means unlimited. */
  readonly maxTimeout?: number;
  /** Effective allowlist from markdown, or the profile's safe default when omitted. */
  readonly tools: readonly string[];
  /** Optional public description from frontmatter. */
  readonly description?: string;
}

export interface ProfileRegistry {
  readonly names: readonly string[];
  readonly profiles: Readonly<Record<string, Profile>>;
  readonly prompts: Readonly<Record<string, ProfilePrompt>>;
  readonly inputSchema: TSchema;
}

/** Profile names are discovered at runtime; this alias keeps public APIs open to custom names. */
export type ProfileName = string;
/** The names shipped by this package, for callers that want a narrower bundled-only type. */
export type BundledProfileName = "scout" | "researcher" | "worker";

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const key of Reflect.ownKeys(object)) deepFreeze(Reflect.get(object, key), seen);
  return Object.freeze(value);
}

function literalUnion(names: readonly string[]): TSchema {
  const literals = names.map((name) => Type.Literal(name));
  return literals.length === 1 ? literals[0]! : Type.Union(literals as unknown as [TSchema, TSchema, ...TSchema[]]);
}

export function createResearchInputSchema(registry: ProfileRegistry): TSchema {
  return deepFreeze(Type.Object(
    {
      agent: literalUnion(registry.names),
      task: Type.String({
        minLength: 1,
        pattern: "\\S",
        description: "Self-contained research question and necessary context.",
      }),
      timeout_ms: Type.Optional(
        Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER,
          description: "Optional per-call deadline in milliseconds; 0 means unlimited when permitted." }),
      ),
    },
    { additionalProperties: false },
  ));
}

export interface ResearchInput {
  readonly agent: ProfileName;
  readonly task: string;
  readonly timeout_ms?: number;
}

function profileNames(registry: ProfileRegistry): string {
  return registry.names.join('", "');
}

function validResearchInput(input: unknown, registry: ProfileRegistry): input is { agent: string; task: string; timeout_ms?: number } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  const keys = Reflect.ownKeys(value);
  if ((keys.length !== 2 && keys.length !== 3) || !Object.hasOwn(value, "agent") || !Object.hasOwn(value, "task")) return false;
  if (keys.length === 3 && !Object.hasOwn(value, "timeout_ms")) return false;
  if (Object.hasOwn(value, "timeout_ms") &&
    (!Number.isSafeInteger(value.timeout_ms) || (value.timeout_ms as number) < 0)) return false;
  return typeof value.agent === "string" && registry.names.includes(value.agent)
    && typeof value.task === "string" && value.task.length >= 1 && /\S/u.test(value.task);
}

export function parseResearchInput(input: unknown, registry?: ProfileRegistry): ResearchInput {
  const active = registry ?? DEFAULT_PROFILE_REGISTRY;
  // Do not rely solely on the exported TypeBox object: consumers can otherwise mutate a schema
  // before this parser sees it. Membership and exact shape are checked against this snapshot.
  if (!validResearchInput(input, active)) {
    throw new Error(
      `Invalid research input: provide only agent ("${profileNames(active)}") and a non-whitespace task.`,
    );
  }
  // Keep the task literal: validation must not trim, expand, or execute it.
  return {
    agent: input.agent,
    task: input.task,
    ...(Object.hasOwn(input, "timeout_ms") ? { timeout_ms: input.timeout_ms as number } : {}),
  };
}

function fallbackFor(name: string): BundledFallback | undefined {
  return Object.hasOwn(BUNDLED_FALLBACKS, name) ? BUNDLED_FALLBACKS[name] : undefined;
}

function defaultToolsFor(name: string): readonly string[] {
  // Existing bundled profiles retain their historical defaults. New profiles must opt into
  // tools explicitly; omission therefore fails closed with no effective tools.
  return fallbackFor(name)?.tools ?? [];
}

function stripInlineComment(value: string): string {
  let quote: string | undefined;
  let escaped = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (quote === "\"" && escaped) { escaped = false; continue; }
    if (quote === "\"" && character === "\\") { escaped = true; continue; }
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
      if (quote === "\"" && character === "\\" && index + 1 < source.length) current += source[++index]!;
      else if (character === quote) quote = undefined;
      else current += character;
    } else if (character === "\"" || character === "'") quote = character;
    else if (character === ",") { values.push(current.trim()); current = ""; }
    else current += character;
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

function parseTools(name: string, raw: string | undefined, defaults: readonly string[]): readonly string[] {
  if (raw === undefined) return defaults;
  const value = stripInlineComment(raw);
  if (!value) throw new Error(`Invalid ${name} prompt tools: expected [] or a comma-separated list.`);
  const unwrapped = unwrapScalar(value);
  if (!unwrapped.trim() && !/^\[\s*\]$/u.test(value)) {
    throw new Error(`Invalid ${name} prompt tools: expected [] or a comma-separated list.`);
  }
  let tools: string[];
  try { tools = splitToolList(unwrapped); }
  catch (error) { throw new Error(`Invalid ${name} prompt tools: ${error instanceof Error ? error.message : "invalid list"}.`); }
  const seen = new Set<string>();
  for (const tool of tools) {
    if (!(SUPPORTED_TOOLS as readonly string[]).includes(tool)) throw new Error(`Invalid ${name} prompt tool "${tool}": unsupported tool name.`);
    if (seen.has(tool)) throw new Error(`Invalid ${name} prompt tools: duplicate tool "${tool}".`);
    seen.add(tool);
  }
  return Object.freeze(tools);
}

interface ParsedFrontmatter {
  readonly metadata: Readonly<Record<string, string>>;
  readonly text: string;
}

function parseFrontmatter(name: string, source: string): ParsedFrontmatter {
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
      if (!value && key !== "tools") throw new Error(`Invalid ${name} prompt frontmatter: unsupported or empty ${key}.`);
      if (!["model", "thinking", "tools", "description", "maxTimeout"].includes(key)) {
        throw new Error(`Invalid ${name} prompt frontmatter: unsupported or empty ${key}.`);
      }
      if (Object.hasOwn(metadata, key)) throw new Error(`Invalid ${name} prompt frontmatter: duplicate ${key}.`);
      metadata[key] = value;
    }
  }
  return { metadata, text };
}

export function parseProfilePrompt(
  name: string,
  source: string,
  fallbackTools: readonly string[] = defaultToolsFor(name),
): ProfilePrompt {
  const { metadata, text } = parseFrontmatter(name, source);
  if (!text.trim()) throw new Error(`Bundled ${name} prompt is empty.`);
  const model = metadata.model === undefined ? undefined : unwrapScalar(metadata.model);
  const thinking = metadata.thinking === undefined ? undefined : unwrapScalar(metadata.thinking);
  const description = metadata.description === undefined ? undefined : unwrapScalar(metadata.description).trim();
  const rawMaxTimeout = metadata.maxTimeout === undefined ? undefined : unwrapScalar(metadata.maxTimeout).trim();
  let maxTimeout: number | undefined;
  if (rawMaxTimeout !== undefined) {
    if (!/^\d+$/u.test(rawMaxTimeout)) {
      throw new Error(`Invalid ${name} prompt maxTimeout: expected a nonnegative integer number of seconds.`);
    }
    maxTimeout = Number(rawMaxTimeout);
    if (!Number.isSafeInteger(maxTimeout) || maxTimeout > MAX_TIMEOUT_SECONDS) {
      throw new Error(`Invalid ${name} prompt maxTimeout: seconds exceed the safe timeout range.`);
    }
  }
  if (description !== undefined && !description) throw new Error(`Invalid ${name} prompt description: expected non-empty text.`);
  if (model !== undefined && !MODEL_PATTERN.test(model)) throw new Error(`Invalid ${name} prompt model: expected provider/model.`);
  if (thinking !== undefined && !THINKING_LEVELS.includes(thinking as ThinkingLevel)) throw new Error(`Invalid ${name} prompt thinking level: ${thinking}.`);
  return {
    text,
    ...(maxTimeout !== undefined ? { maxTimeout } : {}),
    tools: parseTools(name, metadata.tools, fallbackTools),
    defaults: Object.freeze({
      ...(model !== undefined ? { model } : {}),
      ...(thinking !== undefined ? { thinking: thinking as ThinkingLevel } : {}),
    }),
    ...(description !== undefined ? { description } : {}),
  };
}

function invalidAgentFilename(name: string): never {
  throw new Error(`Invalid agent filename "${name}": use a safe lowercase name such as reviewer.md.`);
}

function definitionFiles(agentsDir: string): Dirent[] {
  let entries: Dirent[];
  try { entries = readdirSync(agentsDir, { withFileTypes: true }); }
  catch (error) { throw new Error(`Unable to discover agents in ${agentsDir}.`, { cause: error }); }
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith("."))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function discoverProfiles(agentsDir = DEFAULT_AGENTS_DIR): ProfileRegistry {
  const files = definitionFiles(agentsDir);
  const profiles: Record<string, Profile> = Object.create(null) as Record<string, Profile>;
  const prompts: Record<string, ProfilePrompt> = Object.create(null) as Record<string, ProfilePrompt>;
  const names: string[] = [];
  for (const file of files) {
    if (file.name === "README.md") continue;
    const name = file.name.slice(0, -3);
    if (!SAFE_PROFILE_NAME.test(name) || RESERVED_PROFILE_NAMES.has(name)) invalidAgentFilename(file.name);
    if (Object.hasOwn(profiles, name)) throw new Error(`Duplicate agent definition for "${name}" in ${agentsDir}.`);
    const path = join(agentsDir, file.name);
    let source: string;
    try { source = readFileSync(path, "utf8"); }
    catch (error) { throw new Error(`Unable to read agent definition ${path}.`, { cause: error }); }
    let prompt: ProfilePrompt;
    try { prompt = parseProfilePrompt(name, source); }
    catch (error) { throw new Error(`Invalid agent definition ${path}: ${error instanceof Error ? error.message : "invalid definition"}`, { cause: error }); }
    const fallback = fallbackFor(name);
    const description = prompt.description || fallback?.description || `Custom ${name} agent.`;
    const profile = Object.freeze({
      name, description, tools: Object.freeze([...prompt.tools]),
      ...(prompt.maxTimeout !== undefined ? { maxTimeout: prompt.maxTimeout } : {}),
    });
    profiles[name] = profile;
    prompts[name] = Object.freeze({ ...prompt, description });
    names.push(name);
  }
  if (!names.length) throw new Error(`No agent definitions found in ${agentsDir}.`);
  names.sort((left, right) => {
    const leftIndex = Object.keys(BUNDLED_FALLBACKS).indexOf(left);
    const rightIndex = Object.keys(BUNDLED_FALLBACKS).indexOf(right);
    if (leftIndex >= 0 && rightIndex >= 0) return leftIndex - rightIndex;
    if (leftIndex >= 0) return -1;
    if (rightIndex >= 0) return 1;
    return left.localeCompare(right);
  });
  const frozenNames = Object.freeze(names);
  const orderedProfiles: Record<string, Profile> = Object.create(null) as Record<string, Profile>;
  const orderedPrompts: Record<string, ProfilePrompt> = Object.create(null) as Record<string, ProfilePrompt>;
  for (const name of frozenNames) {
    orderedProfiles[name] = profiles[name]!;
    orderedPrompts[name] = prompts[name]!;
  }
  return Object.freeze({
    names: frozenNames,
    profiles: Object.freeze(orderedProfiles),
    prompts: Object.freeze(orderedPrompts),
    inputSchema: createResearchInputSchema({
      names: frozenNames, profiles: orderedProfiles, prompts: orderedPrompts,
      inputSchema: undefined as unknown as TSchema,
    }),
  });
}

export const DEFAULT_PROFILE_REGISTRY = discoverProfiles();
export const PROFILE_NAMES = DEFAULT_PROFILE_REGISTRY.names;
export const PROFILES = DEFAULT_PROFILE_REGISTRY.profiles;
export const ResearchInputSchema = DEFAULT_PROFILE_REGISTRY.inputSchema;

export function getProfile(name: ProfileName, registry = DEFAULT_PROFILE_REGISTRY): Profile {
  if (!Object.hasOwn(registry.profiles, name)) {
    throw new Error(`Unknown research profile: expected ${registry.names.join(", ")}.`);
  }
  return registry.profiles[name]!;
}

export function loadProfilePrompt(name: ProfileName, registry = DEFAULT_PROFILE_REGISTRY): string {
  return loadProfile(name, registry).text;
}

export function loadProfileDefaults(name: ProfileName, registry = DEFAULT_PROFILE_REGISTRY): ProfileDefaults {
  return loadProfile(name, registry).defaults;
}

export function loadProfileTools(name: ProfileName, registry = DEFAULT_PROFILE_REGISTRY): readonly string[] {
  return loadProfile(name, registry).tools;
}

export function loadProfile(name: ProfileName, registry = DEFAULT_PROFILE_REGISTRY): ProfilePrompt {
  getProfile(name, registry);
  return registry.prompts[name]!;
}

/** Add the request-local tool policy that frontmatter cannot convey after it is stripped. */
export function renderProfileSystemPrompt(profile: ProfilePrompt): string {
  const tools = profile.tools.length ? profile.tools.map((tool) => JSON.stringify(tool)).join(", ") : "none";
  return `${profile.text.trimEnd()}\n\nRuntime tool policy: this child session has exactly these effective tools (and no others): ${tools}.`;
}

export function describeProfiles(registry = DEFAULT_PROFILE_REGISTRY): string {
  return registry.names.map((name) => `${name} (${registry.profiles[name]!.description})`).join("; ");
}
