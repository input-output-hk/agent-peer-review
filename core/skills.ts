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

const langPath = (name: string, config: Config): string => path.join(skillsRoot(config), "lang", `${name}.md`);

export function hasLanguageSkill(name: string, config: Config): boolean {
  return existsSync(langPath(name, config));
}

export function loadLanguageSkill(name: string, config: Config): string {
  return readFileSync(langPath(name, config), "utf8");
}

export function composeLanguages(names: string[], config: Config): Array<{ name: string; content: string }> {
  return names.filter((n) => hasLanguageSkill(n, config)).map((n) => ({ name: n, content: loadLanguageSkill(n, config) }));
}
