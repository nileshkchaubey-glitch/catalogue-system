# Catalogue Studio release readiness and owner handover

Status: release preparation, NOT approved for production or data cutover.
The previously deployed Sites/R2 catalogue remains independent and unchanged.

## Current source and evidence

- Repository: nileshkchaubey-glitch/catalogue-system (public).
- Protected baseline main: 9e3ebc67413b9df85d79f35598f8fcf7b6c40684.
- Successful real integration baseline: cd2c3a8d4e3ec3b3b7c2a285d6b49598b3ace142.
  GitHub run 46071464009/job 140749131135: 38 regressions, build, all
  migrations, Auth and private Storage, revision conflicts, quotation integrity,
  real desktop/mobile browser acceptance and cleanup.
- A later read-only hosted inventory identified legacy policy names and a
  non-unique owner index not represented in the prior synthetic fixture.
- Real integration candidate 03a2caca8c0805224c2dda7c17c89a1e97431384:
  GitHub run 46109346577/job 140869170731 completed SUCCESS (attempt 1).
  All 45 regression tests, build, pinned database runtime, duplicate-owner
  rollback, revised three migrations, Auth, Storage replace/upsert/delete
  denial with byte readback, concurrent saves, quote history, verified backup
  restoration and local archive/media staging without activation, real
  desktop/mobile Chromium and cleanup passed on synthetic data.
- UI checkpoint 1a4bbcb0b8b04a2fadf1350fac2579985fdac1a5 adds product-editor
  Ctrl+S and mobile header wrapping, with no backend or migration changes.
  Dell production build and 8/8 packaged Worker/Chromium tests passed,
  including 1366x900 desktop and 390x844 touch mobile product creation,
  inline taxonomy and collections, discard/remove confirmation, save and
  reload. Full real-stack gate applies to the preceding SHA; final owner
  acceptance on actual migrated data remains required.
- Actual business data and image migration has not occurred. No release
  tag or deployment exists.

## Release gates (all must be accepted)

| Gate | Evidence required |
| --- | --- |
| Revised source | Clean exact candidate, relevant tests and build, successful real database gate |
| Source access | Authorized owner-controlled private export of the deployed workspace and referenced images; exact source revision |
| Backup | Original export retained byte-for-byte; manifest digest recorded separately; independent backup verified; restore rehearsed |
| Reconciliation | Stable IDs, all fields, counts, media hashes, price history, consent and immutable quote snapshots; display order confirmed |
| Hosting | Approved exact project/account, free plan confirmed, quota measured, Auth/Storage and HTTPS verified; no credentials in source |
| Final acceptance | Owner sign-in; product/variant editor, keyboard navigation, saves/reloads, bulk preview/confirm, quote and buyer snapshot sharing; desktop/mobile |
| Rollback | Prior app revision and source data retained; verified restore; defined write freeze and reconciliation of any post-cutover changes |
| Owner approval | Exact candidate SHA and reviewed checklist; separate approval for main merge, hosted changes and live deployment |

## Local setup and independent development

Use Node.js 24 LTS and the pinned dependency lockfile. Run npm ci, npm test,
npm run build. Follow the unlinked local stack and pinned runtime guide in
supabase-staging.md. The real integration gate uses only synthetic data and
standard public Ubuntu runners. Read the actual GitHub run/job logs. No workflow
should automatically deploy or merge the feature branch.

## Authorized export contract (external blocker)

The owner or authorized Sites/storage administrator must provide the exact
original workspace JSON bytes, the storage object's actual ETag/revision and
capture time, and every referenced original JPEG object, including primary,
gallery and variant override photos. The media files must be named by their
content SHA-256 without an extension. Capture the revision again after export
and refuse a changed revision; obtain a new consistent export instead.
If the raw source is schema 1/2 or contains inline photos, keep the untouched
original backup first and make a separately reviewed, deterministic schema 3
working copy; never silently replace or drop original fields. Do not use
public endpoints, browser-session workarounds, or unverified Cloudflare accounts.
The current connection has not established authorization for the Sites R2 bucket.

Keep the original and the derived copy in a private owner-controlled directory,
outside this repository. Do not send the export, media, pricing or customer data
to public CI or GitHub. Store the manifest digest separately.

Offline preparation after authorized capture:

    node scripts/prepare-legacy-export.mjs <original.json> <source-revision> <source-media-dir> <private-output-dir>

Use existing, separate private directories. This command retains the exact raw
JSON bytes, validates the supported unversioned/schema 2/schema 3 format, checks
stable legacy fields, materializes inline JPEG bytes, validates external content
hashes independently, deduplicates media files without deleting source
references, and generates a verified schema 3 backup plus a private preparation
receipt. It rejects unknown lossy mappings, corrupt media, and invalid records.
The receipt records the original department order for acceptance comparison.
No network, hosted access, workspace activation, or source writes occur.
Do not mistake this private derived copy for the second independent backup.
The script cannot certify the source ETag or authorized access; the source
administrator must establish these before preparation.

