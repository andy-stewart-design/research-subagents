import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { createFindToolDefinition, createGrepToolDefinition, defineTool, getAgentDir, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

export type ScoutBinary = "rg" | "fd";
export type ScoutBinaryCheck = (binary: ScoutBinary) => boolean;
// Pi 1.1.0 captures this managed directory when its tools module loads too.
const MANAGED_BIN = join(getAgentDir(), "bin");

/** Discovery only: never executes a probe, downloads software, or changes the process environment. */
export function hasScoutBinary(binary: ScoutBinary, managedDir = MANAGED_BIN, path = process.env.PATH ?? ""): boolean {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const usable = (file: string) => {
    try { accessSync(file, constants.X_OK); return statSync(file).isFile(); }
    catch { return false; }
  };
  const managed = join(managedDir, binary + suffix);
  // Native lookup prefers its managed entry even if it is broken; do not pretend PATH repairs it.
  if (existsSync(managed)) return usable(managed);
  for (const directory of path.split(delimiter)) {
    for (const name of binary === "fd" ? ["fd", "fdfind"] : ["rg"]) {
      if (usable(resolve(directory || ".", name + suffix))) return true;
    }
  }
  return false;
}

export function requireScoutBinary(binary: ScoutBinary, available: ScoutBinaryCheck): void {
  if (!available(binary)) {
    throw new Error(`Scout requires an already-installed ${binary === "rg" ? "ripgrep (rg)" : "fd (or fdfind)"} binary in Pi's managed bin directory or PATH. Install/configure it outside research and retry; automatic downloads are disabled for Scout.`);
  }
}

function guarded<T extends TSchema, D>(definition: ToolDefinition<T, D>, binary: ScoutBinary, available: ScoutBinaryCheck): ToolDefinition<T, D> {
  return {
    ...definition,
    execute: (...args: Parameters<typeof definition.execute>) => {
      // Native ensureTool() can download missing rg/fd. Check immediately before entering that
      // native implementation, including if a prerequisite disappears after startup.
      requireScoutBinary(binary, available);
      return definition.execute(...args);
    },
  };
}

/** Preserve native schemas/results/renderers; only withdraw the automatic-install fallback. */
export function createScoutTools(cwd: string, available: ScoutBinaryCheck): ToolDefinition[] {
  return [defineTool(guarded(createGrepToolDefinition(cwd), "rg", available)), defineTool(guarded(createFindToolDefinition(cwd), "fd", available))];
}
