import type { GitHubGateway } from "@input-output-hk/agent-review";

/** The exact slice of the core gateway that `sync` depends on. `OctokitGateway` satisfies it. */
export type SyncGateway = Pick<
  GitHubGateway,
  "getAuthenticatedLogin" | "findAgentPulls" | "getReviews" | "listReviewComments" | "listComments"
>;
