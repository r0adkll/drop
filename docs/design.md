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

## Repository layout

One repository ([ADR 0008](adr/0008-typescript-server-openapi-contract.md)):

```
server/          TypeScript Worker (Hono), D1 migrations, the OpenAPI document, setup and deploy scripts
action/          upload Action (node24, runs aapt2 + apksigner)
deploy/          deploy Action (composite), used by deployment repositories
deployment/      starter files for a deployment repository, and init.sh to create one
android/         Gradle build: SDK modules (KMP, Android target) and samples
android/plugin/  Gradle plugin, as an included build
docs/            design notes and ADRs; docs/assets holds Drop's icon
```

The Kotlin API client is generated from the OpenAPI document in `server/`; edit the document, not
the generated client.

## Gradle plugin

- Adds `drop-android` to the variants `drop { enableFor { … } }` selects (a predicate on the
  variant's name, build type and flavors; by default the debug build type) and `drop-noop` to the
  rest, so `REQUEST_INSTALL_PACKAGES` never reaches a store build.
- Writes the SDK's configuration (`serverUrl`, and the `channel` a Build without a Stamp follows,
  per variant with `channelFor`) into the manifest of each variant that gets the SDK as meta-data, which `Drop(context)` reads; `Drop(context, config)`
  remains for apps that configure Drop themselves. The Product needs no setting: it is the app's
  own application ID ([ADR 0015](adr/0015-product-identity.md)).
- Stamps the Channel and GitHub run ID from the CI environment into the same meta-data
  ([ADR 0013](adr/0013-stamped-build-identity.md)), choosing the Channel as the upload Action does.
  Both honour a job-level `DROP_CHANNEL` environment variable, so a workflow names a Channel once
  and the APK and its upload agree; the Action warns when its `channel` input differs.
