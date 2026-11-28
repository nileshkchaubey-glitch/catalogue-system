# Catalogue Studio productivity and relational evolution

Status: first implementation slice, no hosted changes.
Baseline: e1e4ca8dbc12b734e84d71898ef76f5b3e718976 (Excel and gallery).

## Delivered in this slice

Fast Entry is a separate feature module. It uses existing editor validation,
price history rules and the protected workspace save/CAS contract. Save & Next
retains category, collections and default unit. New products are private drafts.
Duplicate clears name, prices, history, readiness and variant-specific photos;
shared photo reuse is opt-in. Variant TSV paste creates editable draft rows
and replacement requires confirmation. Existing Excel import/export is retained.

The provider-neutral ExtractionProposalV1 type models source provenance, nullable
unknown fields, confidence and evidence. The reviewed-product adapter uses the
same product-entry domain service; it has no direct database write path.
No external AI provider is connected and no paid API is used.

## Relational evolution (design, not yet applied)

Use separate product, pricing, media, customer and sharing repositories with
owner scope, explicit revision checks and bounded cursor pagination. Establish
baseline payload and latency on synthetic 100/1000/5000-variant workspaces.
Move data in additive migrations, never by replacing the existing database.

Proposed relational model (all business records owner-scoped):
- business/owner, department (stable ID + position), category (department FK);
- product family (category FK, revision, archived_at), variant (family FK,
  revision, nullable SKU, unit, numeric purchase/selling, verified availability);
- media (owner-scoped content digest), ordered family/variant media links;
- collection and collection membership (many-to-many);
- price events (append-only, previous/new rate, source, recorded_at);
- customers, immutable quotation snapshots and share grants;
- extraction job (source checksum, format, state, version, idempotency key,
  private source path, created/reviewed timestamps), extraction proposal
  (job FK, field path, nullable suggested value, confidence, evidence locator,
  review status and reviewed value).

Use owner-scoped composite foreign keys, unique normalized SKU/name where
appropriate, RLS and indexes. Preserve stable IDs, exact decimal amounts,
explicit department/gallery order and immutable quote history. Never invent
pack quantities, capacities, purchase costs or availability. Approved fields
may be applied through the same validated product service; AI proposals do not
authorize automatic publication. Proposal expiry and source deletion require
explicit policy; no customer data goes to third-party AI by default.

Add transactional product/variant upserts with per-record revisions and atomic
price events, then paginated reads/search and a measured cutover with synthetic
reconciliation, owner backup, rollback and approval. Do not bypass existing
gateway, sessions or quote guards. No live schema changes in this slice.

## Remaining roadmap

1. Relational repository/schema implementation and isolated reconciliation.
2. Bulk paste across products, inline rate edit and category presets.
3. Central media assignment, verified packaging conversions and catalogue health.
4. Secure expiring buyer shares, customer import and quotation reuse.
5. Private extraction job storage, reviewed proposal UI, provider integration
   only when cost and privacy requirements are approved.

## Essential test policy

Run a production build, focused unit tests for changed logic and one browser
smoke covering the new flow. Run database integration only when database,
auth or storage contracts actually change. No repetitive full Supabase gates
for this UI-only slice. Test with synthetic records only.
