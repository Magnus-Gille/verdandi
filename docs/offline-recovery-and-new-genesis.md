# Verdandi offline recovery and new genesis

This runbook is for the July 2026 loss of Verdandi's runtime directory on
`huginmunin`. Its first goal is to preserve the SD card as evidence. Its second
goal is to recover an intact, non-empty Verdandi hash chain if that can be done
within a bounded attempt. If recovery fails, Verdandi starts a documented new
genesis; it must never imply continuity with the lost chain.

## Incident facts and inference

Read-only checks on 2026-07-10 established:

- `verdandi.service` is enabled but inactive. Its last main-process result was
  `226/NAMESPACE`; it must remain stopped during recovery.
- The installed unit and `.env` pointed at
  `/home/magnus/repos/verdandi/data`.
- That directory, `verdandi.db`, `verdandi.db-wal`, and `verdandi.db-shm` are
  absent from all mounted filesystems on `huginmunin`.
- A filename/metadata search of the NAS found no Verdandi database candidate.
- The checkpoint service and timer were never installed, and there is no local
  checkpoint anchor.
- The SD card is `/dev/mmcblk0`, 63,281,561,600 bytes. Its root filesystem is
  ext4 on partition 2, starting at sector 1,064,960. Reconfirm these values on
  the removed card; do not select a device by name alone.
- Grimnir's rsync deployment uses `--delete` and did not exclude `data/`.
  The production checkout was updated on 2026-07-08. The best-supported cause
  is therefore deletion of the checkout-local runtime directory during that
  deployment. This is an inference, not proof from a retained deployment log.
- A prior system review described the live database as containing 67k+ events.
  Treat that as an approximate corroborating observation, not an acceptance
  oracle: the original database and checkpoint are unavailable.

The production storage contract after recovery is
`/home/magnus/.local/share/verdandi`. Runtime state must never live below the
rsync target `/home/magnus/repos/verdandi` again. The service also requires a
nonempty `generation.json` marker in that directory. Creating the directory
alone cannot silently initialize a new database.

## Hard safety rules

1. Do not start Verdandi, its checkpoint timer, or a deployment before the
   recovery/new-genesis decision is complete.
2. Do not run `fsck`, `e2fsck`, `debugfs -w`, or any repair against the source
   card or the master image.
3. Do not boot from the source card and do not mount its ext4 partition
   read-write. If a desktop auto-mounts it, unmount immediately.
4. Image the entire card before filesystem recovery. Work only from a copy of
   the master image.
5. Treat the image as highly sensitive: it contains the whole service host,
   including credentials. Keep it offline or on encrypted, access-controlled
   storage; do not upload it to Mimir, OneDrive, or another cloud service.
6. Preserve every recovered `verdandi.db`, `verdandi.db-wal`, and
   `verdandi.db-shm` together. Never inspect the only copy of a candidate.
7. A partially readable or chain-invalid database is forensic evidence, not a
   production restore candidate.

## Generation marker contract

`generation.json` is the operator's explicit authorization to start one audit
generation. It is not a substitute for a checkpoint or proof of continuity.
The reviewed systemd units only enforce that it is nonempty, so validate it
before installation and store it with mode `0600`.

Required fields are:

```json
{
  "version": 1,
  "generation": "new UUID",
  "created_at": "ISO-8601 timestamp",
  "operator": "Magnus",
  "origin": "recovered or new-genesis",
  "continuity": "recovered-chain-only or none",
  "incident": "verdandi-data-loss-2026-07",
  "recovery_evidence": {}
}
```

Before the first service start:

```bash
jq -e '
  .version == 1 and
  (.generation | type == "string" and length > 0) and
  (.created_at | type == "string" and length > 0) and
  ((.origin == "recovered" and .continuity == "recovered-chain-only") or
   (.origin == "new-genesis" and .continuity == "none"))
' /home/magnus/.local/share/verdandi/generation.json
chmod 0600 /home/magnus/.local/share/verdandi/generation.json
```

The only valid pairings are `recovered` + `recovered-chain-only` and
`new-genesis` + `none`. The recovery evidence object carries the hashes and
details specified in the applicable decision path below.

## Phase 1: physical outage and master image

