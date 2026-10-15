# Drop server

The Cloudflare Worker. Behaviour is described in [`docs/design.md`](../docs/design.md).

```sh
npm install
npm run dev              # local Worker with local D1 and R2 (wrangler dev)
npm test                 # Worker tests in workerd, config tests in Node
npm run typecheck
npm run check:config     # validate ../drop.config.json against its schema
```

Local D1 starts empty; apply the migrations with
`npx wrangler d1 migrations apply drop --local`.

## Generated files

Both are checked in and checked for staleness in CI. Regenerate after editing their source:

| File | Source | Command |
|---|---|---|
| `src/generated/openapi.ts` | `openapi.yaml` | `npm run generate` |
| `worker-configuration.d.ts` | `wrangler.jsonc` | `npm run typegen` |

`openapi.yaml` is the API contract; edit it, never the generated types.

## Secrets

The Worker presigns upload URLs with an R2 API token (*R2 → Manage API tokens*, Object Read & Write
on the Builds bucket). Set them with `wrangler secret put <NAME>`, and for `wrangler dev` in
`.dev.vars`:

| Secret | Value |
|---|---|
| `R2_ACCOUNT_ID` | Your Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | The R2 API token's access key ID |
| `R2_SECRET_ACCESS_KEY` | The R2 API token's secret access key |

`R2_BUCKET_NAME` in `wrangler.jsonc` must match the `BUILDS` bucket's name.

To check whether R2 enforces the SHA-256 signed into upload URLs, run with the same values in the
environment: `npm run smoke:r2-checksum`
([implementation notes](../docs/implementation-notes.md#cloudflare)).
