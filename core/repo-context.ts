import type { GitHubGateway } from "./github.js";

const EXACT = ["AGENT.md", "AGENTS.md", "CLAUDE.md", ".claude/CLAUDE.md"];
const DIRS = [".claude", ".codex", ".claude/skills"];
const FILE_CAP = 10;
const SIZE_CAP = 65536;

export async function gatherRepoContext(
  gh: GitHubGateway, repo: string, ref: string,
): Promise<Array<{ path: string; content: string }>> {
  const out: Array<{ path: string; content: string }> = [];
  const seen = new Set<string>();
  let total = 0;
  const add = async (path: string) => {
    if (seen.has(path) || out.length >= FILE_CAP) return;
    seen.add(path);
    let content: string | null = null;
    try { content = await gh.getFileContent(repo, ref, path); } catch { return; }
    if (content == null) return;
    if (total + content.length > SIZE_CAP) return;
    total += content.length;
    out.push({ path, content });
  };
  for (const p of EXACT) { if (out.length >= FILE_CAP) break; await add(p); }
  for (const dir of DIRS) {
    if (out.length >= FILE_CAP) break;
    let entries: string[] = [];
    try { entries = await gh.listDir(repo, ref, dir); } catch { entries = []; }
    for (const e of entries) {
      if (out.length >= FILE_CAP) break;
      if (e.toLowerCase().endsWith(".md")) await add(e);
    }
  }
  return out;
}
