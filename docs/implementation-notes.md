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

- Permissions: *Metadata: read* and *Pull requests: read and write*. GitHub delivers pull request
  webhooks only to Apps with the Pull requests permission.
- Created per deployment through the manifest flow; its private key and webhook secret are Worker
  secrets. Verify webhooks with the `X-Hub-Signature-256` HMAC.
- It must be installable by other accounts so a deployment can list several, which lets strangers
  install it too; ignore installations and webhooks for repositories the list doesn't cover.
- Pull request comments show images through GitHub's image proxy, so the QR code in a comment has
  to be an image URL the Worker serves for each Build. SVG should work; switch to PNG if the proxy
  rejects it (*unverified*).

## The Action

- `aapt2 dump badging <apk>` gives the package name, `versionCode`, `versionName`,
  `application-label` and `application-icon-<density>` paths; `apksigner verify --print-certs`
  gives the signer's SHA-256 digest. Both live in `$ANDROID_HOME/build-tools/<version>/` on
  GitHub's Ubuntu images.
- Apps whose launcher icon exists only as adaptive-icon XML (min SDK 26+) have no bitmap to extract;
  use the `icon` input instead.
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
- Expect Android's install confirmation on every update: prompt-free updates
  (`setRequireUserAction`, Android 12+) need the updating app to be the installer of record, and
  apps installed from a browser are not.

## Gradle plugin

- Stamp values come from the CI environment: `GITHUB_RUN_ID`; `GITHUB_EVENT_NAME`; the pull request
  number from `GITHUB_REF` (`refs/pull/<n>/merge`); the default branch from the event payload at
  `GITHUB_EVENT_PATH` (`repository.default_branch`), compared with `GITHUB_REF_NAME`.
- Commit-count version codes need `actions/checkout` with `fetch-depth: 0`. On `pull_request`
  events Actions checks out the merge commit, so the count is at least the base branch's.
