# Drop server

The Cloudflare Worker, plus the scripts that set up and deploy a Deployment. Behaviour is described
in [`docs/design.md`](../docs/design.md).

This README is about developing Drop. To run your own Drop, create a deployment repository: see the
root [`README.md`](../README.md) and [`docs/design.md#deployment`](../docs/design.md#deployment).

```sh
npm install
npm run dev              # local Worker with local D1 and R2 (wrangler dev), against the placeholders
npm test                 # Worker tests in workerd, config and script tests in Node
npm run typecheck
npm run check:config     # validate ../drop.config.json and its lockfile
```

Developing runs against the placeholder `drop.config.json` and `drop.config.lock.json` at the
repository root. `src/config.ts` imports them through the `drop-deployment/config` and
`drop-deployment/lock` aliases (in `wrangler.jsonc`, `vitest.config.ts` and `tsconfig.base.json`),
which a Deployment's generated Wrangler config points at its own files. Local D1 starts empty;
apply the migrations with `npx wrangler d1 migrations apply DB --local`.

## Scripts a Deployment runs

A deployment repository's `./drop` runs these from a cached checkout of its pinned Drop release, with
`DROP_DEPLOYMENT_DIR` set to the repository. You can run them the same way against any deployment
directory:

| Command | What it does |
|---|---|
| `npm run setup` (`./drop setup`) | The guided setup: Cloudflare resources, Owners, GitHub App, first deploy, CI credentials |
| `npm run deploy` (`./drop deploy`) | Check the Deployment, generate `wrangler.deployment.json`, apply migrations, deploy |
| `npm run dev:deployment` (`./drop dev`) | Run the Deployment's Worker locally |
| `npm run check:config -- --deploy` | Also require the Cloudflare resources a deploy needs |

`../deploy/action.yml` runs the same check and deploy in CI.

## Generated files

Both are checked in and checked for staleness in CI. Regenerate after editing their source:

| File | Source | Command |
|---|---|---|
| `src/generated/openapi.ts` | `openapi.yaml` | `npm run generate` |
| `worker-configuration.d.ts` | `wrangler.jsonc` | `npm run typegen` |

`openapi.yaml` is the API contract; edit it, never the generated types.

## Secrets

The Worker presigns upload URLs with an R2 API token, verifies the GitHub App's webhooks with its
webhook secret, and calls GitHub as the App with its private key. A Deployment's setup writes them
to its `.dev.vars` (gitignored) and its first deploy uploads them. For developing, put placeholder
or test values in `server/.dev.vars`, which `npm run dev` reads.

| Secret | Value |
|---|---|
| `R2_ACCOUNT_ID` | The Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | The R2 API token's access key ID |
| `R2_SECRET_ACCESS_KEY` | The R2 API token's secret access key |
| `GITHUB_WEBHOOK_SECRET` | The GitHub App's webhook secret; webhooks go to `/api/v1/github/webhook` |
| `GITHUB_APP_PRIVATE_KEY` | The GitHub App's private key, the `.pem` file GitHub issues, as is |
| `GITHUB_APP_CLIENT_SECRET` | The GitHub App's client secret. Optional; unused until Tester sign-in (milestone 2) |

The App's ID, slug and client ID are not secrets: setup records them in `drop.config.lock.json`.

To check whether R2 enforces the SHA-256 signed into upload URLs, run with the R2 values and
`R2_BUCKET_NAME` in the environment: `npm run smoke:r2-checksum`
([implementation notes](../docs/implementation-notes.md#cloudflare)).
