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
## Setting up a repository (planned)

The deployment's `drop.config.json` lists the accounts it trusts:

```jsonc
{
  "url": "https://drop.example.com",
  "owners": ["your-org", "you"]
}
```

`npm run setup` records each account's numeric ID in `drop.config.lock.json`, which you check in.
Each listed account then installs the deployment's GitHub App, choosing all of its repositories or
only some, in GitHub's settings. Adding or removing a repository needs no redeploy.

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
      - uses: actions/checkout@v4
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
