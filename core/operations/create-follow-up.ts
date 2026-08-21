import { z } from "zod";
import type { GitHubGateway } from "../github.js";
import type { ReviewWorkspaceState } from "../workspace-state.js";
import { findFollowUpLink, followUpIssueMarker, serializeFollowUpLink } from "../follow-up.js";

export const CreateFollowUpInputSchema = z.object({
  repo: z.string().regex(/^[^/]+\/[^/]+$/),
  pr: z.number().int().positive(),
  reviewedSha: z.string().min(7),
  title: z.string().min(12).max(160),
  problem: z.string().min(80).max(8_000),
  rationale: z.string().min(40).max(4_000),
  acceptanceCriteria: z.array(z.string().min(12).max(500)).min(1).max(8),
  findingIds: z.array(z.string().min(1).max(160)).min(1).max(20),
});
export type CreateFollowUpInput = z.infer<typeof CreateFollowUpInputSchema>;
export interface CreateFollowUpResult {
  status: "created" | "already-exists";
  issue: number;
  url: string;
}

/** Create at most one meaningful, author-owned follow-up issue for a pull request. */
export async function createFollowUp(
  deps: { gh: GitHubGateway; workspace: ReviewWorkspaceState },
  input: CreateFollowUpInput,
): Promise<CreateFollowUpResult> {
  const req = CreateFollowUpInputSchema.parse(input);
  const { gh, workspace } = deps;
  const [pull, login, comments] = await Promise.all([
    gh.getPullRequest(req.repo, req.pr),
    gh.getAuthenticatedLogin(),
    gh.listComments(req.repo, req.pr),
  ]);
  if (pull.state !== "open") throw new Error(`PR ${req.repo}#${req.pr} is ${pull.state}, not open.`);
  if (login.toLowerCase() !== pull.author.toLowerCase()) {
    throw new Error(`A review follow-up must be created by pull request author ${pull.author}, not ${login}.`);
  }
  if (!workspace.clean) throw new Error("Follow-up creation refused: the local worktree or index is dirty.");
  if (workspace.headSha !== req.reviewedSha || pull.headSha !== req.reviewedSha) {
    throw new Error("Follow-up creation refused: local HEAD, remote PR head, and reviewedSha must match.");
  }

  const linked = findFollowUpLink(comments, login, req.pr);
  if (linked) return { status: "already-exists", issue: linked.issue, url: linked.url };

  const marker = followUpIssueMarker(req.pr);
  const recovered = await gh.findIssueByMarker(req.repo, marker, login);
  if (recovered) {
    await gh.createComment(req.repo, req.pr, [
      "## Follow-up",
      "",
      `The single follow-up for this pull request is [#${recovered.number}](${recovered.url}).`,
      "",
      serializeFollowUpLink({ v: 1, author: login, sourcePr: req.pr, issue: recovered.number, url: recovered.url }),
    ].join("\n"));
    return { status: "already-exists", issue: recovered.number, url: recovered.url };
  }

  const issueBody = [
    `Follow-up from #${req.pr} at \`${req.reviewedSha}\`.`,
    "",
    "## Problem",
    req.problem,
    "",
    "## Why this is a follow-up",
    req.rationale,
    "",
    "## Acceptance criteria",
    ...req.acceptanceCriteria.map((criterion) => `- [ ] ${criterion}`),
    "",
    `Related review findings: ${req.findingIds.map((id) => `\`${id}\``).join(", ")}`,
    "",
    marker,
  ].join("\n");
  const created = await gh.createIssue(req.repo, { title: `[Follow-up for #${req.pr}] ${req.title}`, body: issueBody });
  await gh.createComment(req.repo, req.pr, [
    "## Follow-up",
    "",
    `Created [#${created.number}](${created.url}) for the disproportionate work. Review may approve this PR only if its current blockers are resolved and this issue is a meaningful, bounded follow-up.`,
    "",
    serializeFollowUpLink({ v: 1, author: login, sourcePr: req.pr, issue: created.number, url: created.url }),
  ].join("\n"));
  return { status: "created", issue: created.number, url: created.url };
}
