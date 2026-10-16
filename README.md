# <img src="docs/assets/drop-icon.svg" width="40" height="40" alt="" align="top"> Drop

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
## Setting up a deployment

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
      - uses: actions/setup-java@v5
        with: { distribution: temurin, java-version: 21 }
      - run: ./gradlew assembleInternal
      - uses: r0adkll/drop/action@v0
        with:
          server: https://drop.example.com
          apk: app/build/outputs/apk/internal/app-internal.apk
```

A Build's headline is its pull request title, else its commit message's first line. To say more,
pass `notes`, such as a release's description: its first line becomes the headline and the rest is
shown as What's new on the Build page and in the Update sheet.

```yaml
      - uses: r0adkll/drop/action@v0
        with:
          server: https://drop.example.com
          apk: app/build/outputs/apk/beta/app-beta.apk
          notes: ${{ github.event.release.body }}
```

How the server checks uploads is described in [`docs/design.md`](docs/design.md#upload-authentication).

## Adding Drop to your app

With the SDK, an installed Build finds newer Builds on its Channel and updates itself, and a closed
pull request's Build is offered the default Channel's newest. It needs Android 8 (API 26) or later.

**Sign every Build with one internal key.** Android updates an app only with a Build signed by the
same key, and a CI runner makes a fresh debug key on every run, so debug-signed CI Builds can never
update each other. Keep one internal keystore as a CI secret and sign every variant you distribute
through Drop with it. Drop never holds or configures keys
([ADR 0006](docs/adr/0006-signing-out-of-scope.md)). Builds from Google Play are re-signed by Play,
so they can't update to or from Drop's.

1. **Apply the Gradle plugin.** It gives the variants you choose the SDK and every other variant a
   no-op with the same API, so the install permission never reaches a store build. Until the
   Gradle Plugin Portal lists it, it resolves from Maven Central:

   ```kotlin
   // settings.gradle.kts
   pluginManagement {
     repositories {
       gradlePluginPortal()
       mavenCentral()
       google()
     }
   }
   ```

   ```kotlin
   // app/build.gradle.kts
   plugins {
     id("com.android.application")
     id("com.r0adkll.drop") version "0.1.0"
   }

   drop {
     serverUrl = "https://drop.example.com"
     // Which variants get the SDK; the rest get the no-op. Default: the debug build type.
     enableFor { it.flavorName == "internal" }
   }

   dependencies {
     // The ready-made Update sheet (optional).
     implementation("com.r0adkll.drop:drop-ui:0.1.0")
   }
   ```

   On CI the plugin stamps each Build with its Channel and run, which is how Drop recognises an
   installed Build. A local build has no Stamp and follows `drop { channel }` (default `main`), or
   per variant `drop { channelFor { if (it.flavorName == "beta") "beta" else null } }`. Store
   variants get nothing in their manifest.

2. **Create one `Drop` per process** and check when it suits your app:

   ```kotlin
   class App : Application() {
     val drop by lazy { Drop(this) } // reads the plugin's settings from the manifest
   }

   lifecycleScope.launch {
     when (val result = app.drop.check()) {
       is UpdateCheckResult.Available -> showUpdateBadge(result.update)
       else -> Unit
     }
   }
   ```

   `drop.state` is a `StateFlow` (Update available, downloading, ready to install, installing,
   failed) that survives process death, so a download that finished in the background is still
   ready on the next launch. The SDK posts no notifications; your app decides how to prompt.

3. **Show the Update sheet** when the tester acts. It offers the Update, asks for *Install
   unknown apps* the first time, downloads, verifies and installs, and explains reinstalls, ended
   pull requests and Google Play Protect's warning
   ([design](docs/design.md#update-sheet)):

   ```kotlin
   // Compose: it inherits your MaterialTheme
   if (showSheet) DropUpdateSheet(drop = app.drop, onDismiss = { showSheet = false })

   // Views
   activity.showDropUpdateSheet(app.drop)
   ```

   Or build your own UI from `check()`, `download()`, `canInstall()`,
   `installPermissionIntent()` and `install()`.

**Channels.** Runs on the default branch upload to `main` and pull requests to `pr/<number>`.
Any other run names its Channel with a job-level `DROP_CHANNEL`, which both the upload Action and
the plugin's Stamp read, so they agree:

```yaml
jobs:
  beta:
    env:
      DROP_CHANNEL: beta
```

**Version codes.** Drop orders Builds by GitHub run, not version code
([ADR 0009](docs/adr/0009-order-builds-by-run-id.md)). Android still refuses a lower version code,
so an Update with one is offered as a reinstall. `drop { versionCodeFromCommits = true }` sets the
version code to the first-parent commit count, which only grows and never puts a pull request's
Build above the main Build its merge produces (CI needs `fetch-depth: 0`).

The [sample app](android/sample) shows the whole loop, and its CI uploads it to a deployment.

There is no tester-side app for now: testers install from build pages and apps update themselves
through the SDK ([ADR 0011](docs/adr/0011-no-tester-app-in-first-milestone.md)). Milestones,
channel behaviour and retention are in [`docs/design.md`](docs/design.md).
