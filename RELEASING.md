# Releasing

Releases are manual, single-PR changes. The maintainer owns the changelog voice,
merge decision, and publication timing. All packages share one version.

1. Create a `prepare-v<version>` branch.
2. Update `packages/emulate/package.json`.
3. Run `pnpm sync-versions`.
4. Add the changelog entry between `<!-- release:start -->` and
   `<!-- release:end -->` markers.
5. Remove those markers from the previous release so only the newest entry is
   selected.
6. Run the repository verification and open a PR.
7. Wait for explicit maintainer approval before merging.

After an approved merge, CI detects the npm version change, builds and publishes
all packages with provenance, creates the GitHub release, and uses the marked
changelog content as the release body. Monitor the workflow and verify the
published packages before reporting completion.
