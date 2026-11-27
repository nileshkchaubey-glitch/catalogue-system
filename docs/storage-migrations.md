# R2 storage and schema upgrades

The deployed revision stores a versioned JSON workspace in R2 and keeps
deduplicated photos in the same binding. Its executable migration is the
`upgrade` function in [server/worker.mjs](../server/worker.mjs). For local
Supabase and the staged import, see [Supabase staging and reconciliation](supabase-staging.md).

The migration recognizes the original flat product records, creates one family
and one variant per legacy product, retains their IDs, prices, rate history and
customer records, and derives legacy collection memberships from the category
mapping. Existing schema 2 documents keep their families, variants and
collection memberships when they upgrade to schema 3. Reads upgrade the shape
in memory. A subsequent validated write persists schema 3 using the object
revision as a concurrency guard.

The schema 3 migration initializes taxonomy from the default mapping, creates
empty galleries and leaves purchase prices blank for existing variants. The
item editor saves the item, taxonomy and collections together. The buyer API
projects verified variants, their effective photo and the product gallery.
Synthetic tests use an in-memory bucket to exercise migration, editor saves,
stale writes and the buyer field allowlist.
