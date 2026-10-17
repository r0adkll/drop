# A Build has a Form factor

A Wear OS app shares its phone app's application ID and signing key, since the Wear Data Layer
connects an app only to itself, so both APKs are the same Product and come from the same run. Each
Build therefore has a Form factor, `mobile` or `wear`, read by the upload Action from the APK (a
watch APK declares `android.hardware.type.watch`). A run uploads one Build per Product and Form
factor, and everything that picks "the newest Build of a Channel" picks it per Form factor: Update
checks, retention, and the pages and messages that show a Channel's newest Build.

## Considered Options

- **Several files per Build** (one Build per run, with a phone APK and a watch APK): one Build page
  per run reads well, but the two APKs differ in everything a Build records (version code, Signer
  digest, size, SHA-256, icon), so the Build would become a container and every reader of its file
  would change.
- **A Product per application ID and Form factor**: contradicts
  [ADR 0015](0015-product-identity.md), and duplicates Channels, the default Channel, per-Product
  config and the repository binding for what is one app.

## Consequences

[ADR 0013](0013-stamped-build-identity.md)'s one Build per run becomes one per Form factor; a Stamp
names the run, and the installed Build's Form factor picks which of the run's Builds it is.
[ADR 0007](0007-one-application-id-per-product.md) still holds: a device holds one Build of a
Product, of its own Form factor. Uploads and Update checks that don't say default to `mobile`, so
existing Actions and SDKs keep working. Drop still doesn't depend on version codes
([ADR 0009](0009-order-builds-by-run-id.md)), so a watch APK may share its phone APK's version code
on Drop, though Google Play needs them to differ.
