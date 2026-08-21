---
sidebar_position: 15
---

# Releasing

Releases are cut on demand from `main`. A `Release` GitHub Actions workflow does the whole job in one run, so a release never means hand editing the version in its seven places again.

The two published packages, `@input-output-hk/agent-review` and `@input-output-hk/agent-review-pi`, are versioned in lockstep.

## Cut a release

1. Make sure the `## Unreleased` section of `CHANGELOG.md` lists the changes to ship. The release fails if that section is empty.
2. Open the repository's **Actions** tab, choose the **Release** workflow, click **Run workflow**, and keep the workflow branch set to `main` (the protected environment rejects any other branch).
3. Pick a `patch`, `minor`, or `major` bump, or type an explicit version such as `1.0.0`, then run it.

The workflow then:

1. resolves the exact commit at `main`, before any repository dependency runs,
2. validates the release candidate in an unprivileged job: it exercises the ordinary version and changelog scripts, verifies version, generated schemas, and lockfile integrity, and runs every CI lane,
3. starts a fresh job with no `node_modules` and uses the dependency-free `scripts/write-release.mjs` to make the same deterministic version, lockfile, and changelog edits,
4. commits those seven explicit files to `main` and creates the GitHub release.

Creating the release fires the existing `Publish` workflow. Its unprivileged job validates, tests, builds, and packs both packages with lifecycle scripts disabled; a separate environment-credentialed job downloads only those two tarballs and publishes them with `--ignore-scripts`. Its automatic `GITHUB_TOKEN` stays read-only, and only the protected environment supplies the package credential. A dependency process therefore never shares a runner with `RELEASE_TOKEN` or the package token. Publishing is idempotent: a version already on the registry is skipped, so a re-run is safe.

Every external action in CI, Pages, Release, and Publish is pinned to a full commit SHA. The human-readable version comment beside each pin records the upstream release; update the SHA and comment together when upgrading an action.

## One-time setup: the protected release environment

The workflow needs a `RELEASE_TOKEN` **environment secret**. The default `GITHUB_TOKEN` cannot be used, because a release created with it does not trigger the `Publish` workflow (GitHub does not cascade workflow runs from the default token).

Configure it as follows:

1. Create a **fine-grained personal access token** (GitHub → Settings → Developer settings → Fine-grained tokens):
   - Resource owner: `input-output-hk`.
   - Repository access: only `agent-peer-review`.
   - Repository permissions: **Contents: Read and write** (this covers pushing the release commit, tagging, and creating the release).
2. Open repository → Settings → Environments and [create or edit](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) the `release` environment.
3. Require at least one reviewer, enable **Prevent self-review**, and [restrict deployment branches/tags](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments#deployment-branches-and-tags) to a `main` branch rule and a separate `v*` tag rule. `main` admits the credentialed Release job; `v*` admits a release-triggered Publish job. For a manual Publish dispatch, select `main` in the workflow branch picker and name the tag in the required input.
4. Under **Environment variables**, add `RELEASE_ENVIRONMENT_CONFIGURED` with the exact value `true`. Both credentialed jobs check it because GitHub otherwise auto-creates a referenced-but-missing environment with no protection; the missing setup must fail closed.
5. Add the token under **Environment secrets** as `RELEASE_TOKEN`.
6. Create a dedicated **personal access token (classic)** for the package publisher with `write:packages` (and its implied `read:packages`) only, authorize it for the organization if SSO requires that, and add it to the same environment as `PACKAGE_TOKEN`. [GitHub's npm registry currently supports personal access tokens only in classic form](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry#authenticating-to-github-packages). A dedicated bot/service account keeps this package-only credential separate from the token that can push `main`.
7. Delete any repository-level `RELEASE_TOKEN`, `PACKAGE_TOKEN`, and `RELEASE_ENVIRONMENT_CONFIGURED`. Repository-wide values are intentionally not fallbacks: a collaborator could change a workflow on another in-repository branch, manually dispatch that branch's version, and request them before branch protection ever sees the file. The environment's deployment rules are what prevent that branch from reaching either credential. The Publish job's automatic `GITHUB_TOKEN` intentionally has no `packages: write`; publishing uses the environment-only `PACKAGE_TOKEN` instead.

The token owner must be able to push directly to `main`, including bypassing its required status check and signed-commit rule. The live branch protection requires the `build` check and signed commits but does not enforce either on administrators, so an administrator's token is the current release actor. A GitHub App installation token works only if its actor has the equivalent bypass permission; `contents: write` by itself is not enough.

The workflow's release commit carries a DCO sign-off (`git commit -s`) but is not cryptographically signed, since CI has no signing key. It therefore relies on the administrator exemption just described. If branch protection starts applying to administrators, or the release actor loses bypass permission, the push will be rejected; at that point give the workflow a signing identity or change the release design to merge a GitHub-signed release pull request rather than weakening the rule.

### Recovery if a release half-completes

The workflow commits and pushes the version bump to `main` before it creates the release, and the release step is retried and idempotent. If it still fails after the push, `main` is left bumped with an empty `## Unreleased` and no release. Do not re-run the workflow: it would try to bump again and fail (the version is no longer greater, and `## Unreleased` is now empty). Instead create the release by hand for the version already on `main`:

```bash
V="$(node -p "require('./package.json').version")"
# write the notes (copy the ## <version> section from CHANGELOG.md), then:
gh release create "v$V" --target main --title "v$V" --notes-file <notes>
```

That fires the `Publish` workflow as usual.

## Local tooling

The same scripts the workflow uses are available locally:

- `npm run version:set <patch|minor|major|X.Y.Z>` sets the version in every spot. Follow it with `npm install --package-lock-only` to sync the lockfile.
- `npm run check:version` fails if any spot has drifted from the root package version. This also runs in CI on every pull request.
- `npm run check:schemas` regenerates the published schemas and fails on drift. It runs in CI and again on both privileged release paths.
- `npm run check:lockfile` rejects resolved tarballs without an integrity hash except for the exact documented upstream shrinkwrap exemptions. It also runs in CI and both privileged release paths.
- `npm run changelog:release <version>` promotes `## Unreleased` to that version and prints the release notes.
- `node scripts/write-release.mjs <patch|minor|major|X.Y.Z> <notes-file>` is the dependency-free equivalent used only by the credentialed release job. It has focused release-file tests and is intentionally restricted to Node built-ins.

## Manual fallback

If the workflow is unavailable, a release can be cut by hand:

```bash
npm run version:set minor            # or patch / major / an explicit version
npm install --package-lock-only
npm run check:version
npm run check:schemas
npm run check:lockfile
npm run typecheck && npm test && npm run build && npm run -w pi build
V="$(node -p "require('./package.json').version")"
npm run changelog:release -- "$V" --notes-out /tmp/notes.md
# commit the result to main (through a pull request), then:
gh release create "v$V" --target main --title "v$V" --notes-file /tmp/notes.md
```
