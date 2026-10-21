import { lstatSync } from "node:fs";
import { dirname, isAbsolute, join, parse } from "node:path";

/**
 * Resolve the repository root without invoking git or changing the workspace. A Pi cwd inside a
 * repository is common; report artifacts must be excluded from that repository, not just its cwd.
 * Non-git workspaces retain the caller's cwd as their root.
 */
export function resolveWorkspaceRoot(cwd: string): string {
  if (!isAbsolute(cwd)) throw new Error("Research workspace requires an absolute working directory.");
  let current = cwd;
  const root = parse(cwd).root;
  while (true) {
    try {
      lstatSync(join(current, ".git"));
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (current === root) return cwd;
    current = dirname(current);
  }
}