This requires Magnus at the host and a Linux machine with an SD reader. M5 is a
reasonable recovery host if it has at least 130 GB free for a master and a
working copy. macOS does not provide the required native ext4 tooling.

1. Choose a quiet window. Confirm `verdandi.service` is inactive, then cleanly
   power down `huginmunin`:

   ```bash
   ssh magnus@huginmunin 'systemctl --user is-active verdandi.service; sudo poweroff'
   ```

2. Wait until the Pi's activity LED and fan stop, disconnect power, remove the
   SD card, and label it `HUGINMUNIN SOURCE 2026-07-10 — DO NOT BOOT`.
3. Attach it to the Linux recovery host. Identify it by size, partition layout,
   and serial. Replace `/dev/sdX` below only after checking all three:

   ```bash
   lsblk -b -o NAME,PATH,MODEL,SERIAL,SIZE,START,FSTYPE,MOUNTPOINTS,RO
   sudo umount /dev/sdX1 /dev/sdX2 2>/dev/null || true
   sudo blockdev --setro /dev/sdX
   sudo blockdev --getro /dev/sdX
   ```

   Expected card size: `63281561600`; expected ext4 partition start:
   `1064960`. A mismatch is a stop condition.
4. Acquire the master image with GNU ddrescue. The destination must not be the
   source card:

   ```bash
   mkdir -p verdandi-recovery-20260710
   cd verdandi-recovery-20260710
   sudo ddrescue -f -n /dev/sdX huginmunin-master.img huginmunin.map
   sudo ddrescue -d -r3 /dev/sdX huginmunin-master.img huginmunin.map
   sha256sum huginmunin-master.img huginmunin.map > SHA256SUMS
   sync
   ```

5. Disconnect and store the source card. Do not use it again unless the master
   image cannot be read.
6. Create a working copy and record its hash before recovery:

   ```bash
   cp --reflink=auto huginmunin-master.img huginmunin-working.img
   sha256sum huginmunin-working.img >> SHA256SUMS
   fdisk -l huginmunin-working.img
   ```

## Phase 2: bounded recovery on the working image

Budget: one pathname-aware recovery pass and one signature/filesystem-carving
pass, with at most four operator-hours after the master image exists. Preserve
the master image and stop when the budget expires; repeated speculative passes
do not justify extending the outage.

Attach only the working image, read-only:

```bash
loopdev=$(sudo losetup --find --show --read-only --partscan huginmunin-working.img)
lsblk -b -o NAME,PATH,SIZE,START,FSTYPE,MOUNTPOINTS,RO "$loopdev"
# Use ${loopdev}p2 below. Do not mount it read-write.
```

### Pass A: recover the known directory

Use an ext4 undelete tool against `${loopdev}p2`, writing results to a separate
filesystem. The target pathname is:

```text
home/magnus/repos/verdandi/data/verdandi.db
home/magnus/repos/verdandi/data/verdandi.db-wal
home/magnus/repos/verdandi/data/verdandi.db-shm
```

`extundelete` or `ext4magic` are appropriate for the pathname-aware pass. Read
the installed tool's help before running it; versions differ in their
time-window and output-directory flags. Do not use any in-place or repair mode.

### Pass B: deleted-inode and SQLite signature search

If Pass A finds nothing, use read-only Sleuth Kit (`fls`/`icat` or
`tsk_recover`) against the working image. The known partition offset for Sleuth
Kit is `1064960` 512-byte sectors, but reconfirm it with `fdisk -l` first.
Finally, use a SQLite-aware or PhotoRec signature carve for files beginning
with `SQLite format 3`. Carved files lose their names and may omit WAL content,
so every result is only a candidate.

For every candidate:

1. Copy it into its own directory. Include matching WAL/SHM sidecars when they
   were recovered from the same source and pass.
2. Hash that directory before inspection.
3. Run Verdandi's read-only inspector from a clean checkout of this revision:

   ```bash
   npm ci
   npm run build
   node dist/index.js inspect-recovery-candidate /recovery/candidate-01/verdandi.db \
     | tee /recovery/candidate-01/inspection.json
   ```

The inspector hashes the DB/WAL/SHM files, copies them to a disposable local
sandbox, opens only that copy with `readonly` and `fileMustExist`, and never
calls the migration/initialization path. It exits zero only when all of these
are true:

