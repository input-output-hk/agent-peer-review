/**
 * A repo-scoping `<select>`: "All repositories" plus one option per repo (rendered as
 * "owner/name"). Purely prop-driven -- the parent page owns both the repo list (from
 * `listRepos()`) and the current selection -- so this component does no fetching of its own.
 * `onChange` receives `undefined` for "All repositories" and a "owner/name" string otherwise,
 * matching the API's `?repo=` contract: omitting the param entirely is what "all" means.
 */
import type { RepoSummary } from "../types";

export interface RepoFilterProps {
  repos: RepoSummary[];
  value: string | undefined;
  onChange: (repo: string | undefined) => void;
}

const ALL_VALUE = "";

export function RepoFilter({ repos, value, onChange }: RepoFilterProps) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
      <span style={{ color: "var(--muted)", fontSize: "0.875rem" }}>Repository</span>
      <select
        value={value ?? ALL_VALUE}
        onChange={(event) => onChange(event.target.value === ALL_VALUE ? undefined : event.target.value)}
        style={{
          background: "var(--surface)",
          color: "var(--fg)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "0.35rem 0.5rem",
          font: "inherit",
        }}
      >
        <option value={ALL_VALUE}>All repositories</option>
        {repos.map((repo) => {
          const full = `${repo.owner}/${repo.name}`;
          return (
            <option key={full} value={full}>
              {full}
            </option>
          );
        })}
      </select>
    </label>
  );
}
