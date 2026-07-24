# Deployment checkout hygiene

Verdandi's dependency installation is immutable: deployment uses `npm ci` from
the committed `package-lock.json`. The root package metadata in that lockfile
must match `package.json` so this normal path does not rewrite the lockfile.

The deploy orchestrator may write `.deployed-commit` in its target checkout as
local provenance metadata. This is the only accepted deployment-local marker
in this repository, and it is intentionally ignored by Git. Ignoring it does
not change, replace, or bypass the orchestrator's source-revision binding and
validation.

After a reviewed change is merged, reconcile an existing deployment checkout
without discarding evidence of an unrelated edit:

1. Inspect `git status --short` and preserve or investigate every tracked
   diff before changing anything. `.deployed-commit` is the sole ignored
   deployment-local marker, not permission to discard another change.
2. Update the checkout through the normal guarded, revision-bound deployment
   path. Do not run an ad-hoc dependency update there.
3. Run `npm ci`, then confirm `git status --short` is empty. The ignored
   `.deployed-commit` may remain on disk and must continue to contain the
   revision written by the deploy orchestrator.

Do not use this procedure to deploy or start the currently inactive Verdandi
service; the recovery gate in `STATUS.md` still applies.
