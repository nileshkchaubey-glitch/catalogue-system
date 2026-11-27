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

For the later production storage transition, establish stable record IDs and
a normalized transactional store, then migrate taxonomy, families, variants,
customers, price history and media references using a repeatable import with
row-count and field-level reconciliation. Keep an immutable per-customer quote
record with a price snapshot. Validate permission boundaries and concurrent
updates before enabling team access. Move high-volume imports and image
processing to resumable jobs once catalogue size warrants it.
