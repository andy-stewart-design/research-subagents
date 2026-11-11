import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  DEFAULT_PROFILE_REGISTRY, getProfile, type ProfileDefaults, type ProfileModelRouting, type ProfileName, type ProfileRegistry,
} from "./profiles.ts";

export const CONFIG_FILENAME = "research-subagents.json";
export const DEFAULT_MAX_CONCURRENCY = 2;
export const THINKING_LEVELS = Object.freeze(
  ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[],
);

// A true end-of-string check also rejects trailing newlines; model IDs may contain slashes.
const MODEL_PATTERN = "^[^/\\s]+/\\S+(?![\\s\\S])";
const MODEL_VALUE_PATTERN = /^[^/\s]+\/\S+$/u;
const PROVIDER_PATTERN = /^[^/\s]+$/u;
const ThinkingSchema = Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)));

const ProfileOverridesSchema = Type.Object(
  {
    model: Type.Optional(Type.String({ pattern: MODEL_PATTERN })),
    thinking: Type.Optional(ThinkingSchema),
  },
  { additionalProperties: false },
);

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const key of Reflect.ownKeys(object)) deepFreeze(Reflect.get(object, key), seen);
  return Object.freeze(value);
}

export function createResearchConfigSchema(registry: ProfileRegistry): ReturnType<typeof Type.Object> {
  const profileProperties: Record<string, TSchema> = Object.create(null) as Record<string, TSchema>;
  for (const name of registry.names) profileProperties[name] = Type.Optional(ProfileOverridesSchema);
  return deepFreeze(Type.Object(
    {
      maxConcurrency: Type.Optional(
        Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      ),
      // 0 explicitly disables the global deadline; positive values are milliseconds.
      timeoutMs: Type.Optional(
        Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      ),
      profiles: Type.Optional(Type.Object(profileProperties, { additionalProperties: false })),
    },
    { additionalProperties: false },
  ));
}

export const ResearchConfigSchema = createResearchConfigSchema(DEFAULT_PROFILE_REGISTRY);
const CONFIG_REGISTRIES = new WeakMap<object, ProfileRegistry>();

export type ProfileOverrides = Readonly<Static<typeof ProfileOverridesSchema>>;

export interface ResearchConfig {
  readonly maxConcurrency: number;
  /** Undefined and zero both mean unlimited; positive values are milliseconds. */
  readonly timeoutMs?: number;
  readonly profiles: Readonly<Partial<Record<string, ProfileOverrides>>>;
}

export function parseConfig(input: unknown, registry: ProfileRegistry = DEFAULT_PROFILE_REGISTRY): ResearchConfig {
  const schema = createResearchConfigSchema(registry);
  if (!Value.Check(schema, input)) {
    const error = Value.Errors(schema, input)[0];
    throw new Error(
      `Invalid research configuration at ${error?.instancePath || "/"}: ${error?.message || "expected a configuration object"}`,
    );
  }
  const raw = input as {
    readonly maxConcurrency?: number;
    readonly timeoutMs?: number;
    readonly profiles?: Readonly<Record<string, ProfileOverrides>>;
  };
  const profiles: Partial<Record<ProfileName, ProfileOverrides>> = Object.create(null) as Partial<Record<ProfileName, ProfileOverrides>>;
  for (const name of registry.names) {
    const override = raw.profiles && Object.hasOwn(raw.profiles, name) ? raw.profiles[name] : undefined;
    if (override !== undefined) {
      (profiles as Record<string, ProfileOverrides>)[name] = Object.freeze({ ...override });
    }
  }
  const result = Object.freeze({
    maxConcurrency: raw.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
    ...(raw.timeoutMs !== undefined ? { timeoutMs: raw.timeoutMs } : {}),
    profiles: Object.freeze(profiles),
  });
  CONFIG_REGISTRIES.set(result, registry);
  return result;
}

// The future host supplies getAgentDir(); pure policy/config loading does not import or start Pi.
export function loadConfig(agentDir: string, registry?: ProfileRegistry): ResearchConfig {
  if (!isAbsolute(agentDir)) {
    throw new Error("Research configuration requires an absolute agent directory.");
  }
  const path = join(agentDir, CONFIG_FILENAME);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return parseConfig({}, registry ?? DEFAULT_PROFILE_REGISTRY);
    }
    throw new Error(`Unable to read research configuration at ${path}.`, { cause: error });
  }
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    // Do not echo the file's contents or silently replace an invalid configuration.
    throw new Error(`Invalid JSON in research configuration at ${path}.`);
  }
  try {
    return parseConfig(input, registry ?? DEFAULT_PROFILE_REGISTRY);
  } catch (error) {
    throw new Error(`Invalid research configuration file ${path}: ${(error as Error).message}`);
  }
}

export interface DispatchDefaults {
  readonly model?: { readonly provider: string; readonly id: string };
  readonly thinkingLevel?: ThinkingLevel;
}

export interface ModelSelection {
  readonly provider: string;
  readonly modelId: string;
  readonly thinkingLevel?: ThinkingLevel;
}

function targetSelection(name: string, target: string): { provider: string; modelId: string } {
  const separator = target.indexOf("/");
  const provider = target.slice(0, separator);
  const modelId = target.slice(separator + 1);
  if (!MODEL_VALUE_PATTERN.test(target) || !PROVIDER_PATTERN.test(provider) || !modelId) {
    throw new Error(
      `No valid model selected for ${name}: select a parent model or configure profiles.${name}.model as provider/id.`,
    );
  }
  return { provider, modelId };
}

function parentSelection(name: string, parent: DispatchDefaults): { provider: string; modelId: string } {
  const provider = parent.model?.provider;
  const modelId = parent.model?.id;
  if (!provider || !modelId || !PROVIDER_PATTERN.test(provider) || /\s/u.test(modelId)) {
    throw new Error(
      `No valid model selected for ${name}: select a parent model or configure profiles.${name}.model as provider/id.`,
    );
  }
  return { provider, modelId };
}

function routeSelection(name: string, routing: ProfileModelRouting, parent: DispatchDefaults): { provider: string; modelId: string } {
  const parentProvider = parent.model?.provider;
  // Exact own-property matching is intentional: providers such as openai and
  // openai-codex are distinct, and constructor/__proto__ are not inherited routes.
  if (parentProvider !== undefined && Object.hasOwn(routing.byProvider, parentProvider)) {
    return targetSelection(name, routing.byProvider[parentProvider]!);
  }
  return routing.fallback === "parent"
    ? parentSelection(name, parent)
    : targetSelection(name, routing.fallback);
}

// Selection data only: the SDK adapter must validate availability/auth and clamp thinking later.
export function selectModel(
  name: string,
  config: ResearchConfig,
  parent: DispatchDefaults,
  defaults: ProfileDefaults = {},
  registry?: ProfileRegistry,
): ModelSelection {
  const activeRegistry = registry ?? CONFIG_REGISTRIES.get(config) ?? DEFAULT_PROFILE_REGISTRY;
  getProfile(name, activeRegistry);
  const override = Object.hasOwn(config.profiles, name)
    ? (config.profiles as Readonly<Record<string, ProfileOverrides>>)[name]
    : undefined;
  const model = override?.model;
  const selected = model !== undefined
    ? targetSelection(name, model)
    : defaults.model === undefined
      ? parentSelection(name, parent)
      : typeof defaults.model === "string"
        ? targetSelection(name, defaults.model)
        : routeSelection(name, defaults.model, parent);
  const thinkingLevel = override?.thinking ?? defaults.thinking ?? parent.thinkingLevel;
  return {
    ...selected,
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
  };
}
