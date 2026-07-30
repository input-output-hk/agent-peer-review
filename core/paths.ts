import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Config } from "./model.js";

export function findPackageRoot(fromDir = path.dirname(fileURLToPath(import.meta.url))): string {
  let dir = fromDir;
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("package.json not found above " + fromDir);
    dir = parent;
  }
}

export function skillsRoot(config: Config): string {
  return config.skillsDir ?? path.join(findPackageRoot(), "skills");
}

export function schemasRoot(): string {
  return path.join(findPackageRoot(), "schemas");
}
