# Design notes

Decisions too small for an ADR. Vocabulary is defined in [`CONTEXT.md`](../CONTEXT.md).

## Milestones

1. **Public products.** Server, upload Action, Build pages with QR codes, pull request comments
   posted by the GitHub App, the SDK and the Gradle plugin.
2. **Private products.** GitHub sign-in on Build pages, repository access checks, device-flow
   sign-in in the SDK.

Deferred: a tester-side updater (Obtainium or a native Tester app), iOS, in-app feedback.

Open until milestone 2 starts: how Testers sign in on Build pages and how web sessions are kept.

Every user-facing surface (the Build page and its expired state, the pull request comment, the
Update sheet, the Slack and Discord messages) goes through a design iteration and is agreed before
it is implemented.

## Gradle plugin

- Adds the SDK to the variants it is enabled for and the no-op SDK to the rest, so
  `REQUEST_INSTALL_PACKAGES` never reaches a store build.
- Generates the SDK's configuration (server URL, Product) from the `drop {}` block.
- Stamps the Product, Channel and GitHub run ID from the CI environment into the APK
  ([ADR 0013](adr/0013-stamped-build-identity.md)).
- Optionally derives the version code from the commit count. Off by default; Drop does not depend
  on version codes ([ADR 0009](adr/0009-order-builds-by-run-id.md)).

It does not configure signing ([ADR 0006](adr/0006-signing-out-of-scope.md)) or upload Builds
([ADR 0005](adr/0005-uploads-through-github-action.md)).

## Channels

- Channel names are free-form and set at upload. By default, runs on the repository's default
  branch (push, `workflow_dispatch` or `schedule`) go to `main` and pull requests go to
  `pr/<number>`; the server treats `pr/<number>` as a Pull request channel and links it to the pull
  request. Any other run must name its Channel, or the upload fails.
- A Product's default Channel is the one its default-branch Builds go to.
- When a pull request is merged or closed, its Channel ends. The Update check from a Build on it
  answers that the Channel has closed and offers the default Channel's newest Build, and the SDK
  asks the Tester whether to switch. Drop keeps a record of ended Channels after their Builds are
  deleted, so this still works after cleanup.

## Upload authentication

Any GitHub workflow anywhere can obtain a validly signed OIDC token, so a valid signature proves
only that the token came from GitHub Actions. What restricts uploads to Allowed repositories is
the claims check. The server accepts an upload only when its token:

- is signed by a key in GitHub's published key set, from issuer
  `https://token.actions.githubusercontent.com`, and unexpired (tokens last minutes);
- has the deployment's own URL as its audience, so a token minted for another service can't be
  replayed here;
- comes from a repository covered by the config's required `repositories` list
  ([ADR 0004](adr/0004-explicit-source-list.md)): its `repository_owner_id` matches an account
  entry, or its `repository_id` matches a repository entry. IDs, not names: a renamed or deleted
  account's name can be registered by someone else, but its ID is never reused;
- comes from the repository its Product is bound to, if the Product already exists
  ([ADR 0015](adr/0015-product-identity.md));
- was not issued to a `pull_request_target` or `workflow_run` run, unless the config allows that
  for the repository. Both events run with the repository's permissions while handling a fork's
  pull request, so a workflow that builds the fork's code there would hand the fork an upload
  token.

The presigned upload URL the server returns is valid for one object key, for a few minutes, and
the upload is accepted only once the server has confirmed the object's size and SHA-256. Pull
requests from forks get no OIDC token, so they cannot upload. The Cloudflare account and the
Worker secrets are the deployment's other trust boundary: whoever can deploy the Worker can change
these rules.

## Build pages

- The Build page is the only web page in milestone 1: icon, name, version, Channel, links to the
  commit, pull request and CI run, a QR code and an install button. There are no Channel, Product
  or index pages.
- A deleted Build keeps its record, without the file. Its Build page says it has expired and links
  to the newest Build of its Channel, or of the default Channel once that Channel has ended.

## SDK

- Makes no decisions about when to check or how to tell the Tester. The app checks when it wants,
  shows its own hints (a badge, a banner, a settings row), and asks the SDK to show the Update
  sheet when the Tester wants to act.
- Downloads with Android's `DownloadManager`, so downloads survive the app being backgrounded or
  killed, verifies the SHA-256, then installs through a `PackageInstaller` session. The first
  install sends the Tester to *Install unknown apps* for the app. Download URLs stay valid for an
  hour so interrupted downloads can resume.
- No forced updates in milestone 1.

### API

- The core exposes suspend functions: `check()` (answering up to date, an Update, an ended Channel
  with a suggested Update, a Signer mismatch, an unknown Build, or an error), `download(update)`,
  `install()`, and helpers for *Install unknown apps* (`canInstall()`,
  `installPermissionIntent()`).
- One `state: StateFlow` (idle, Update available, downloading with progress, ready to install,
  installing, failed) is shared by the app and the Update sheet, so the app's own hints and the
  sheet always agree.
- `drop-ui` provides the Update sheet as a composable that inherits the app's `MaterialTheme`, and
  a launcher that hosts the same composable in a dialog for View-based apps.
- Android does not let a backgrounded app open the install confirmation. When a download finishes
  in the background, the ready-to-install state and the downloaded file are saved, survive process
  death, and are what `state` starts from on the next launch; the app decides how to prompt, and
  reopening the sheet resumes at the install step. The SDK posts no notifications of its own. The
  saved file is deleted once installed or when a newer Update replaces it.

## Pull request comments

The GitHub App keeps one comment per pull request and edits it in place: a row per Product with its
newest Build's version, commit, QR code and Build page link. When the pull request closes, the
comment notes that its Builds are deleted in 24 hours.

## Notifications

Beyond the pull request comment and the SDK's check, Drop sends outgoing webhooks when a Build
lands. Each webhook is defined in `drop.config.json` by name, with the Products and Channel
patterns (`main`, `pr/*`) it covers and a format: `slack` or `discord` (a ready-made message) or
`json` (the Build record, HMAC-signed). Its URL is a Worker secret named after it, since webhook URLs
are credentials and the deployment repository may be public. Milestone 1 sends no other events.

## Releases

The SDK is published to Maven Central under `com.r0adkll.drop`, the Gradle plugin to the Gradle
Plugin Portal as `com.r0adkll.drop`, and the Action is used from the repository path
(`r0adkll/drop/action@v1`). All three share one version and are released together; adopters deploy
the server themselves from the template.

## Deployment

- Drop is a template repository. An adopter makes their own copy, edits `drop.config.json`
  (checked against a JSON Schema and bundled into the Worker at deploy), adds the Worker secrets
  and deploys with `wrangler deploy` or Cloudflare's Git integration.
- The config holds the deployment's URL, the required `repositories` list (whole accounts such as
  `"campfire"` or single repositories such as `"r0adkll/side-app"`, with any per-repository
  allowance for `pull_request_target` or `workflow_run` uploads), webhooks and per-Product
  overrides (force private, retention, icon, display name). Setup resolves each entry to its
  numeric ID. Secrets, such as the GitHub App's private key, are Worker
  secrets and never appear in the config.
- There is no admin interface in milestone 1. Emergencies (for example a Build that leaked a
  secret) are handled with a documented `wrangler` script that deletes a Build.

## Retention

- The newest Build of every open Channel is always kept.
- Other Builds are deleted 30 days after upload, or 7 days for Builds on a Pull request channel.
- A Pull request channel and all its Builds are deleted 24 hours after its pull request closes.
- Each rule can be overridden per Product in the deployment config.
