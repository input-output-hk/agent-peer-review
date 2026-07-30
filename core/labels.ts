import type { LabelSpec } from "./model.js";

export const TRIGGER = "agent";

export const SKILL_NAMES = [
  "security", "architecture", "performance", "testing", "api",
  "rust", "react-native", "did", "oid4vc", "cryptography", "documentation",
] as const;

export const COLORS = { trigger: "0e8a16", skill: "5319e7" } as const;

const isSkill = (label: string): boolean => (SKILL_NAMES as readonly string[]).includes(label);

export function parseSkills(labels: string[]): string[] {
  return labels.filter(isSkill);
}

export function composeRequestLabels(skills: string[]): string[] {
  return [TRIGGER, ...skills.filter(isSkill)];
}

export function buildProfile(skillNames: string[] = [...SKILL_NAMES]): LabelSpec[] {
  return [
    { name: TRIGGER, color: COLORS.trigger, description: "Request an AI agent review" },
    ...skillNames.map((n) => ({ name: n, color: COLORS.skill, description: `Load the ${n} review skill` })),
  ];
}
