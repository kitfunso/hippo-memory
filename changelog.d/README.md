# changelog.d

One file per pull request, folded into `CHANGELOG.md` when a release is cut.
A feature PR never edits `CHANGELOG.md` itself. Every PR used to add its own
`## Unreleased` block at the top of that file, so merging one PR put every other
open PR into conflict.

## Writing a fragment

Name the file after your branch with `/` turned into `-`, for example
`changelog.d/fix-stdin-idle-hang.md`. Use the same `###` headings and bullet style
as `CHANGELOG.md`, with no `##` heading:

```markdown
### Fixed

- **What changed, in one bold sentence.** Why it mattered and what a user sees now.
```

## Cutting a release

After the version bump, run `node scripts/changelog-fragments.mjs fold`, or pass a
`YYYY-MM-DD` date after `fold`. It writes a `## <version> - <date>` section at the
top of `CHANGELOG.md`, merges every fragment under shared headings (Added, Changed,
Fixed, Security and Documentation first, then any other heading in the order seen),
and deletes the fragments. `prepublishOnly` runs
`node scripts/changelog-fragments.mjs check` and refuses to publish while a fragment
is still here.
