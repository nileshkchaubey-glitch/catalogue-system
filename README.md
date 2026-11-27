# XL Traders Catalogue Studio

Catalogue management for products, size variants, departments, collections,
customers, and selling rates. The app also prepares a buyer catalogue and
WhatsApp links or product snapshots.

## Local development

Use Node.js 24 LTS and npm. The dependency manifest pins direct dependencies.
The lockfile records the dependency resolution for this export.

```sh
npm ci
cp .openai/hosting.example.json .openai/hosting.json
npm run build
npm run dev
```

On Windows PowerShell, use
`Copy-Item .openai/hosting.example.json .openai/hosting.json` to create the local
configuration. Open the address printed by Wrangler. The default is
`http://localhost:5173`. After editing source, build again and restart the
local server if Wrangler is still serving the previous output.

Run the storage and buyer-projection regression test with:

```sh
node --test tests/catalog.test.mjs
```

## Source layout

| Path | Contents |
| --- | --- |
| `src/` | React workspace, product editor, buyer preview, WhatsApp snapshots and styling |
| `server/worker.mjs` | Catalogue API, stored-data migration, validation, media persistence and buyer projection |
| `shared/taxonomy.json` | Default departments and categories plus legacy collection mappings |
| `public/logo.png` | XL Traders brand image |
| `scripts/` | Development launcher and Worker packaging |
| `.openai/hosting.example.json` | Template for the local Sites binding configuration |
| `wrangler.json` | Local Cloudflare Worker and R2 binding configuration |

Local development uses Wrangler's local R2 emulation. The `BUCKET` binding
stores catalogue data and product images. The hosted preview depends on the
Sites owner access gate. A standalone deployment must provide equivalent
authorization for the workspace, image and write routes before real business
data is connected. Keep the local configuration and local R2 state out of Git.

See [the development checkpoint](docs/development-checkpoint.md) and
[the storage migration guide](docs/storage-migrations.md).
