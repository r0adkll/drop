# Builds are ordered by GitHub run ID, not version code

Within a Channel, the newest Build is the one from the highest GitHub Actions run ID, with upload
time breaking ties. Version codes are not used for ordering because apps often keep one version
code across internal builds, which Android allows (it refuses only a lower version code), and that
also means switching Channels never forces an uninstall. Run IDs only increase, come from the
upload's OIDC token so they cannot be forged, and survive re-runs: re-running last week's workflow
does not make its Build the newest.

## Consequences

The version code is recorded but used only to warn that an install would go down a version code
and so needs a reinstall.
