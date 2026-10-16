# Implementation notes

Platform facts and gotchas gathered while designing Drop, which neither the code nor the config
will tell you. Behaviour is decided in [`design.md`](design.md) and the [ADRs](adr); this file only
records how the platforms around Drop behave. Facts marked *unverified* were not tested.

## Cloudflare

- Workers on the free and $5 plans reject request bodies over 100 MB, so APKs never pass through
  the Worker: it returns a presigned R2 URL (S3-compatible API, signed with `aws4fetch`) and the
  Action `PUT`s the file directly. A single `PUT` can be up to 5 GB.
- Free-plan Workers get about 10 ms of CPU per request. Keep heavy work, such as parsing APKs, out of
  the Worker; that is why the Action reads APK metadata.
- Presigned `PUT`s sign `x-amz-checksum-sha256` (base64 of the digest), so the uploader must send
  it unchanged. Whether R2's S3 API rejects a body that doesn't match it, and whether the Worker
  binding's `head()` then reports `checksums.sha256`, is *unverified*; R2's docs don't say. Run
  `npm run smoke:r2-checksum` in `server/` against a real bucket to find out. If R2 enforces it, the
  server's completion check confirms the checksum; if not, the server checks size only (it cannot
  hash an APK inside the CPU limit) and the SDK's SHA-256 check before install is the backstop.
- R2 has no egress fees, which is the reason for the whole platform choice
  ([ADR 0001](adr/0001-cloudflare-workers-r2-d1.md)). Serve downloads from R2 with
  `Content-Type: application/vnd.android.package-archive` and a `Content-Disposition` filename.
- With `secrets.required` in `wrangler.jsonc`, `wrangler deploy` fails until every listed secret is
  set on the Worker; `wrangler dev` only warns, and loads only the listed keys from `.dev.vars`.
  `wrangler deploy --secrets-file <file>` uploads secrets with the deploy (additively), which is how
  a Worker's first deploy gets them. `wrangler secret bulk` reads JSON from stdin. What
  `wrangler secret put`/`bulk` do for a Worker that was never deployed isn't documented; setup
  treats `wrangler secret list` failing with code 10007 (*unverified*) as "not deployed yet".
- `.dev.vars` is parsed as dotenv: a double-quoted value expands `\n`, so setup stores the PEM on one
  line; the Worker's key parser accepts literal `\n` too.
