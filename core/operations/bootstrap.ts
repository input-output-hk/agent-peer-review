import type { GitHubGateway } from "../github.js";
import { buildProfile } from "../labels.js";

export async function bootstrap(
  gh: GitHubGateway,
  opts: { repo: string; skillNames?: string[] },
): Promise<{ created: string[]; updated: string[]; unchanged: string[] }> {
  const out = { created: [] as string[], updated: [] as string[], unchanged: [] as string[] };
  // One list for the whole profile rather than one per label: ensureLabel would otherwise fetch the
  // same list twelve times on the user's very first command. Reusing the snapshot decides nothing
  // differently, because the profile's names are distinct, so creating or updating one label cannot
  // change the answer for any other.
  const existing = await gh.listLabels(opts.repo);
  for (const label of buildProfile(opts.skillNames)) {
    out[await gh.ensureLabel(opts.repo, label, existing)].push(label.name);
  }
  return out;
}
