# BongoCat Upstream Triage

MochiPaw tracks selected work from its upstream project,
[ayangweb/BongoCat](https://github.com/ayangweb/BongoCat). The `upstream`
remote is read-only and must never be pushed to.

## Sync Procedure

1. Fetch upstream references:

   ```powershell
   git fetch upstream --prune
   ```

2. Review upstream issues and pull requests without copying long discussions.
   Migrate a work item only when it applies to MochiPaw, is not already
   addressed, and has enough detail to implement or reproduce.
3. Create a MochiPaw issue containing the upstream URL and author. Apply the
   `upstream` label, plus `upstream-pr` for a port candidate or
   `needs-reproduction` for an unverified bug report.
4. Port pull requests through a new MochiPaw branch. Do not merge an upstream
   branch directly. Revalidate dependencies, permissions, platform behavior,
   and MochiPaw-specific changes made since the fork.
5. Before merging a MochiPaw pull request, apply its classification label,
   complete a code review, and use GitHub Squash and merge.

## Initial Snapshot

The initial review on 2026-07-17 created MochiPaw issues #10 through #20 for
selected upstream work. Related feature requests and bug reports were combined
into a single local task where they shared an implementation path.

Upstream PR #989 was not migrated because its model import and deletion fixes
were already covered by MochiPaw's importer and transactional delete logic. It
should be reconsidered only if a reproducible MochiPaw regression appears.
