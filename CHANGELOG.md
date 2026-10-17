# Changelog

Drop's SDK, Gradle plugin, upload Action and deploy Action share one version and are released
together (docs/design.md#releases). Each change adds a line under Unreleased; `scripts/release`
turns that section into the release, and its text becomes the GitHub Release's notes.

## [Unreleased]

## [0.4.0] - 2026-10-17

### Added

- Server: Builds have a Form factor, `mobile` or `wear`, so a run can upload a Wear OS APK beside
  its phone APK under the same application ID. The Update check offers each installed Build only
  Builds of its own Form factor. Until Wear Builds are designed for, they have a Build page but are
  left out of the site pages, pull request comments, commit comments and webhooks. Deploying runs a
  migration that rebuilds the `builds` and `uploads` tables.
- Action: uploads a Wear OS APK as a Wear Build, recognising it from the
  `android.hardware.type.watch` feature it requires. Upload it with a second step in the same job.
  The Deployment must run this release first.
- SDK: a Build installed on a Wear OS watch checks for Wear Builds only. `InstalledBuild` has a
  `formFactor`, so an app can also check on another device's behalf, such as its watch app's.

## [0.3.1] - 2026-10-17

### Changed

- Gradle plugin: declares support for the Configuration Cache and Isolated Projects, which the Gradle
  Plugin Portal shows on its page.

## [0.3.0] - 2026-10-16

### Added

- Deployment: `./drop delete-build <id>` removes a Build at once, such as one that leaked a secret.
  Its APK is deleted, its Build page says the operator removed it, and a re-run of its workflow
  can't upload it again.
- Deployment: `./drop` takes its commands from the pinned Drop release, so new commands arrive when
  the pin moves, and `./drop self-update` replaces the script when it is out of date. Deployment
  repositories made before this copy it once:
  `cp "$(./drop cache-dir)/deployment/template/drop" drop` (after any `./drop` run that synced).

### Changed

- Server: reopening a pull request opens its Channel again, so its runs can upload once more, and
  its comment goes back to listing its Builds (or says it has none until the next upload).

## [0.2.0] - 2026-10-16

### Added

- Action: a `notes` input for a Build's release notes. Their first line becomes the Build's
  headline, ahead of the pull request title, and the rest is shown as What's new on the Build page
  and in the Update sheet. Server: `whatsNew` in the update check.

### Fixed

- Update sheet: Ready to install no longer promises the app reopens after updating; it says to
  open it again from the home screen, which is what Android does.

## [0.1.1] - 2026-10-16

### Added

- Server: an index of apps at `/`, a page per app (`/p/<applicationId>`) and a page per Channel
  (`/p/<applicationId>/c/<channel>`) listing its Builds. Public products only;
  `"pages": { "index": false }` turns the index and app pages off.
- Gradle plugin: `drop { channelFor { variant -> … } }` sets the Channel each variant's local
  (unstamped) Builds follow, such as `beta` for a beta flavor.

### Fixed

- Gradle plugin: `versionCodeFromCommits` counts first-parent commits only, so a pull request's
  Build no longer out-counts the main Build its merge produces.
- Gradle plugin: store variants (drop-noop) no longer get Drop's settings or the CI Stamp in their
  manifest, which leaked the server URL and broke reproducible builds.

## [0.1.0] - 2026-10-16

The first release: milestone 1, Public products.

### Added

- Server: a Cloudflare Worker (R2 and D1) that accepts uploads from GitHub Actions, verified by
  OIDC and limited to the repositories its listed Owners install its GitHub App on.
- Build pages with QR codes, downloads that resume, and expired and private states.
- A pull request comment per pull request, edited in place, and a comment on the commit of every
  other Build.
- Retention: older Builds and closed pull requests' Builds are deleted on schedule; icons and
  records stay.
- The Update check API (`GET /api/v1/update`).
- Slack, Discord and signed JSON webhooks when a Build lands.
- Upload Action (`r0adkll/drop/action@v0`): reads the APK with aapt2 and apksigner, draws adaptive
  launcher icons, and takes its Channel from `DROP_CHANNEL`.
- Deploy Action (`r0adkll/drop/deploy@v0`) and config-only deployment repositories with
  `./drop setup`.
- Android SDK (`com.r0adkll.drop:drop-android`): Update checks, downloads through DownloadManager,
  SHA-256 verification and installs through PackageInstaller; `drop-noop` for store builds.
- Update sheet (`com.r0adkll.drop:drop-ui`) for Compose and View-based apps.
- Gradle plugin (`com.r0adkll.drop`): picks the SDK or the no-op per variant, writes its config and
  the CI Stamp into the manifest.