## Offline backup and local restore/staging rehearsal

Run the backup verification commands from supabase-staging.md in an isolated
checkout with no hosted access:

    node scripts/verify-migration-backup.mjs create <export.json> <revision> <media-directory>
    node scripts/verify-migration-backup.mjs verify <bundle-directory> <manifest-sha256>
    node scripts/verify-migration-backup.mjs restore <bundle-directory> <manifest-sha256> <private-recovery-directory>

The recovery location must be independently controlled (prefer another device
or private backup medium). A second directory on the same drive does not
protect against disk loss. Re-verify both copies. The script checks exact bytes,
media inventory and SHA-256, not the visual contents of all JPEGs.

For the isolated, provisioned owner on local Supabase, set the loopback URL,
local publishable key and temporary local owner JWT as process-only variables
per supabase-staging.md; never print the JWT. Then run:

    node scripts/stage-workspace.mjs --bundle <bundle-directory> <manifest-sha256>

The verified-bundle path reads the source manifest, verifies all file bytes,
uploads missing photos with upsert disabled, reads back their exact bytes,
and inserts or verifies the immutable archive record for the same source
revision. It does NOT activate an active workspace. Partial media from a failed
rehearsal is retained in the disposable sandbox; never treat a partial stage as
verified. On retry, an existing photo must match exactly. A conflicting archive
revision blocks writes. Review the reconciliation before activation.

JSONB can reorder object keys; verify actual department display order against
the original export and resolve differences before release. Array order and
fields must reconcile. Do not silently rebuild or reorder historical quotations.
If imported source includes confirmed snapshots, normal initial workspace save
rejects historical snapshots by design; an explicit reviewed, audited restore
procedure and a disposable rehearsal are required before activation. Do not
disable the normal quotation immutability triggers or invent historical data.
If the source has no confirmed snapshots, the first ordinary owner save may
be rehearsed after media and document reconciliation. Verify current workspace
is empty, use the approved source and normal CAS, and read back the entire
document. Actual hosted activation remains separately approved.

## Hosted configuration and cost constraints

Use one independently approved canonical HTTPS Supabase project origin, configured
in both SUPABASE_URL and CATALOGUE_APPROVED_SUPABASE_ORIGIN on the Worker. Set the
project publishable key and the Worker-only write capability as private runtime
bindings. Do not commit actual values. The project owner must configure admin
provisioning with public and anonymous signup disabled, and verify one profile
per owner, exact grants, RLS, media bucket and Data API. Generate the write
capability privately and store only its digest in the database. Do not deploy
with local URLs or a missing capability.

For the zero-cost plan, check actual dashboard usage before deployment.
Supabase Free currently advertises 500 MB database size, 1 GB file storage,
5 GB egress and 5 GB cached egress, and projects may pause after inactivity.
Paid automatic daily backups are not assumed; arrange independent private
exports and restore rehearsals. Cloudflare Workers Free has limits on requests,
CPU and worker size; verify the production bundle size and expected usage
against current official documentation. At the UI checkpoint the built single
Worker is 412065 bytes, gzip 151135 bytes, well below the published 3 MB
compressed Free plan limit. Free Workers currently advertise 100000 requests
per day and 10 ms CPU per HTTP request. Size is not CPU or usage certification:
measure realistic catalogue reads, saves and media with the actual owner data
before production approval. Neither the hosting account nor actual catalogue
volume has been verified for cutover. Do not enable billing or paid
features. Keep other projects untouched.

Official reference:
- https://supabase.com/pricing
- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/workers/platform/limits/

## Release and rollback sequence

1. Confirm export authorization and the current source revision; obtain and
   verify two private copies. Reconcile the disposable archive and every image.
2. Review the exact passing candidate and migration history. Do not rewrite
   the original hosted foundation history. Confirm hosted plan and approved
   origin; require separate approval before applying any hosted migration.
3. Provision an admin privately, validate signup denial, live session revocation
   and private storage. Keep all actual keys out of logs and source.
4. Schedule a write-freeze window before final copy and activation. Recheck
   exact source revision. Verify imported fields, stable IDs, media bytes and
   buyer projection with actual owner acceptance. Do not activate partial data.
5. Only with explicit approval integrate the feature branch, tag the reviewed
   version, deploy and smoke-test. Record exact source SHA and deployment ID.
6. If smoke test fails, stop new writes, restore the previous app route/revision
   using the verified backup and rollback plan. Preserve both data stores;
   reconcile any writes made after cutover before switching back. Never delete
   the original R2 data as part of a rollback.

## Operator handover record

Record the actual live URL, admin provisioning confirmation (not password),
reviewed SHA/release tag, final test links, verified private backup locations
and digest, source revision, quota usage, deployment revision and rollback
checklist in private owner-controlled records. Public Issue #1 gets sanitized
status and exact code/test IDs only. Do not claim a working live app, a real
backup or completed migration until the corresponding evidence exists.
