import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Config } from "./model.js";
import { skillsRoot } from "./paths.js";

const skillPath = (name: string, config: Config): string => path.join(skillsRoot(config), `${name}.md`);

export function hasSkill(name: string, config: Config): boolean {
  return existsSync(skillPath(name, config));
}

export function loadSkill(name: string, config: Config): string {
  return readFileSync(skillPath(name, config), "utf8");
}

export function composeInstructions(
  skillNames: string[],
  config: Config,
): { review: string; skills: Array<{ name: string; content: string }> } {
  const review = loadSkill("review", config);
  const skills = skillNames
    .filter((n) => hasSkill(n, config))
    .map((n) => ({ name: n, content: loadSkill(n, config) }));
  return { review, skills };
}
