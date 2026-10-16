# Drop

Self-hosted distribution for Android CI builds. CI uploads a build, Drop gives it a page with a
QR code and an install button, and apps built with the Drop SDK can check for newer builds and
install them in place. It is a replacement for Firebase App Distribution that you run on your own
Cloudflare account, usually within the free tier.

> **Status:** design. Nothing is built yet. Decisions are recorded in [`docs/adr`](docs/adr) and the
> vocabulary in [`CONTEXT.md`](CONTEXT.md).

## Scope

Android only. iOS is deferred to a later iteration; desktop platforms are out of scope
([ADR 0002](docs/adr/0002-android-only.md)).

| Component | What it is |
|---|---|
| Server | A Cloudflare Worker with R2 for binaries and D1 for metadata ([ADR 0001](docs/adr/0001-cloudflare-workers-r2-d1.md)) |
| Build pages | A web page per build: app icon, version, commit, pull request and CI run links, QR code, download button |
| Uploads | A GitHub Action, authenticated with the workflow's OIDC token; files go straight to R2 ([ADR 0005](docs/adr/0005-uploads-through-github-action.md)) |
| Update API | Answers "is there a newer build on my channel?" for an installed app |
| SDK | Kotlin Multiplatform modules (Android target only) an app adds to its internal builds to check for, download and install updates ([ADR 0012](docs/adr/0012-kmp-sdk-android-only.md)) |
| Gradle plugin | Adds the SDK to internal variants, generates its configuration and stamps each build with its channel and CI run ([ADR 0013](docs/adr/0013-stamped-build-identity.md)) |

Each deployment of Drop accepts uploads only from the GitHub accounts its config lists, and
within them only from the repositories they install the deployment's GitHub App on; anyone can
deploy their own ([ADR 0004](docs/adr/0004-explicit-source-list.md)). Products from public repositories are
public; private ones require GitHub sign-in and read access to the repository
([ADR 0003](docs/adr/0003-github-only-identity.md), [ADR 0010](docs/adr/0010-github-app-for-access.md)).
## Setting up a deployment (planned)

Your deployment is its own small, private repository that holds only configuration and deploys a
pinned release of Drop ([ADR 0016](docs/adr/0016-config-only-deployment-repositories.md)). You need
Node.js 24 or later, git, and the [GitHub CLI](https://cli.github.com) signed in.

1. **Create it:**

   ```sh
   curl -fsSL https://raw.githubusercontent.com/r0adkll/drop/main/deployment/init.sh \
     | sh -s -- my-drop --github you/drop-deployment
   ```

2. **Configure it:** in `my-drop/drop.config.json`, set the URL Drop will serve (a hostname whose DNS
   is on your Cloudflare account) and the accounts it trusts:

   ```jsonc
   {
     "url": "https://drop.example.com",
     "owners": ["your-org", "you"]
   }
   ```

3. **Set up:** `./drop setup` walks through the rest and skips whatever is already done:
   - creates the D1 database and R2 bucket on your Cloudflare account;
   - asks for an R2 API token;
   - records each account's numeric GitHub ID in `drop.config.lock.json`;
   - creates the deployment's GitHub App in your browser;
   - deploys once;
   - stores a Cloudflare API token in the repository's Actions settings for later deploys.

   Secrets stay in the gitignored `.dev.vars` and never appear on screen.
4. **Push:** commit `drop.config.json` and `drop.config.lock.json` and push. Every push to `main`
   deploys. To upgrade Drop, change the ref in `.github/workflows/deploy.yml`.
5. **Install the App:** each listed account installs it from the link setup prints, choosing all of
   its repositories or only some in GitHub's settings. Changing that choice needs no redeploy.
6. **Add the upload Action** to those repositories' workflows, as below.

A workflow in one of those repositories uploads with the Drop Action. Its only setup is permission to
request a GitHub OIDC token; there are no secrets to store:

```yaml
on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read
  id-token: write   # lets the Action prove which repository and run the Build came from

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: 21 }
      - run: ./gradlew assembleInternal
      - uses: r0adkll/drop/action@v1
        with:
          server: https://drop.example.com
          apk: app/build/outputs/apk/internal/app-internal.apk
```

How the server checks uploads is described in [`docs/design.md`](docs/design.md#upload-authentication).

There is no tester-side app for now: testers install from build pages and apps update themselves
through the SDK ([ADR 0011](docs/adr/0011-no-tester-app-in-first-milestone.md)). Milestones,
channel behaviour and retention are in [`docs/design.md`](docs/design.md).
