# Drop deployment

This repository deploys one [Drop](https://github.com/r0adkll/drop) server: distribution and in-app
updates for Android CI builds, on your own Cloudflare account. It holds only configuration. The
server code comes from the Drop release that `.github/workflows/deploy.yml` pins.

| File | What it is |
|---|---|
| `drop.config.json` | Your deployment's URL, the GitHub accounts (Owners) it trusts, and per-Product overrides. You edit it. |
| `drop.config.lock.json` | Written by `./drop setup`: the Owners' numeric GitHub IDs, the GitHub App and the Cloudflare resources. Commit it. |
| `.dev.vars` | Written by `./drop setup`: the R2 API token and the GitHub App's private key and secrets. Never committed. |
| `drop` | Runs setup, deploys and local development from the pinned Drop release. |
| `.github/workflows/deploy.yml` | Deploys every push to `main`. |

## Setting up

You need Node.js 24 or later, git, and the [GitHub CLI](https://cli.github.com) signed in
(`gh auth login`).

1. Edit `drop.config.json`: set `url` to the hostname Drop will serve (a domain whose DNS is on
   your Cloudflare account, such as `https://drop.example.com`), and list the GitHub users or
   organizations whose repositories may upload in `owners`.
2. Push this repository to GitHub as a private repository, if `init.sh --github` didn't already.
3. Run `./drop setup`. It walks through each step and skips what is already done, so you can stop
   and run it again at any point:
   1. signs wrangler in to Cloudflare and picks the account;
   2. creates the D1 database;
   3. creates the R2 bucket and asks for an R2 API token for it;
   4. records each Owner's numeric GitHub ID;
   5. creates the deployment's GitHub App in your browser;
   6. deploys the Worker the first time, with its secrets;
   7. stores a Cloudflare API token and the account ID in this repository's Actions settings.
4. Commit `drop.config.json` and `drop.config.lock.json`, and push.
5. Install the GitHub App on the repositories that upload, from the link setup prints. Each Owner
   installs it on their own account.
6. Add the upload Action to those repositories' workflows (see Drop's README).

## Day to day

- **Deploy:** push to `main`. `./drop deploy` deploys from your machine.
- **Upgrade Drop:** change the ref in `.github/workflows/deploy.yml` (`r0adkll/drop/deploy@<ref>`)
  and push.
- **Rotate the GitHub App's or R2's secrets:** update `.dev.vars`, then `./drop setup --push-secrets`.
- **Try it locally:** `./drop dev`.
- **Remove a Build now**, such as one that leaked a secret: `./drop delete-build <id>`, with the ID
  from its Build page's URL (`/b/<id>`). Its APK is deleted and its page says it was removed.
