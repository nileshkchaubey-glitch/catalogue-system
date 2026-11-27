# Development checkpoint

The production-equivalent source on `main` comes from the previously deployed
Sites commit `bae88f180b8db06fa0220d874c0be01a866b0cb6`. All application source,
the brand asset and the original fixture test are carried forward byte for
byte. The public export adds development documentation, a dependency lockfile,
and a hosting template in place of the live deployment identifier.

The deployed implementation supports hierarchical product browsing, overlapping
collections, shared and per-size photos, rate history, customer permission,
buyer enquiry and WhatsApp snapshots. Deployment and its R2 workspace are
independent of this source repository.

The `checkpoint/enterprise-wip` branch preserves an uncommitted working copy
from the same source revision. It contains partial schema 3 migration and
validation, editable taxonomy in the item form, purchase pricing, markup
calculation, photo galleries, upload and confirmation helpers. The new schema
and helper modules still need to be wired into the main workspace, quote
sharing, keyboard navigation and bulk price workflows. The older client
entry point and tests target schema 2. Treat this branch as unfinished
development and start integration from its exact commit.

The local integration on `feat/enterprise-integration` connects the schema 3
item editor to workspace taxonomy, search and revision-guarded saves. The
editor can save taxonomy, collections, galleries and purchase prices alongside
the item. Buyer projections keep pricing, rate history and contacts private.
Bulk pricing and quote records remain follow-up work.

For the later production storage transition, establish stable record IDs and
a normalized transactional store, then migrate taxonomy, families, variants,
customers, price history and media references using a repeatable import with
row-count and field-level reconciliation. Keep an immutable per-customer quote
record with a price snapshot. Validate permission boundaries and concurrent
updates before enabling team access. Move high-volume imports and image
processing to resumable jobs once catalogue size warrants it.

## Secure backend and quotations checkpoint — 2026-11-27

The feature branch adds a provisioned-owner login, private media gateway,
revisioned workspace bridge, non-destructive staging, customer-specific quote
snapshots, bulk pricing and browser acceptance fixtures. It does not activate
an imported workspace or replace the deployed R2 source of truth.

Verification on the locked source: TypeScript and production build passed;
16 regression tests passed. The interactive Windows Codex run reported all
7 browser-suite tests passed at desktop 1366x900 and touch-mobile 390x844.
An independent non-interactive remote Windows run passed four top-level
browser/Worker/launcher tests but Chrome exited at startup (code 0), so its
interactive workflow was not independently reproduced. Keep browser sandbox
security enabled. The local SQL permission suite, real Auth/Storage checks,
server-side validation boundary hardening, private export/media reconciliation,
and deployment remain release gates. The current JSONB bridge allows an
owner to bypass some Worker business rules via direct Data API writes.
Do not connect real business records or cut over before resolving these gates.
