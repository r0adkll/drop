# Drop server

The Cloudflare Worker. Behaviour is described in [`docs/design.md`](../docs/design.md).

```sh
npm install
npm run dev              # local Worker with local D1 and R2 (wrangler dev)
npm test                 # Worker tests in workerd, config tests in Node
npm run typecheck
npm run setup            # lock Owner IDs and create the GitHub App
npm run check:config     # validate ../drop.config.json and its lockfile
npm run deploy:secrets   # deploy, uploading the secrets in .dev.vars (first deploy)
npm run deploy           # deploy
```

## Setting up a deployment

1. Edit `../drop.config.json`: your deployment's `url` and its `owners`.
2. Sign in to GitHub (`gh auth login`, or set `GITHUB_TOKEN`) and run `npm run setup`. It records
   each Owner's numeric ID in `../drop.config.lock.json`. Then it opens your browser on GitHub's
   create-App form, pre-filled for this deployment, under your personal account. The App is private
   when you are the only Owner, and public otherwise so the other Owners can install it. Create it,
   and setup writes the App's secrets to `.dev.vars` and its ID to the lockfile.
3. Add the R2 values (see *Secrets*) to `.dev.vars`.
4. Deploy. The first time, `npm run deploy:secrets` uploads the secrets with the Worker, because a
   deploy fails while any required secret is missing. When the Worker already exists, setup stores
   the App's secrets on it directly.
5. Commit `../drop.config.lock.json`.
6. Install the App from the link setup prints, on each Owner, choosing which repositories may upload.

Run `npm run setup` again whenever `owners` changes, and commit the lockfile. It keeps IDs already
locked, and the App once created.

| Flag | Effect |
|---|---|
| `--refresh` | Look every Owner up again |
| `--skip-app` | Only resolve Owners |
| `--app-name "<name>"` | Name the new App (default `Drop <host>`, up to 34 characters) |
| `--recreate-app` | Create a new App; delete the old one on GitHub yourself |
| `--push-secrets` | Store the App's secrets from `.dev.vars` on the deployed Worker |

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
on the Builds bucket), verifies the GitHub App's webhooks with its webhook secret, and calls GitHub
as the App with its private key. Keep them in `.dev.vars` (gitignored), which `wrangler dev` reads
and `npm run deploy:secrets` uploads; `wrangler secret put <NAME>` changes one on the deployed
Worker:

| Secret | Value |
|---|---|
| `R2_ACCOUNT_ID` | Your Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | The R2 API token's access key ID |
| `R2_SECRET_ACCESS_KEY` | The R2 API token's secret access key |
| `GITHUB_WEBHOOK_SECRET` | The GitHub App's webhook secret; webhooks go to `/api/v1/github/webhook` |
| `GITHUB_APP_PRIVATE_KEY` | The GitHub App's private key, the `.pem` file GitHub issues, as is |
| `GITHUB_APP_CLIENT_SECRET` | The GitHub App's client secret. Optional; unused until Tester sign-in (milestone 2) |

`npm run setup` writes the three GitHub App values; you add the R2 ones. The App's ID, slug and
client ID are not secrets: setup records them in `drop.config.lock.json`.

`R2_BUCKET_NAME` in `wrangler.jsonc` must match the `BUILDS` bucket's name.

To check whether R2 enforces the SHA-256 signed into upload URLs, run with the same values in the
environment: `npm run smoke:r2-checksum`
([implementation notes](../docs/implementation-notes.md#cloudflare)).