- Optionally derives the version code from the first-parent commit count, so a pull request's
  Build (built from GitHub's merge commit) never out-counts the main Build its merge produces. Off
  by default; Drop does not depend on version codes ([ADR 0009](adr/0009-order-builds-by-run-id.md)).

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
- comes from an Allowed repository ([ADR 0004](adr/0004-explicit-source-list.md)): its
  `repository_owner_id` is the ID `drop.config.lock.json` records for an Owner in the config's
  required `owners` list, and that Owner's installation of the deployment's GitHub App covers its
  `repository_id` (all repositories, or the selected ones the App's webhooks reported). IDs, not
  names: a renamed or deleted account's name can be registered by someone else, but its ID is
  never reused;
- comes from the repository its Product is bound to, if the Product already exists
  ([ADR 0015](adr/0015-product-identity.md));
- was not issued to a `pull_request_target` or `workflow_run` run, unless the config allows that
  for the repository. Both events run with the repository's permissions while handling a fork's
  pull request, so a workflow that builds the fork's code there would hand the fork an upload
  token.

The presigned upload URL the server returns is valid for one object key, for a few minutes, and
carries the APK's SHA-256 as a signed `x-amz-checksum-sha256` header. The upload is accepted only
once the server has confirmed the object's size, and its SHA-256 where R2 reports one (see
[implementation notes](implementation-notes.md#cloudflare)); the SDK checks the SHA-256 again before
installing. Pull
requests from forks get no OIDC token, so they cannot upload. The Cloudflare account and the
Worker secrets are the deployment's other trust boundary: whoever can deploy the Worker can change
these rules.

## Build pages

- Build pages sit under the site pages (below): an index of Products, a page per Product and a page
  per Channel.
- It leads with what the Build contains: the pull request title (or the commit message outside pull
  requests) as the headline, the head commit and its message beneath, then the app's icon, name,
  version and Channel. The Action takes the commit message from the event payload, or from
  `git log -1` in the checkout when the event has none (`schedule`, `workflow_dispatch`); with
  neither, the app name leads.
- On a laptop the details sit beside a QR panel with install steps, a Download APK link and Copy
  link. On a phone the QR code is dropped, Install stays pinned to the bottom of the screen, and help
  for Android's unknown-apps prompt and "App not installed" sits with the details.
- Details: pull request, commit, CI run labelled with its workflow and run number
  ("Android #1876"), upload time, size, and how long it is kept ("while it is the newest on
  `pr/142`", or a date). A collapsed *Technical details* holds the application ID, version code,
  Signer and APK SHA-256 digests and run ID.
- The newest Build of its Channel is marked as such. An older one shows a banner linking to the
  newest.
- A deleted Build keeps its record, without the file. Its Build page says it has expired and links
  to the newest Build of its Channel, or of the default Channel once that Channel has ended.
- Build page URLs are `/b/<id>`, with an 8-character random base62 ID, so they can't be enumerated
  and their QR codes stay sparse.
- The page uses system fonts and inline CSS, follows the device's light or dark theme, makes no
  third-party requests, and carries Open Graph tags (title, description, app icon) for link
  previews. The Worker draws the QR code. Its Content Security Policy allows only the page itself:
  inline styles, its one script by hash, and same-origin images. A Product's configured icon is
  therefore served through `/b/<id>/icon` rather than linked directly. Build pages ask search
  engines not to index them.
- Drop's own icon (`docs/assets/drop-icon.svg`) is the page's favicon, served at `/favicon.svg`,
  and sits inline beside "Served by Drop" in the footer.
- The phone layout applies below 720px wide, chosen by a media query rather than the user agent.
- Install and Download APK fetch `/b/<id>/download`, which supports a single byte range with
  `If-Range`, so an interrupted download resumes unless a later attempt has replaced the file.
  Expired Builds and Private products have no download.
- Times are rendered in UTC and rewritten in the Tester's time zone by the page's script.
- An expired page shows when the Build was deleted and why. When there is nothing to offer instead
  (no Build on the Channel, or the Product has no default Channel), it says so in a sentence.
- Milestone 1 serves Public products only: a Build of a Private product gets a page saying it needs
  sign-in, which reveals nothing about the Build, and an unknown ID gets a not-found page. Both are
  a heading and one sentence in the Build page's style, agreed as written; the sign-in page gets its
  own design with milestone 2.

## Site pages

Agreed from the mockups on the [site pages canvas](https://claude.ai/artifact/SYjHDByEtPusRh1qxem1za).
They share the Build page's document, styles, script and Content Security Policy, and ask search
engines not to index them.

- **Index (`/`):** Drop's logo beside "Apps" and its subtitle, and a card per Public product with Builds, most
  recently active first. A card shows the icon, name and repository, the default Channel's newest
  Build (version, headline, age, size, Build page link) with its QR code on desktop or an
  **Install** button on a phone, and the Product's Channels as chips, pull requests counted rather
  than listed. A Product with nothing on its default Channel says so.
- **Product page (`/p/<applicationId>`):** a Channels section (the default Channel first, then
  other named Channels) and a Pull requests section (open ones by newest activity, then ended ones,
  dimmed, with when their Builds are deleted). Each row shows the newest Build and links to its
  Channel page. Channels without Builds aren't listed.
- **Channel page (`/p/<applicationId>/c/<channel>`):** a pull request's title, state and link, or
  the Channel's name, how long its Builds are kept, and its Builds newest first (version, commit,
  CI run, age, size, when it is deleted), each linking to its Build page. Only the newest gets an
  **Install** button on a phone.
- **An ended Channel without Builds** keeps its page: it says the pull request was merged or closed
  and its Builds deleted, and offers the default Channel's newest Build, like an expired Build page.
- Only Public products are listed. A Private product's pages answer 403 with nothing about it,
  until milestone 2's sign-in. `"pages": { "index": false }` in the deployment config turns off the
  index and Product pages; Channel and Build pages stay reachable by link.

## Update check

`GET /api/v1/update` (defined in `server/openapi.yaml`) takes what the installed Build is: its
application ID, Channel, the run ID from its Stamp (left out without one), its Signer and its
version code, all read on the device. It needs no sign-in in milestone 1 and is never cached.

- Newer means a higher run ID on the same Channel ([ADR 0009](adr/0009-order-builds-by-run-id.md)),
  judged from the Stamp alone, so a run that never uploaded still gets correct answers. A Build
  with no Stamp treats every Build on its Channel as newer
  ([ADR 0013](adr/0013-stamped-build-identity.md)).
- The answer is `up_to_date`, `update` (the newest newer Build with the installed Signer),
  `reinstall_required` (every newer Build is signed differently, so the newest is offered for a
  reinstall; [ADR 0006](adr/0006-signing-out-of-scope.md)), or `channel_ended` (the default
  Channel's newest Build whatever its run ID: the installed Signer's newest, else the newest,
  flagged for a reinstall, or none).
- An Update describes what the Build page shows (name, version, headline, commit, pull request,
  size, SHA-256) plus its download URL and when that URL expires. For now the URL is the Build's
  `/download` route with an expiry an hour out; milestone 2 can swap in signed URLs without
  changing the contract. The SDK checks again once it has expired.
- An Update whose version code is lower than the installed one is still offered, flagged
  `requiresReinstall: "version_code"`, because Android refuses the downgrade; a differently signed
  one is flagged `"signer"`. Either way the Tester must uninstall first.
- An unknown application ID answers `404 product_not_found`; a Private product answers `403
  sign_in_required` and reveals nothing else, as its Build page does.

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

### Update sheet

Agreed from the mockups on the [Update sheet canvas](https://claude.ai/artifact/96tyNGZTQqfgf4r3TfWGZK).

- A Material 3 modal bottom sheet over the app: the app's icon, "Update available", the version,
  what changed (the Update's headline), its Channel, age and size, **Update** and **Not now**, and
  a link to its Build page.
- **Update** first asks for *Install unknown apps* when the app lacks it (Settings opens, and the
  sheet carries on when the app resumes), then downloads, so the only wait comes after every
  detour. Downloading shows progress; **Hide** closes the sheet while the download carries on, and
  **Cancel download** deletes it.
- Ready to install explains what happens next before every install: Android's confirmation, then,
  for a signing key Play Protect hasn't seen, its "App blocked" warning and **More details →
  Install anyway**, then that the app closes and is opened again from the home screen (Android
  doesn't relaunch an updated app). A cancelled install offers **Try again** without downloading
  again, or removing the download.
- An Update that can't install in place (a lower version code, or a different Signer) explains why
  in the Tester's terms, warns that uninstalling deletes the app's data, lists the two steps
  (uninstall, then install from the Build page) and opens the Build page: the sheet can't reinstall
  the app itself, since uninstalling deletes its download too.
- When the Channel's pull request has ended, the sheet says so and offers the default Channel's
  newest Build with **Switch to main**, which installs it like any Update; when that Build needs a
  reinstall, the same screen carries the reinstall warning and opens its Build page.

## Pull request comments

The GitHub App keeps one comment per pull request and edits it in place: a block per Product with
its newest Build's 128px QR code beside its icon, name, version, Channel, head commit, CI run and
Build page link. When the pull request closes, the comment notes when its Builds will be deleted
and that Testers will be offered the default Channel's newest Build. Once they are deleted, the
retention job edits the comment down to that note.

## Commit comments

A Build on any Channel other than a Pull request channel (`main`, or a named Channel such as
`beta`) is announced with a comment on its commit: the pull request comment's block for that one
Build (QR code, icon, name, version, Channel, CI run and Build page link), without the "Updated at"
line, and a footnote saying how long Builds on its Channel are kept. GitHub lets the App create
commit comments but not edit them without push access ([ADR 0010](adr/0010-github-app-for-access.md)),
so they are post-only: one per Build, never edited, so an expired Build's comment links to its
expired Build page. A later attempt of the run keeps the Build's ID and URL, so it posts nothing new.
Commit comments notify the commit's author; a Product turns them off with `commitComments: false`
in the deployment config.

## Notifications

Beyond the pull request comment and the SDK's check, Drop sends outgoing webhooks when a Build
lands. Each webhook is defined in `drop.config.json` by name, with the Products and Channel
patterns (`main`, `pr/*`) it covers and a format: `slack` or `discord` (a ready-made message) or
`json` (the Build record, HMAC-signed). Its URL is a Worker secret named after it, since webhook URLs
are credentials and the deployment repository may be public. Milestone 1 sends no other events.

Agreed from the mockups on the [notifications canvas](https://claude.ai/artifact/BVzNnLnUvA6CbuRKZ5jfeN):

- A message carries what a block of the pull request comment does: name, version and Channel,
  the headline (the pull request title, else the commit message's first line), commit, CI run,
  size, the app's icon, a link or button to the Build page, and the Build page's QR code as a
  PNG (`/b/<id>/qr.png`), since Slack and Discord don't render SVG. Slack gets a Block Kit
  message, Discord an embed; text from the upload is escaped and Discord's mentions are off, so a
  commit message can't ping anyone. `json` sends the Build record, signed as
  `X-Drop-Signature-256: sha256=<hex HMAC>` with the Worker secret `WEBHOOK_<NAME>_SECRET` when set.
- A webhook without Channel patterns covers only the Product's default Channel; `pr/*` (or `*`)
  opts in to pull request Builds, which the pull request comment already announces.
- Each Build is announced once, on its first confirmation; a later attempt of its run posts
  nothing. A failed delivery (network, 429 or 5xx) is retried twice, then logged; webhooks never
  hold up or fail the upload. Builds of Private products are not announced.

## Releases

The SDK is published to Maven Central under `com.r0adkll.drop` with gradle-maven-publish-plugin,
the Gradle plugin to the Gradle Plugin Portal as `com.r0adkll.drop` (and to Maven Central, which
snapshots need), and the upload and deploy Actions are used from their repository paths
(`r0adkll/drop/action@v0`, `r0adkll/drop/deploy@v0`). All four share one version and are released
together. A Deployment runs the release its deploy workflow pins
([ADR 0016](adr/0016-config-only-deployment-repositories.md)).

- Versions start at 0.1.0; 1.0 waits until milestone 2's API has settled. `VERSION_NAME` in
  `android/gradle.properties` is the next release as a `-SNAPSHOT`.
- `scripts/release <version>` turns `CHANGELOG.md`'s Unreleased section into the version, moves
  `VERSION_NAME` to the next minor snapshot, and pushes a `v<version>` tag. The tag's workflow
  (`release.yml`) checks, publishes, creates the GitHub Release with that section as its notes,
  and moves the major tag (`v0`).
- Every push to main that touches `android/` publishes snapshots to Maven Central's snapshot
  repository, the plugin included through its marker artifact.
- `scripts/publishing-credentials` walks the maintainer through the Central Portal token, the GPG
  signing key and the Plugin Portal key, storing each as a GitHub secret.

## Deployment

- **Deployment repositories** ([ADR 0016](adr/0016-config-only-deployment-repositories.md)). Each
  Deployment is its own repository holding only configuration: `drop.config.json`,
  `drop.config.lock.json`, the `./drop` script, a `.gitignore` for `.dev.vars` and local state, and
  `.github/workflows/deploy.yml`. `deployment/init.sh` creates one from `deployment/template`,
  pinned to a Drop ref (`--ref`, default `main` until there are releases), and with `--github`
  creates its private GitHub repository too. `r0adkll/drop` itself keeps only placeholders.
- **One pinned version.** The deploy workflow's `uses: r0adkll/drop/deploy@<ref>` pins Drop.
  GitHub fetches the whole repository at that ref for the composite deploy Action, which deploys the
  server from that checkout: `npm ci`, `check:config --deploy`, a generated Wrangler config,
  `wrangler d1 migrations apply --remote`, then `wrangler deploy`. `./drop` reads the same pin,
  keeps a shallow checkout of that ref under `${XDG_CACHE_HOME:-~/.cache}/drop/<owner>/<repo>/<ref>`
  (fetched again on every run, so a branch pin follows its branch), runs `npm ci` once per
  lockfile, and runs `setup`, `deploy` or `dev` there. Upgrading Drop is changing the ref.
- **Where the files come from.** Every server script reads the Deployment from
  `DROP_DEPLOYMENT_DIR`, which `./drop` and the deploy Action set; without it, the repository root
  and its placeholders, which developing Drop uses. The Worker bundles `drop.config.json` and the
  lockfile at build time through the module aliases `drop-deployment/config` and
  `drop-deployment/lock`: `server/wrangler.jsonc` points them at the placeholders, and a
  Deployment's generated Wrangler config (`server/wrangler.deployment.json`, gitignored) at its own
  files, along with its account, Worker name, D1 database, R2 bucket and route. A custom hostname is
  served as a Custom Domain with the `workers.dev` and preview URLs off, so the Deployment has one
  URL, which is also the upload tokens' audience; a `<worker>.<subdomain>.workers.dev` URL keeps
  `workers.dev` on instead.
- **The config** (`drop.config.json`, checked against a JSON Schema) holds the Deployment's URL, the
  required `owners` list (accounts such as `"campfire"` or `"r0adkll"`), per-repository exceptions
  allowing `pull_request_target` or `workflow_run` uploads
  (`"repositories": { "r0adkll/side-app": { "allowEvents": [...] } }`; they never grant access),
  webhooks and per-Product overrides (force private, retention, icon, display name, commit
  comments). Each Owner installs the Deployment's GitHub App on the repositories it wants to upload
  from; changing that selection needs no redeploy.
- **The lockfile** (`drop.config.lock.json`) is written only by setup and checked in: each Owner's
  numeric ID (kept unless setup runs with `--refresh`), the GitHub App's ID, slug and client ID, and
  the Cloudflare resources (`accountId`, `workerName`, `d1DatabaseId`, `r2Bucket`). The config
  check fails while an Owner is missing from it; deploying also needs every Cloudflare field.
  Secrets never appear in the config or the lockfile: they live in the Deployment's `.dev.vars`
  (gitignored) and as Worker secrets.
- **`./drop setup`** is one guided run of numbered stages, each skipping work already done, so it is
  safe to stop and run again:
  1. *Cloudflare account:* signs wrangler in if needed and picks the account. The Worker is named
     `drop` unless `--worker-name` says otherwise on the first run.
  2. *D1 database:* named after the Worker, adopted if it exists, created otherwise.
  3. *R2 bucket and API token:* creates `<worker>-builds`, sending the operator to the dashboard if
     R2 isn't enabled, then asks for an R2 API token scoped to that bucket, checks it by listing the
     bucket, and writes it to `.dev.vars`.
  4. *Owners:* records each Owner's ID.
  5. *GitHub App:* creates it through the manifest flow
     ([ADR 0010](adr/0010-github-app-for-access.md)), serving a form on `127.0.0.1` that posts the
     manifest to GitHub and taking GitHub's redirect back; its private key, webhook secret and
     client secret go to `.dev.vars`. `--recreate-app` makes a new one (the old one is deleted on
     GitHub by hand); `--skip-app` leaves it for later. A manifest can't carry a logo, so a new App
     leaves one step for the end: uploading `docs/assets/drop-app-logo.png` on the App's settings
     page.
  6. *First deploy:* a deploy fails while a required secret is missing from the Worker, so the first
     one uploads `.dev.vars` with it (`wrangler deploy --secrets-file`). For a Worker that already
     exists, setup stores any secrets it just wrote with `wrangler secret bulk`.
  7. *CI credentials:* asks for a Cloudflare API token, checks it with Cloudflare, and stores it as
     the Deployment repository's `CLOUDFLARE_API_TOKEN` secret, with the account ID as its
     `CLOUDFLARE_ACCOUNT_ID` variable, through `gh`. Without a GitHub remote or `gh`, it prints the
     steps instead.
  8. *Finish:* prints the App's install link and anything left to do.

  Secrets are read with echo off and passed on stdin, never in arguments or output.
- **Day to day.** Every push to the Deployment repository's `main` deploys. `./drop deploy` deploys
  from a machine (`--secrets` uploads `.dev.vars` again), `./drop setup --push-secrets` stores
  `.dev.vars` on the deployed Worker without deploying, and `./drop dev` runs the Worker locally
  with its local D1 in the Deployment repository's `.wrangler/state`.
- There is no admin interface in milestone 1. Emergencies (for example a Build that leaked a
  secret) are handled with a documented `wrangler` script that deletes a Build.

## Retention

- The newest Build of every open Channel is always kept.
- Other Builds are deleted 30 days after upload, or 7 days for Builds on a Pull request channel.
- A Pull request channel and all its Builds are deleted 24 hours after its pull request closes.
- Deleting a Build deletes its APK but keeps its icon, which is small, so its expired Build page
  and the pull request comments that showed it still have an image.
- Each rule can be overridden per Product in the deployment config.
- A job runs hourly. It marks expired Builds deleted in D1, drops uploads abandoned for a day, then
  deletes every stored file that no Build or upload in D1 refers to. D1 is the record and storage
  follows it, so files that other deletions missed (a replaced attempt's, say) are collected too.
  It then edits each closed pull request's comment down to the deleted note once all its Builds are
  gone, editing only: a comment deleted by hand isn't posted again.
