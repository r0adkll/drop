# Changelog

Drop's SDK, Gradle plugin, upload Action and deploy Action share one version and are released
together (docs/design.md#releases). Each change adds a line under Unreleased; `scripts/release`
turns that section into the release, and its text becomes the GitHub Release's notes.

## [Unreleased]

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
