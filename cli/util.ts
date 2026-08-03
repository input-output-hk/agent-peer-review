import { readFileSync } from "node:fs";

export const csv = (v?: string): string[] => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
export const readMaybeFile = (v: string): string => (v.startsWith("@") ? readFileSync(v.slice(1), "utf8") : v);
export const repoOf = (o: { repo?: string }, defaultRepo?: string): string => {
  const r = o.repo ?? defaultRepo;
  if (!r) throw new Error("--repo is required (or set defaultRepo in your config)");
  return r;
};
