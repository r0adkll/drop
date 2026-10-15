# Builds are uploaded by a GitHub Action, not a Gradle task

CI uploads Builds with a GitHub Action. A Gradle task would have known the APK path and its
metadata without being told, but an Action works whatever builds the APK (Gradle, Bazel, a
prebuilt file) and keeps uploading a CI concern rather than a build-script one.

## Consequences

Whatever the server needs to know about a Build (application ID, version, signer) has to reach the
Action, so it is read from the APK itself rather than taken from the Gradle model. The Action is a
`node24` JavaScript Action that runs `aapt2` and `apksigner`, so the runner needs the Android SDK
build tools (GitHub's Ubuntu images include them). It is TypeScript rather than a composite Action
in shell because the upload is real code (the OIDC token, presigned `PUT`s, the event payload), and
TypeScript lets it share the types generated from the server's OpenAPI document and be unit tested.
Its bundled `dist/` is checked in, because GitHub runs an Action straight from its repository. Apps that ship only adaptive launcher icons have no
bitmap to extract, so the icon can also be given as an input.
