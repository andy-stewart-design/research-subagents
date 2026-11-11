import { readFileSync, readdirSync, type Dirent } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { isAlias, isMap, isScalar, isSeq, parseDocument, type Node, type ParsedNode } from "yaml";
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
          description: "Optional caller safety deadline in milliseconds. Omit for the configured profile default; zero also adds no caller restriction. Use only for an actual deadline or budget, not as a completion estimate." }),
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

const FRONTMATTER_KEYS = new Set(["model", "thinking", "tools", "description", "maxTimeout"]);

function yamlError(name: string, message: string): Error {
  const detail = message.replace(/\s+/gu, " ").trim().replace(/[.]$/u, "");
  return new Error(`Invalid ${name} prompt frontmatter: ${detail || "invalid YAML"}.`);
}

function toolsError(name: string, message: string): Error {
  const detail = message.replace(/\s+/gu, " ").trim().replace(/[.]$/u, "");
  return new Error(`Invalid ${name} prompt tools: ${detail || "invalid YAML"}.`);
}

function asToolsError(name: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : "invalid YAML";
  const prefix = `Invalid ${name} prompt frontmatter:`;
  return message.startsWith(prefix) ? new Error(message.replace(prefix, `Invalid ${name} prompt tools:`)) : toolsError(name, message);
}

/** Reject YAML features that could execute, expand, or mutate data outside this small schema. */
function assertSafeYamlNode(name: string, node: Node | null, path: string): void {
  if (node === null) throw yamlError(name, `null value at ${path} is not allowed`);
  if (isAlias(node)) throw yamlError(name, `aliases are not allowed at ${path}`);
  if (node.tag !== undefined) throw yamlError(name, `explicit YAML tags are not allowed at ${path}`);
  if (("anchor" in node) && node.anchor !== undefined) throw yamlError(name, `anchors are not allowed at ${path}`);
  if (isMap<ParsedNode, ParsedNode | null>(node)) {
    for (const pair of node.items) {
      assertSafeYamlNode(name, pair.key, `${path} key`);
      assertSafeYamlNode(name, pair.value, path);
    }
  } else if (isSeq<ParsedNode>(node)) {
    for (const [index, item] of node.items.entries()) assertSafeYamlNode(name, item, `${path}[${index}]`);
  }
}

function yamlValue(name: string, node: Node | null, path: string): unknown {
  assertSafeYamlNode(name, node, path);
  if (node === null) return null;
  if (isScalar(node)) return node.value;
  if (isSeq<ParsedNode>(node)) return node.items.map((item, index) => yamlValue(name, item, `${path}[${index}]`));
  if (isMap<ParsedNode, ParsedNode | null>(node)) {
    const value: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
        throw yamlError(name, `mapping keys at ${path} must be strings`);
      }
      value[pair.key.value] = yamlValue(name, pair.value, `${path}.${pair.key.value}`);
    }
    return value;
  }
  throw yamlError(name, `unsupported YAML value at ${path}`);
}

function splitToolList(value: string): string[] {
  const tools = value.split(",").map((tool) => tool.trim());
  if (!value.trim() || tools.some((tool) => !tool)) throw new Error("expected [] or a comma-separated list");
  return tools;
}

function parseTools(name: string, raw: unknown, defaults: readonly string[]): readonly string[] {
  if (raw === undefined) return defaults;
  let tools: unknown[];
  if (typeof raw === "string") {
    try { tools = splitToolList(raw); }
    catch (error) { throw toolsError(name, error instanceof Error ? error.message : "invalid list"); }
  } else if (Array.isArray(raw)) {
    tools = raw;
  } else {
    throw new Error(`Invalid ${name} prompt tools: expected a YAML sequence or comma-separated string.`);
  }
  if (!tools.length && !Array.isArray(raw)) {
    throw new Error(`Invalid ${name} prompt tools: expected [] or a comma-separated list.`);
  }
  const seen = new Set<string>();
  const names: string[] = [];
  for (const tool of tools) {
    if (typeof tool !== "string" || !tool.trim()) {
      throw new Error(`Invalid ${name} prompt tools: tool names must be strings.`);
    }
    if (!(SUPPORTED_TOOLS as readonly string[]).includes(tool)) throw new Error(`Invalid ${name} prompt tool "${tool}": unsupported tool name.`);
    if (seen.has(tool)) throw new Error(`Invalid ${name} prompt tools: duplicate tool "${tool}".`);
    seen.add(tool);
    names.push(tool);
  }
  return Object.freeze(names);
}

interface ParsedFrontmatter {
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly nodes: Readonly<Record<string, Node | null>>;
  readonly text: string;
}

