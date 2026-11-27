# Supabase staging and reconciliation

The deployed R2 schema 3 workspace is the source of truth. The local Supabase
sandbox has its own revisioned `catalogue_workspaces` table. The staging command
only inserts and reads `catalogue_workspace_imports`. Each owner and source
revision identifies one immutable staged export. The application has no route to
activate that export.

The bridge stores each schema 3 document as JSONB and preserves its existing
record IDs. It keeps workspace edits atomic and lets the Worker reject stale
revisions. Full document validation and quote calculation run in the Worker. The
database enforces tenant isolation, basic document shape, and append-only quote
snapshots with a saved draft and consent. Authenticated owners have direct Data
API access to their own workspace, where they can bypass Worker business rules
for ordinary edits. JSONB also canonicalizes object keys. Review taxonomy display
order on read-back before using real exports and normalize the relational schema
before a production cutover.

## Local Supabase verification

Use a disposable stack from this repository with the Supabase CLI and Docker.
Keep the CLI unlinked, run `supabase start`, and check the running stack's local
ports before applying the migrations. Create synthetic password users via local
Studio Auth and insert exactly one `business_profiles` row for each intended
owner with a local database administrator. The application and local Auth
configuration both restrict registration to administrator provisioning. The
normal owner session has read-only access to its business profile. Workspace and
media policies require a provisioned owner's signed-in identity.

The versioned migrations reconstruct the supplied foundation on an empty local
stack. Existing profile rows and bucket settings are retained where the schema
matches. Before considering a hosted application, review the live profile
schema, grants, policies and bucket contract independently. The media migration
aborts if the named bucket's existing privacy, size or type settings differ.

Run the SQL role and history checks against the disposable local stack. The
fixture users, workspace, staging rows and Storage metadata exist inside a
rolled-back transaction. Use the stack's local database password when prompted.

```powershell
psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -W -f supabase/verify-permissions.sql
```

The SQL check covers policy behavior on Storage metadata. Verify a real private
image upload and download through the local Storage API and an Auth login for
each synthetic owner separately. See [Supabase local configuration](https://supabase.com/docs/guides/local-development/cli/config), [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security), and [Storage Access Control](https://supabase.com/docs/guides/storage/security/access-control).

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