- SQLite `integrity_check` is `ok`;
- all required Verdandi tables exist;
- at least one historical event exists;
- the complete SHA-256 event chain verifies;
- evidence-file metadata and hashes are unchanged by inspection.

Record the event count and timestamp range. A count materially below the prior
67k+ observation is not automatically invalid, but must be called out as a
known coverage gap. Keep every partial candidate, inspection JSON, tool log,
and hash; never promote a candidate with `acceptable_for_restore: false`.

Detach the working image when the attempt ends:

```bash
sudo losetup --detach "$loopdev"
```

## Decision gate

### If an acceptable candidate exists

1. Keep the master image and recovery logs unchanged.
2. Reimage or reinstall the Pi only if separately required; this incident does
   not itself require modifying the OS.
3. On `huginmunin`, while Verdandi is still stopped, create the canonical
   storage directory and a staging directory:

   ```bash
   install -d -m 0700 /home/magnus/.local/share/verdandi
   install -d -m 0700 /home/magnus/.local/share/verdandi/recovery-staging
   ```

4. Transfer a copy of the candidate trio to staging, compare SHA-256 hashes at
   both ends, and rerun `inspect-recovery-candidate` on the staging copy.
5. With the service still inactive, move the validated trio into the canonical
   directory and set mode `0600`. Create a nonempty `generation.json` containing
   a new generation UUID, `origin: "recovered"`, the candidate hashes, recovered
   event count/head, master-image hash, and an honest continuity statement. Use
   `continuity: "recovered-chain-only"`: this means the recovered chain verifies;
   it does not claim an off-host anchor or proof that no tail events were lost.
   Install the reviewed service unit. Do not enable the checkpoint timer yet.
6. Start Verdandi once. Verify `/health`, authenticated `/api/verify`, event
   count, timestamp range, and `last_entry_hash` against the inspection report.
7. Stop on any discrepancy. Otherwise create the first local checkpoint and
   copy its anchor to the NAS as the off-host anchor. Only then enable the daily
   checkpoint timer and reopen ingest.

### If no acceptable candidate exists: documented new genesis

Do not place an empty database silently. Create
`/home/magnus/.local/share/verdandi/generation.json` first, containing:

- `generation`: a new UUID;
- `origin`: `"new-genesis"`;
- `continuity`: `"none"`;
- `created_at` and operator;
- incident identifier and this runbook revision;
- the master-image SHA-256 and recovery-log SHA-256 values;
- recovery passes attempted and their outcomes;
- explicit statement that the previous audit chain was lost and continuity is
  not claimed;
- approximate known loss window and the unverified prior `67k+` observation;
- `previous_chain_head: null` unless a trustworthy old anchor is later found.

Then:

1. Create the canonical directory with mode `0700`; confirm it is outside the
   deployment checkout.
2. Install the reviewed unit and ensure the obsolete checkout-local `data/`
   path is neither present nor configured.
3. Start Verdandi to create the new database. Its event count must begin at
   zero and its generation boundary must be reported as an incident, not as a
   successful restore.
4. Register fresh per-component keys. Do not assume any old key identity or
   scope survived the lost database.
5. Emit one explicit `system.audit_genesis`/incident event when that taxonomy
   is implemented; until then retain `generation.json` beside the database.
6. Verify the empty/new chain, create its first checkpoint, copy the anchor to
   the NAS, then enable the timer and reopen emitters one at a time.

## Post-incident prevention gates

- Verdandi's service and checkpoint units must both use
  `/home/magnus/.local/share/verdandi`.
- The service unit asserts that the directory already exists. A deployment
  also requires a nonempty `generation.json`; a directory alone cannot silently
  create a new empty generation.
- The checkpoint unit requires both `generation.json` and an existing nonempty
  `verdandi.db`, so checkpointing cannot initialize an empty database.
- Grimnir's deploy tooling must separately reject or preserve any service whose
  runtime data is below an rsync `--delete` target.
- The NAS anchor copy must be automated and monitored; a checkpoint stored only
  on `huginmunin` is not an off-host anchor.
- A restore drill must prove that DB + WAL/SHM + generation metadata can be
  restored without starting the service against an unvalidated candidate.
