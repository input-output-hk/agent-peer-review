---
sidebar_position: 15
---

# Releasing

Releases are cut on demand from `main`. A `Release` GitHub Actions workflow does the whole job in one run, so a release never means hand editing the version in its seven places again.

The two published packages, `@input-output-hk/agent-review` and `@input-output-hk/agent-review-pi`, are versioned in lockstep.

## Cut a release

1. Make sure the `## Unreleased` section of `CHANGELOG.md` lists the changes to ship. The release fails if that section is empty.
2. Open the repository's **Actions** tab, choose the **Release** workflow, and click **Run workflow**.
3. Pick a `patch`, `minor`, or `major` bump, or type an explicit version such as `1.0.0`, then run it.

The workflow then:

1. bumps the version across every workspace with `scripts/version.ts` and syncs the lockfile,
2. verifies the version is consistent everywhere (`check:version`) and gates on a green build and test run,
3. promotes `## Unreleased` to `## <version>` in the changelog and captures those entries as the release notes,
4. commits the release to `main` and creates the GitHub release.

Creating the release fires the existing `Publish` workflow, which builds and publishes both packages to GitHub Packages. Publishing is idempotent: a version already on the registry is skipped, so a re-run is safe.

## One-time setup: the `RELEASE_TOKEN` secret

The workflow needs a `RELEASE_TOKEN` repository secret. The default `GITHUB_TOKEN` cannot be used, because a release created with it does not trigger the `Publish` workflow (GitHub does not cascade workflow runs from the default token).

Create a token whose owner can push to `main` and create releases, then store it:

1. Create a **fine-grained personal access token** (GitHub → Settings → Developer settings → Fine-grained tokens):
   - Resource owner: `input-output-hk`.
   - Repository access: only `agent-peer-review`.
   - Repository permissions: **Contents: Read and write** (this covers pushing the release commit, tagging, and creating the release).
2. Add it as a repository secret named `RELEASE_TOKEN` (repository → Settings → Secrets and variables → Actions → New repository secret).

The token owner must be able to push to `main`. Branch protection currently does not enforce restrictions on administrators, so an administrator's token can push the release commit directly. A GitHub App installation token with the same `contents: write` permission works too, and avoids per-user token expiry; mint it in the workflow and pass it as `RELEASE_TOKEN` if you prefer that over a personal token.

The workflow's release commit is DCO signed (`git commit -s`) but not GPG signed, since CI has no signing key. This is fine under the current protection, which only requires the `build` check. Do not turn on "Require signed commits" for `main` without first giving the workflow a signing key, or the release push will be rejected.

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
- `npm run changelog:release <version>` promotes `## Unreleased` to that version and prints the release notes.

## Manual fallback

If the workflow is unavailable, a release can be cut by hand:

```bash
npm run version:set minor            # or patch / major / an explicit version
npm install --package-lock-only
npm run check:version
npm run typecheck && npm test && npm run build && npm run -w pi build
V="$(node -p "require('./package.json').version")"
npm run changelog:release -- "$V" --notes-out /tmp/notes.md
# commit the result to main (through a pull request), then:
gh release create "v$V" --target main --title "v$V" --notes-file /tmp/notes.md
```
