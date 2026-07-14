# Verdandi Checkpoints

> **Historical v1 mechanism.** The checkpoint and anchor described here are local/same-host
> evidence, not an independent witness. [ADR-0001](adr-0001-action-receipt-ledger.md) requires an
> independently retained checkpoint plus clean-room restore proof before any v2 activation.

Verdandi checkpoints make hash-chain verification explicit and recurring.

`verdandi checkpoint [anchor-path]` verifies the full local audit-event hash
chain, inserts a row in `checkpoints`, and exits non-zero if verification fails.
When an anchor path is supplied, it also writes a small JSON file containing the
verified chain head. The anchor is local evidence only; Verdandi should not claim
RFC 3161/TSA backing until `tsa_response` is populated by a real timestamping
authority integration.

The checkpoint row commits before the anchor is atomically published. If anchor
publication fails, the verified database checkpoint remains recorded and the
command fails loudly; it never publishes a file for a rolled-back checkpoint.

Each new checkpoint also checks continuity against the latest previous verified
checkpoint. If that prior checkpoint points at a missing or changed event hash,
the new checkpoint is recorded as unverified and no anchor file is written.

The systemd timer in `systemd/` runs the command daily with
`VERDANDI_ANCHOR_PATH` set to a local `latest.json` anchor. A failed timer run is
an audit failure signal and should be investigated before trusting newer local
audit history.
