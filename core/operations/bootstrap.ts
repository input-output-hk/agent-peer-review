import type { GitHubGateway } from "../github.js";
import { buildProfile } from "../labels.js";

export async function bootstrap(
  gh: GitHubGateway,
  opts: { repo: string; skillNames?: string[] },
): Promise<{ created: string[]; updated: string[]; unchanged: string[] }> {
  const out = { created: [] as string[], updated: [] as string[], unchanged: [] as string[] };
  for (const label of buildProfile(opts.skillNames)) {
    out[await gh.ensureLabel(opts.repo, label)].push(label.name);
  }
  return out;
}
