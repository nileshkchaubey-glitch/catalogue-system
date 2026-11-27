# Supabase staging and reconciliation

The deployed R2 schema 3 workspace is the source of truth. The local Supabase
sandbox has its own revisioned `catalogue_workspaces` table. The staging command
only inserts and reads `catalogue_workspace_imports`. Each owner and source
revision identifies one immutable staged export. The application has no route to
activate that export.

The bridge stores each schema 3 document as JSONB and preserves its existing
record IDs. Migration `20261127000300` removes client write grants on the active
workspace. The Worker checks the owner profile, document shape and quote
transition before calling `save_catalogue_workspace`. The RPC requires both the
owner's signed JWT and a Worker-only credential. It derives the owner from the
JWT's live Auth session and updates the row only when its revision matches the
expected revision. A null expected revision allows the first save only. Both
paths generate the new revision in PostgreSQL and return null on conflict.

The RPC runs the write as a dedicated `NOLOGIN` role subject to owner-scoped
RLS. It has grants for the workspace operation and no Storage or raw Auth
access. Owner profile reads also require a live session. The existing workspace,
staging and catalogue-media policies use that profile check. Quote confirmation
consumes the saved draft, calculates the total from the saved data and consent,
and preserves catalogue prices and history. Confirmed snapshots are immutable.
JSONB canonicalizes object keys. Review taxonomy display order on read-back and
normalize the relational schema before a production cutover.

## Local Supabase verification

Use a disposable stack from this repository with the Supabase CLI and Docker.
Keep the CLI unlinked, run `supabase start`, and check the running stack's local
ports before applying the migrations. Create synthetic password users via local
Studio Auth and insert exactly one `business_profiles` row for each intended
owner with a local database administrator. The application and local Auth
configuration both restrict registration to administrator provisioning. The
normal owner session has read-only access to its business profile. The migration
role must be able to create the scoped writer role and read the Auth session and
user columns referenced by the session check.

The versioned migrations reconstruct the supplied foundation on an empty local
stack. Existing profile rows and bucket settings are retained where the schema
matches. Before considering a hosted application, review the live profile
schema, grants, policies and bucket contract independently. The media migration
aborts if the named bucket's existing privacy, size or type settings differ.

### Local Worker write credential

Generate 32 random bytes offline and encode them as 64 lowercase hex characters.
Set that value as `CATALOGUE_WORKSPACE_WRITE_KEY` in the ignored local
`.dev.vars`. Keep it exclusively in the Worker environment. Compute the SHA-256
digest of the UTF-8 hex string offline and store only that digest as a local
database administrator. Keep the write header out of request logs and traces.

```sql
insert into catalogue_private.workspace_write_key (key_sha256)
values (decode('<64-character SHA-256 hex digest>', 'hex'))
on conflict (singleton) do update set key_sha256 = excluded.key_sha256;
```

Workspace saves fail closed until the Worker binding and database digest match.
A rotation replaces the digest and Worker binding. Saves fail during a mismatch.
The Worker uses the publishable key and user JWT for Auth, reads and Storage.
Only the workspace save RPC receives the write header. No service-role key is
used.

Run the SQL role and history checks against the disposable local stack. The
fixture users, workspace, staging rows and Storage metadata exist inside a
rolled-back transaction. Use the stack's local database password when prompted.

```powershell
psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -W -f supabase/verify-permissions.sql
```

The SQL check covers raw workspace write denial, revision checks, active session
claims, tenant scope, snapshot history and Storage metadata. Separately verify
Auth login and logout, simultaneous same-revision writes through the real Data
API, and private image upload and download for synthetic owners. Check any
hosted Storage policies and signed URL behavior before cutover. See [Supabase
local configuration](https://supabase.com/docs/guides/local-development/cli/config),
[Auth sessions](https://supabase.com/docs/guides/auth/sessions), [Row Level
Security](https://supabase.com/docs/guides/database/postgres/row-level-security),
and [Storage Access Control](https://supabase.com/docs/guides/storage/security/access-control).

### Hosted URL review

This Worker accepts loopback Supabase origins and rejects redirects. The stager
requires numeric loopback. Before adding hosted access, pin one explicitly
approved HTTPS project origin and keep redirect rejection. Verify the exact
origin, expected project keys, Data API headers and RPC behavior, Auth signup
settings, and private Storage policies on a disposable stack before reviewing
any hosted change.

## Stage a synthetic schema 3 export

Set `CATALOGUE_LOCAL_SUPABASE_URL` to the numeric loopback API origin, for example
`http://127.0.0.1:54321`. Set `CATALOGUE_SUPABASE_PUBLISHABLE_KEY` to its local
publishable key and `CATALOGUE_IMPORT_ACCESS_TOKEN` to a temporary user access
token issued by the same stack for a provisioned synthetic owner. Set these in
the process environment. Keep the JWT out of terminal output and temporary files.

```powershell
node scripts/stage-workspace.mjs exports/synthetic-schema3.json synthetic-r2-etag-1
```

Pass the exact source object revision alongside its export. The command verifies
the owner with local Auth, creates and verifies a uniquely named byte-for-byte
backup under the ignored `backups/` directory, reads back the staged document and
compares all JSON fields and collection, taxonomy, product, customer, price
history, quote and media-reference counts. The result reports counts, a backup
path and a SHA-256 digest without printing record contents. A repeat with the
same revision and fields reports `already-staged`. A revision collision with
different data stops and retains both records. The mismatch report includes
counts and up to 20 field paths without printing field values or custom keys.

Use only synthetic documents in this repository. The stager preserves media
references in the export. Independently back up and hash all referenced R2
objects before planning a real migration, and reconcile the copied image bytes
and owner paths as a separate step. Protect export and backup directories with
an owner-controlled filesystem ACL on Windows. The script requests private
creation modes where the platform supports them.

Stopping after a failed or successful stage leaves R2 and the active sandbox
document at their existing revisions. The isolated stage can be retained as
reconciliation evidence. The byte-for-byte backup and its hash allow a local
restage from the same source revision. Any eventual activation or rollback
needs its own reviewed procedure and rehearsal with verified R2 exports, media
backups and the prior application revision.
