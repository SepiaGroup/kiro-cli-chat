---
name: release
description: Release a new version of the extension (version bump, changelog, package, tag, publish to the VS Code Marketplace). Use when the user asks to cut, prepare or publish a release.
---

# Release

The steps are in [CONTRIBUTING.md](../../../CONTRIBUTING.md#release). For an
agent:

1. On a `release/<version>` branch: bump `version` in `package.json` (and
   `package-lock.json`, via `npm version <x.y.z> --no-git-tag-version`). Use
   semver: fixes → patch, features → minor.
2. In CHANGELOG.md, turn "unreleased" into the version and today's date, and
   check that every merged PR since the last tag is covered
   (`git log --oneline v<last>..main`).
3. `npm run compile`, `npm run lint`, `npm test`, `npm run package`, then
   install the `.vsix` and ask the user to run the TEST.md checklist.
4. Open the PR. After the user merges it, tag the merge commit:
   `git tag v<version> && git push origin v<version>` (only when asked).
5. Publishing needs the user's Marketplace token for the `SepiaGroup`
   publisher. Don't publish yourself; give the user the command
   (`npx vsce publish` from the tagged commit) or the `.vsix` to upload.
   Attach the `.vsix` to a GitHub release with `gh release create` if asked.
