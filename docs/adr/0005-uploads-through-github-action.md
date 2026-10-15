# Builds are uploaded by a GitHub Action, not a Gradle task

CI uploads Builds with a GitHub Action. A Gradle task would have known the APK path and its
metadata without being told, but an Action works whatever builds the APK (Gradle, Bazel, a
prebuilt file) and keeps uploading a CI concern rather than a build-script one.

## Consequences

Whatever the server needs to know about a Build (application ID, version, signer) has to reach the
Action, so it is read from the APK itself rather than taken from the Gradle model. The Action is a
composite Action that runs `aapt2` and `apksigner`, so the runner needs the Android SDK build
tools (GitHub's Ubuntu images include them). Apps that ship only adaptive launcher icons have no
bitmap to extract, so the icon can also be given as an input.
