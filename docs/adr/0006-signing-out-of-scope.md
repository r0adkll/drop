# Drop does not manage signing keys

Android installs an update only when it is signed with the same certificate as the installed app,
so every Build of a Product must be signed with one stable internal key; the per-machine debug key
that CI runners generate afresh on every run will not do. Choosing, storing and wiring that key is
left to each app's own build and documented, not automated: Drop never holds or configures
keys.

## Consequences

Drop detects signer problems instead of preventing them. Each Build records its signing
certificate's SHA-256, and an Update check offers only Builds signed by the same certificate as
the installed one, answering that a reinstall is required when every newer Build is signed
differently.
