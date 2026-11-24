---
name: release-perso
description: Publish a personal release of this forked Obsidian plugin to GitHub so BRAT can install or update it. Use when the user asks to release, publish, ship, or deploy the plugin to BRAT, or to bump the version and push a build.
---

# Personal release for BRAT

One command bumps the version, formats, lints, builds, commits, tags, pushes and creates the GitHub release with `main.js`, `manifest.json` and `styles.css`.

## Run

```bash
npm run release:perso -- [patch|minor|major|x.y.z] [-m "release notes"] [--dry-run]
```

- No bump argument: if the current `manifest.json` version has never been released it is published as-is; otherwise the patch number is incremented.
- Use `minor` for features, `major` for breaking changes, or an explicit `x.y.z`.
- `--dry-run` only prints the version that would be released.
- Without `-m`, notes are the commit subjects since the previous tag.

## Agent procedure

1. Optionally run with `--dry-run` first to confirm the version.
2. Run `npm run release:perso -- <args>` and wait for it to finish (build takes under a minute).
3. Report the release URL printed at the end.

## Notes

- All uncommitted changes are included in the release commit (`git add -A`) on the current branch, which is pushed to `origin` (the fork, never the upstream repo).
- The tag is the bare version (no `v`), as BRAT and Obsidian require it to match `manifest.json`.
- Changesets are not used for personal releases; do not run `npm run version`.
- If the build or lint fails, version files are restored and nothing is committed.
- BRAT: **Add beta plugin** with `EleonoreBrants/obsidian-bases-kanban`. The plugin id is `kanban-bases-view-perso` (set in `manifest.json`; never change it after install).
