# Catalogue Studio engineering instructions

## Scope and authority

Continue this repository, do not rebuild the application or alter other XL
projects. The original Sites/R2 workspace is the source of truth until the owner
explicitly approves and verifies cutover. Continuous development approval covers
routine fixes, feature-branch commits/pushes and necessary standard free public
GitHub Actions tests only. No paid resources, main merge, hosted database changes,
live deployment, or unauthorized access to sensitive data. Stop at release gates.

The repository is public. Never commit customer records, business data, purchase
or private selling prices, actual catalogue photos, production bindings, exports,
passwords, tokens, keys or raw diagnostics. Use synthetic test records only. Keep
real exports and independent backups in owner-controlled private locations,
outside the repository. Do not obtain data by exploiting an exposed endpoint.

## Engineering workflow

- Read docs/release-handover.md and the latest Issue #1 comments. Verify exact
  local and remote SHA, migration history and CI results before changing source.
- Use Node.js 24 LTS, npm ci, npm test and npm run build. Run focused tests first
  after narrow changes. Use the pinned isolated Supabase runtime for database,
  Auth, Storage and browser acceptance; do not repeat already valid gates without
  a relevant change. Never use real data on public CI.
- Keep owner/session checks, RLS, write capability, CAS, immutable quotation
  history and private content-addressed media intact. No weakening tests to
  obtain a green result. Stop on missing or mismatched image bytes and conflicts.
- Keep changes in a clean feature branch, record exact commit and test evidence,
  preserve source and release rollback. A successful CI is not deployment approval.
- Do not print secrets or private records in logs, commits, or issue comments.
- Release approval is separate from development. No publication of a GitHub
  release, main merge, hosted migration or deployment without the owner's approval.

Read docs/supabase-staging.md, docs/storage-migrations.md and the release handover
for the supported rehearsal and recovery commands.