- `wrangler dev` reads `.dev.vars` next to its config unless given `--env-file`, which replaces that
  lookup (wrangler 4.151's source). `./drop dev` passes the Deployment's own `.dev.vars` this way.
- Wrangler's `alias` resolves each target with Node's resolution from the config file's directory,
  so `wrangler.jsonc` can use relative paths and a generated config absolute ones (wrangler's
  source, and a dry-run bundle checked to contain a Deployment's config). Vitest needs the same
  aliases in `resolve.alias`; TypeScript gets them from `paths`.
- `wrangler whoami --json` prints `{ loggedIn, email, accounts: [{ id, name }] }` and exits non-zero
  when signed out; `wrangler d1 list --json` lists databases with `uuid` and `name` (wrangler
  4.151's source). Setup lists again after `wrangler d1 create` rather than parsing its human
  output. `wrangler d1 migrations apply --remote` skips its confirmation when not interactive
  (wrangler's help), so the deploy Action can run it.
- A Custom Domain is a route with `custom_domain: true`; deploying creates its DNS record and
  certificate. The hostname's zone must be active on Cloudflare, and the hostname must not already
  have a CNAME record (Cloudflare's docs). Setup's first deploy runs with the operator's own
  `wrangler login`, which creates the domain. Whether a CI token without DNS permissions can create
  one is *unverified*, so CI only redeploys an existing one.
- Cloudflare's *Edit Cloudflare Workers* token template grants Workers Scripts, KV, R2, Tail and
  Workers Routes, but no D1 permission (Cloudflare's template table), so the CI token needs D1 Edit
  added for the migrations every deploy applies. That this is enough to redeploy a Custom Domain is
  *unverified*.
- R2 must be enabled in the dashboard before `wrangler r2 bucket create` works; setup recognises the
  failure by code 10042 or the words "enable R2" (*unverified*), and enabling asks for a payment
  method even on the free tier (*unverified*). Setup checks an R2 token by listing its bucket
  (ListObjectsV2), which an *Object Read & Write* token scoped to that bucket allows; whether such a
  token may also call HeadBucket is *unverified*, so setup doesn't rely on it.
- Retention runs from a Cron Trigger. Deleted Builds and ended Channels keep their D1 rows (without
  the file) so expired Build pages and ended-Channel answers keep working.

## GitHub Actions OIDC

- A job can request a token only with `permissions: id-token: write`; the runner then sets
  `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN`. When they are missing, fail
  with a message naming that permission rather than letting the server answer 401.
- `ACTIONS_ID_TOKEN_REQUEST_URL` already carries a query string: append
  `&audience=<url-encoded deployment URL>`. The response JSON's `value` is the token; mask it in
  logs with `::add-mask::`.
- Verify against issuer `https://token.actions.githubusercontent.com` and its key set at
  `https://token.actions.githubusercontent.com/.well-known/jwks`.
- Claims Drop uses: `aud`, `repository`, `repository_id`, `repository_owner_id`,
  `repository_visibility`, `event_name`, `ref`, `sha`, `run_id`, `run_attempt`, `run_number`,
  `workflow`. Match accounts and repositories by the numeric IDs.
- On `pull_request` runs `sha` (like `GITHUB_SHA`) is the temporary merge commit, not the commit the
  author pushed. The Action sends `pull_request.head.sha` from the event payload for display, along
  with the pull request title and the head commit message; the token carries none of these.
- The `pull_request` payload has no commit messages, and the default shallow checkout of the merge
  commit lacks the head commit, so the Action fetches it alone (`git fetch --depth=1 origin <sha>`)
  before `git log -1`. GitHub serves fetches of any reachable commit by SHA.
- Pull requests from forks never receive `id-token: write`. `pull_request_target` and
  `workflow_run` do, while handling fork content, which is why Drop rejects them by default.

## GitHub App

- Permissions: *Metadata: read*, *Contents: read* and *Pull requests: read and write*. GitHub
  delivers pull request webhooks only to Apps with the Pull requests permission.
- Commit comments (`POST /repos/{owner}/{repo}/commits/{sha}/comments`) need *Contents: read* to
  create, but *Contents: write* to edit or delete (GitHub's "Permissions required for GitHub Apps"
  page), so Drop's are post-only. Adding a permission to an existing App takes effect per
  installation only once its Owner accepts it; until then the post answers 403 "Resource not
  accessible by integration".
- Events: the App subscribes to *Pull request*. `installation` and `installation_repositories`
  reach every App without a subscription.
- The pull request comment is an issue comment (`/repos/{owner}/{repo}/issues/{n}/comments`), which
  *Pull requests: write* covers. Drop finds its own by the hidden marker
  `<!-- drop:pull-request-comment -->` on a comment by a Bot whose `performed_via_github_app` is the
  App; comments made with an installation token carry that field (*unverified*), and one without
  it is still accepted. Two uploads finishing together can both post; the later one deletes the
  newer comment and keeps the oldest.
- Created per deployment through the manifest flow; its private key and webhook secret are Worker
  secrets. Verify webhooks with the `X-Hub-Signature-256` HMAC.
- Manifest flow: POST a `manifest` form field to `https://github.com/settings/apps/new?state=…`
  (`/organizations/<org>/settings/apps/new` for an org); GitHub redirects to the manifest's
  `redirect_url` with `code` and `state`, and `POST /app-manifests/{code}/conversions`, which needs no
  authentication, answers 201 with the App (`id`, `slug`, `client_id`, `html_url`, `owner`) plus
  `client_secret`, `webhook_secret` and `pem`. The whole flow must finish within an hour. GitHub's
  docs don't say whether a loopback `redirect_url` such as `http://127.0.0.1:<port>/callback` is
  accepted; Probot's setup uses `localhost` the same way (*unverified* for 127.0.0.1). App names are
  limited to 34 characters (*unverified*; the docs give no limit). A manifest has no logo field and
  the REST API can't set one, so the logo is uploaded by hand under *Display information* on the
  App's settings page; GitHub rounds it in comments and circles it in some lists.
- It must be installable by other accounts so a deployment can list several, which lets strangers
  install it too; ignore installations and webhooks from accounts whose ID isn't a locked Owner.
- Drop learns which repositories an installation covers from `installation` and
  `installation_repositories` webhooks, and from a resync that lists `GET /app/installations` and,
  for *Only select repositories*, `GET /installation/repositories`. Webhooks alone fall short:
  switching from all to selected reports only the repositories removed (*unverified*), and a missed
  delivery leaves D1 stale. The resync runs hourly from the Cron Trigger and when an upload is denied
  for a missing installation or repository, at most once a minute. With *All repositories* selected
  Drop needs no list, so it doesn't depend on whether `installation.created` includes one
  (*unverified*).
- A suspended installation can't get an access token, so the resync keeps its last known
  repositories and the allow-list refuses its uploads until it is unsuspended.
- GitHub issues the App's private key as PKCS#1 (`BEGIN RSA PRIVATE KEY`), which WebCrypto can't
  import; the Worker wraps it in PKCS#8. App JWTs are backdated 60 seconds and live 9 minutes;
  installation tokens last an hour and are reused until 5 minutes before they expire.
- `GET https://api.github.com/users/<login>` returns the numeric `id` for organizations as well as
  users; unauthenticated calls are limited to 60 an hour, so setup uses `GITHUB_TOKEN` or
  `gh auth token` when it can.
- Pull request comments show images through GitHub's image proxy, so the QR code in a comment has
  to be an image URL the Worker serves for each Build. SVG should work; switch to PNG if the proxy
  rejects it (*unverified*).

## The deploy Action

- For `uses: owner/repo/path@ref`, the runner downloads the whole repository at that ref and
  `github.action_path` (`$GITHUB_ACTION_PATH`) is the action's directory inside it, so the deploy
  Action reaches the server at `$GITHUB_ACTION_PATH/../server`. This is how the runner behaves, but
  GitHub's metadata docs don't say so (*unverified* against the docs; CI runs the Action as
  `uses: ./deploy`, which exercises the same layout).
- `actions/setup-node`'s `node-version-file` is joined to the workspace even when absolute, so from
  another repository it looks for `<workspace>/home/runner/work/_actions/…/.nvmrc` and fails. The
  Action reads `$GITHUB_ACTION_PATH/../server/.nvmrc` in a step and passes `node-version` instead.
  It skips setup-node's npm cache, whose dependency path would sit outside the workspace.

## The upload Action

- `aapt2 dump badging <apk>` gives the package name, `versionCode`, `versionName`,
  `application-label` and `application-icon-<density>` paths; `apksigner verify --print-certs`
  gives the signer's SHA-256 digest. Both live in `$ANDROID_HOME/build-tools/<version>/` on
  GitHub's Ubuntu images, and the Action uses the newest version there.
- apksigner prints only the newest signature scheme's signers, and build-tools 37 changed the line
  format from `Signer #1 certificate SHA-256 digest:` to `V2 Signer: certificate SHA-256 digest:`
  (`V3.0`, `V3.1`, and `V2 Signer #1:` for several signers). A key rotated with a v3.1 lineage
  prints one signer per SDK range; the Action records the current key, the one whose range ends
  highest.
- Apps whose launcher icon exists only as adaptive-icon XML (min SDK 26+) have no bitmap to extract:
  every density in `aapt2 dump badging` points at the XML, often under a shortened name such as
  `res/BW.xml` in release builds. The Action draws it instead: `aapt2 dump xmltree --file` gives the
  `<adaptive-icon>` and its vector drawables with attribute values as `@0x7f…` references,
  `aapt2 dump resources` resolves those to colours and file paths per configuration, and the layers
  are drawn over 108dp and cropped to the inner 72dp every launcher mask shows. Colours, bitmaps and
  vector paths, groups and clip paths are drawn; gradients, colour state lists, theme attributes,
  framework resources and other drawable types fall back to the `icon` input.
- resvg-wasm 2.6 ignores WebP images in an SVG, so WebP layers are decoded with `@jsquash/webp` and
  re-encoded as PNG first. Both modules' `.wasm` files are copied into `action/dist/` by the build.
- Default Channel: runs on the default branch (push, `workflow_dispatch`, `schedule`) go to `main`,
  `pull_request` runs to `pr/<number>`; any other run must pass `channel`.

## Android

- Android installs an update with an equal version code and refuses a lower one
  (`INSTALL_FAILED_VERSION_DOWNGRADE`; only debuggable apps can downgrade, through adb). A different
  signer fails with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`.
- CI runners generate a fresh debug keystore on every run, so debug-signed CI Builds can never update
  each other. Drop leaves signing to the app ([ADR 0006](adr/0006-signing-out-of-scope.md)) but its
  docs must say this prominently.
- `REQUEST_INSTALL_PACKAGES` is restricted on Google Play: it lives only in `drop-android`, which
  the plugin adds to internal variants; store variants get `drop-noop`.
- Before installing, check `PackageManager.canRequestPackageInstalls()`; if false, send the user to
  `Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES` with the app's `package:` URI.
- A backgrounded app cannot start the install confirmation. A `PackageInstaller` session's
  `STATUS_PENDING_USER_ACTION` intent has to be launched while the app is in the foreground, hence
  the persisted ready-to-install state.
- Google Play Protect checks every PackageInstaller install on devices with Play services. For a
  signing key it hasn't seen it shows "App blocked to protect your device… Play Protect hasn't seen
  an app from this developer before" after Android's own confirmation; the Tester must open *More
  details* and tap *Install anyway*. Dismissing it fails the session as
  `INSTALL_FAILED_VERIFICATION_FAILURE` ("User selected REJECT"), reported to the app as
  `STATUS_FAILURE_ABORTED`. Seen on an emulator with Play services (2026-10-15), and again on a
  later install signed with the same key, so choosing *Install anyway* once doesn't stop it; the
  Update sheet prepares Testers for it before every install.
- *Install unknown apps* is granted in Settings, outside the app, so read
  `canRequestPackageInstalls()` again when the app resumes.
- Expect Android's install confirmation on every update: prompt-free updates
  (`setRequireUserAction`, Android 12+) need the updating app to be the installer of record, and
  apps installed from a browser are not.

## SDK

- The Kotlin client comes from OpenAPI Generator's `kotlin` generator with
  `library=multiplatform` (pinned in `android/gradle/libs.versions.toml`), generated into
  `drop-core/build/` on every build and filtered to the operations apps call (`FILTER`
  normalizer), since its webhook operation doesn't compile. `int64` fields become `Long`; GitHub
  run IDs need it.
- `enumUnknownDefaultCase` adds an `unknown_default_open_api` case to each enum but no serializer
  that falls back to it, so an unknown value still fails to decode. `drop-core` decodes with
  `coerceInputValues`, which turns an unknown optional value (`requiresReinstall`) into null, and
  reports an unknown required one (`status`) as a failed check. Ktor wraps decode failures in
  `ContentConvertException`, not `SerializationException`.
- With AGP 9's built-in Kotlin, a library's classes compile to
  `build/intermediates/built_in_kotlinc/<variant>/compile<Variant>Kotlin/classes`, which
  `android/scripts/check-noop-api.sh` reads to compare `drop-noop`'s `Drop` with `drop-android`'s.
- Robolectric 4.17 can't start on API 37, so unit tests pin `sdk=35` in `robolectric.properties`.
- The sample signs every build with its committed `sample.keystore`, so CI builds can update each
  other; real apps must keep their key secret (ADR 0006).

## Gradle plugin

- The plugin is an included build (`android/plugin`), applied by the sample through
  `pluginManagement { includeBuild("plugin") }`. It adds `com.r0adkll.drop:drop-android` or
  `drop-noop` at its own version; inside this repository the sample substitutes the projects.
- aapt2 compiles a meta-data value that fits an int as an int and a larger one, such as a GitHub run
  ID, as a string, so the SDK reads every value with `toString()`.
- The CI environment reaches the manifest task as inputs (`providers.environmentVariable`), which
  keeps the configuration cache correct when they change.
- `drop-core`'s generated client sits at `build/generated/openapi/src/commonMain/kotlin`, and AGP
  looks for a `baselineProfiles` directory beside it, so `prepareAndroidMainArtProfile` must depend
  on the generator.

- Stamp values come from the CI environment: `GITHUB_RUN_ID`; `GITHUB_EVENT_NAME`; the pull request
  number from `GITHUB_REF` (`refs/pull/<n>/merge`); the default branch from the event payload at
  `GITHUB_EVENT_PATH` (`repository.default_branch`), compared with `GITHUB_REF_NAME`.
- Commit-count version codes need `actions/checkout` with `fetch-depth: 0`. On `pull_request`
  events Actions checks out the merge commit, so the count is at least the base branch's.
