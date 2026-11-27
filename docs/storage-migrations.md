# Storage and migrations

The deployed revision stores a versioned JSON workspace in R2 and keeps
deduplicated photos in the same binding. Its executable migration is the
`upgrade` function in [server/worker.mjs](../server/worker.mjs). There is no SQL
migration directory in this version.

The migration recognizes the original flat product records, creates one family
and one variant per legacy product, retains their IDs, prices, rate history and
customer records, and derives legacy collection memberships from the category
mapping. Schema 2 documents pass through directly. Reads upgrade the shape
in memory. A subsequent validated write persists the new shape using the
object revision as a concurrency guard. The test uses an in-memory bucket to
exercise migration, stale writes and buyer-visible fields.

The enterprise checkpoint adds the next executable migration to the same
module. It initializes taxonomy from the default mapping, initializes the
gallery empty and leaves purchase prices blank for existing variants. Verify
migration and rollback on a privately controlled copy before upgrading live
storage. Production data is provisioned and backed up separately from Git.
