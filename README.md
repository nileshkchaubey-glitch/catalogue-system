# XL Traders Catalogue Studio

Catalogue management for products, size variants, departments, collections,
customers, and selling rates. Owners can preview the buyer catalogue, prepare
customer quotations, and download confirmed quotes or product snapshots.

## Local development

Use Node.js 24 LTS and npm. The dependency manifest pins direct dependencies.
The lockfile records the dependency resolution for this export.

```sh
npm ci
npm run build
npm run dev
```

Before starting the app, start an unlinked local Supabase stack and provision a
synthetic password user and one matching business profile in the local Studio.
Follow the [local migration and provisioning guide](docs/supabase-staging.md).
Set `SUPABASE_URL` to the loopback API origin and `SUPABASE_PUBLISHABLE_KEY` to
that stack's publishable key in the ignored `.dev.vars` file. Configure the
Worker-only `CATALOGUE_WORKSPACE_WRITE_KEY` and its database digest using the
[local setup guide](docs/supabase-staging.md). The browser uses same-origin
requests with HTTP-only session cookies. Public signup is disabled.

Open `http://127.0.0.1:5173` and sign in using the provisioned account. Rebuild
after changing source. This checkpoint uses an isolated Supabase workspace
and the catalogue's existing INR price format.

Run the typecheck and the storage, editor and buyer-projection tests with:

```sh
npm run typecheck
npm test
```

Test the packaged Worker against an in-process synthetic Supabase fixture, then
run the desktop and touch-mobile flows with a local Chromium installation.
Build first with `npm run build`; the fixture serves that local bundle and stores
only synthetic data in memory. No Supabase stack, credentials, or paid service is
needed for these tests. Set `CHROMIUM_PATH` to choose an installed Chrome or Edge
executable if it is at a non-default path. Each run uses a disposable profile.

On Windows, the test runner must allow Chromium and its crash helper to start.
A restricted runner can fail before opening a page with `spawn EPERM`,
`TransactNamedPipe`, or `crash server failed to launch`. Rerun the local test with
approved normal Windows process permissions; keep the browser sandbox enabled.
Startup failures now include the executable, exit reason, and bounded browser
stderr. A transient Windows lock on `DevToolsActivePort` is retried within the
existing startup timeout.

```sh
node --test --test-isolation=none --test-name-pattern "Packaged Worker" tests/browser/browser.test.mjs
node --test --test-isolation=none tests/browser/*.test.mjs
```

## Source layout

| Path | Contents |
| --- | --- |
| `src/` | React workspace, sign-in, product editor, buyer preview, quotations, and bulk markup |
| `server/` | Auth gateway, Supabase adapter, catalogue API, validation, schema upgrades, and buyer projection |
| `supabase/` | Local Auth configuration, versioned SQL migrations, and SQL permission checks |
| `shared/taxonomy.json` | Default departments and categories plus legacy collection mappings |
| `public/logo.png` | XL Traders brand image |
| `scripts/` | Development launcher, Worker packaging, and schema 3 staging command |
| `wrangler.json` | Local Cloudflare Worker configuration |

The deployed R2 workspace is the source of truth. Staged imports retain source
IDs and media references for reconciliation. The staging archive, local editor
workspace, and deployed data stay independent. A later production cutover
requires reviewed migrations, verified authentication, workspace and media
reconciliation, and confirmation of hosting free-tier terms.

See [the development checkpoint](docs/development-checkpoint.md) and
[the storage migration guide](docs/storage-migrations.md).