function parseFrontmatter(name: string, source: string): ParsedFrontmatter {
  const match = /^(?:---\r?\n([\s\S]*?)\r?\n---\r?\n?)([\s\S]*)$/u.exec(source);
  const text = match ? match[2]! : source;
  if (!match) return {
    metadata: Object.freeze(Object.create(null) as Record<string, unknown>),
    nodes: Object.freeze(Object.create(null) as Record<string, Node | null>),
    text,
  };

  let document;
  try {
    document = parseDocument<ParsedNode>(match[1]!, {
      version: "1.2",
      schema: "core",
      customTags: [],
      resolveKnownTags: false,
      merge: false,
      uniqueKeys: false,
      stringKeys: true,
      strict: true,
    });
  } catch (error) {
    const prefix = /(?:^|\n)\s*tools\s*:/u.test(match[1]!) ? `Invalid ${name} prompt tools` : `Invalid ${name} prompt frontmatter`;
    const detail = error instanceof Error ? error.message.replace(/\s+/gu, " ").trim().replace(/[.]$/u, "") : "invalid YAML";
    throw new Error(`${prefix}: ${detail}.`);
  }
  if (isMap<ParsedNode, ParsedNode | null>(document.contents)) {
    const seen = new Set<string>();
    for (const pair of document.contents.items) {
      if (isScalar(pair.key) && typeof pair.key.value === "string") {
        if (seen.has(pair.key.value)) throw yamlError(name, `duplicate ${pair.key.value} frontmatter key`);
        seen.add(pair.key.value);
      }
    }
  }
  if (document.errors.length) {
    const error = document.errors[0]!;
    if (/(?:^|\n)\s*tools\s*:/u.test(match[1]!)) throw asToolsError(name, error);
    throw yamlError(name, error.message);
  }
  if (document.warnings.length) throw yamlError(name, document.warnings[0]!.message);
  if (!isMap<ParsedNode, ParsedNode | null>(document.contents)) throw yamlError(name, "frontmatter root must be a YAML mapping");
  assertSafeYamlNode(name, document.contents, "frontmatter");

  const metadata: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const nodes: Record<string, Node | null> = Object.create(null) as Record<string, Node | null>;
  for (const pair of document.contents.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
      throw yamlError(name, "frontmatter keys must be strings");
    }
    const key = pair.key.value;
    if (!FRONTMATTER_KEYS.has(key)) throw yamlError(name, `unsupported frontmatter key ${JSON.stringify(key)}`);
    if (Object.hasOwn(metadata, key)) throw yamlError(name, `duplicate ${key} frontmatter key`);
    if (key === "tools" && isSeq<ParsedNode>(pair.value) && pair.value.flow && pair.value.range) {
      const fragment = match[1]!.slice(pair.value.range[0], pair.value.range[2]);
      if (/,\s*\]$/u.test(fragment)) throw new Error(`Invalid ${name} prompt tools: trailing commas are not allowed.`);
    }
    try { metadata[key] = yamlValue(name, pair.value, key); }
    catch (error) {
      if (key === "tools") throw asToolsError(name, error);
      throw error;
    }
    nodes[key] = pair.value;
  }
  return { metadata: Object.freeze(metadata), nodes: Object.freeze(nodes), text };
}

export function parseProfilePrompt(
  name: string,
  source: string,
  fallbackTools: readonly string[] = defaultToolsFor(name),
): ProfilePrompt {
  const { metadata, nodes, text } = parseFrontmatter(name, source);
  if (!text.trim()) throw new Error(`Bundled ${name} prompt is empty.`);
  const model = metadata.model;
  const thinking = metadata.thinking;
  const description = metadata.description;
  const rawMaxTimeout = metadata.maxTimeout;
  if (model !== undefined && typeof model !== "string") throw new Error(`Invalid ${name} prompt model: expected a string.`);
  if (thinking !== undefined && typeof thinking !== "string") throw new Error(`Invalid ${name} prompt thinking: expected a string.`);
  if (description !== undefined && typeof description !== "string") throw new Error(`Invalid ${name} prompt description: expected a string.`);
  let maxTimeout: number | undefined;
  if (rawMaxTimeout !== undefined) {
    const node = nodes.maxTimeout;
    const sourceValue = isScalar(node) ? node.source : undefined;
    const plainInteger = typeof sourceValue === "string" && /^(?:0|[1-9]\d*)$/u.test(sourceValue);
    const quotedInteger = typeof rawMaxTimeout === "string" && /^\d+$/u.test(rawMaxTimeout)
      && isScalar(node) && node.type !== "PLAIN";
    if (typeof rawMaxTimeout === "number" && plainInteger && Number.isSafeInteger(rawMaxTimeout) && rawMaxTimeout >= 0) {
      maxTimeout = rawMaxTimeout;
    } else if (quotedInteger) {
      maxTimeout = Number(rawMaxTimeout);
    } else {
      throw new Error(`Invalid ${name} prompt maxTimeout: expected a nonnegative integer number of seconds.`);
    }
  }
  if (maxTimeout !== undefined && maxTimeout > MAX_TIMEOUT_SECONDS) {
    throw new Error(`Invalid ${name} prompt maxTimeout: seconds exceed the safe timeout range.`);
  }
  if (description !== undefined && !description.trim()) throw new Error(`Invalid ${name} prompt description: expected non-empty text.`);
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
    ...(description !== undefined ? { description: description.trim() } : {}),
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

function timeoutDescription(value: number | undefined): string {
  if (value === undefined) return "inherits the configured global timeout (absent/0 means unlimited)";
  if (value === 0) return "agent maxTimeout 0: unlimited";
  return `agent maximum ${value} seconds (effective default when timeout_ms is omitted or 0)`;
}

/** Public guidance derived from the immutable discovery snapshot, without inventing global values. */
export function describeTimeoutPolicy(registry = DEFAULT_PROFILE_REGISTRY): string {
  const profiles = registry.names.map((name) =>
    `${name}: ${timeoutDescription(registry.prompts[name]?.maxTimeout)}`).join("; ");
  return `Timeout policy: omit timeout_ms for ordinary delegation. It is a safety bound, not a target completion estimate; only shorten it for an actual explicit deadline or budget, never merely because a task sounds quick, small, or focused or because you guessed its runtime. Multi-file reviews and high-thinking implementation can take minutes. Values are milliseconds. The deadline starts after queue time when a child receives a slot; expiry includes a fixed 30-second grace period and bounded cleanup. The configured global timeout is the inherited default unless an agent maxTimeout is present. ${profiles}`;
}
