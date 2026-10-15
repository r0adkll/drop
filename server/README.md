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
