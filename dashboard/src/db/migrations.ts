export interface Migration {
  readonly version: number;
  readonly sql: string;
}

const INIT = `
CREATE TABLE repo (
  id    INTEGER PRIMARY KEY,
  owner TEXT NOT NULL,
  name  TEXT NOT NULL,
  UNIQUE (owner, name)
);

CREATE TABLE pull_request (
  id          INTEGER PRIMARY KEY,
  repo_id     INTEGER NOT NULL REFERENCES repo(id),
  number      INTEGER NOT NULL,
  title       TEXT NOT NULL,
  author_login TEXT NOT NULL,
  state       TEXT NOT NULL,
  url         TEXT NOT NULL,
  head_sha    TEXT NOT NULL,
  base_sha    TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  merged_at   TEXT,
  UNIQUE (repo_id, number)
);

CREATE TABLE review (
  id               INTEGER PRIMARY KEY,
  pr_id            INTEGER NOT NULL REFERENCES pull_request(id),
  github_review_id INTEGER NOT NULL,
  author_login     TEXT NOT NULL,
  is_primary       INTEGER NOT NULL,
  role             TEXT,
  verdict          TEXT,
  summary          TEXT NOT NULL,
  commit_id        TEXT NOT NULL,
  submitted_at     TEXT NOT NULL,
  model            TEXT,
  agent            TEXT,
  tool_version     TEXT,
  machine          TEXT,
  claimed_at       TEXT,
  drifted          INTEGER,
  UNIQUE (pr_id, github_review_id)
);

CREATE TABLE review_note (
  id                INTEGER PRIMARY KEY,
  pr_id             INTEGER NOT NULL REFERENCES pull_request(id),
  github_comment_id INTEGER NOT NULL,
  path              TEXT NOT NULL,
  line              INTEGER,
  body              TEXT NOT NULL,
  author_login      TEXT NOT NULL,
  UNIQUE (pr_id, github_comment_id)
);

CREATE TABLE claim (
  id             INTEGER PRIMARY KEY,
  pr_id          INTEGER NOT NULL REFERENCES pull_request(id),
  reviewer_login TEXT NOT NULL,
  machine        TEXT NOT NULL,
  sha            TEXT NOT NULL,
  claimed_at     TEXT NOT NULL,
  model          TEXT,
  agent          TEXT,
  tool_version   TEXT,
  UNIQUE (pr_id, reviewer_login)
);

CREATE TABLE participant (
  id    INTEGER PRIMARY KEY,
  pr_id INTEGER NOT NULL REFERENCES pull_request(id),
  login TEXT NOT NULL,
  role  TEXT NOT NULL,
  UNIQUE (pr_id, login, role)
);

CREATE TABLE sync_run (
  id          INTEGER PRIMARY KEY,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  repos_json  TEXT NOT NULL,
  counts_json TEXT,
  ok          INTEGER NOT NULL DEFAULT 0
);
`;

export const MIGRATIONS: ReadonlyArray<Migration> = [{ version: 1, sql: INIT }];
