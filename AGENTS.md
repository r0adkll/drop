# Drop

Self-hosted distribution and in-app updates for Android CI builds: a Cloudflare Worker (R2 + D1), a
GitHub Action that uploads Builds, and a Kotlin SDK plus Gradle plugin that let apps update
themselves. Scope is in [`README.md`](README.md); milestone 1 serves Public products only.

## Where things are decided

- [`CONTEXT.md`](CONTEXT.md): the glossary. Name types, tables, routes and UI copy with its terms
  (Product, Build, Channel, Stamp, Update…). When a new concept needs a name, settle it there
  first.
- [`docs/design.md`](docs/design.md): behaviour and the repository layout. Read the section for the
  component you are building before starting it.
- [`docs/adr/`](docs/adr): decisions and their reasons. Read the ADR before changing anything it
  covers. A change that contradicts one updates or supersedes that ADR in the same change, and a
  new hard-to-reverse decision gets the next numbered ADR.
- [`docs/implementation-notes.md`](docs/implementation-notes.md): platform facts and gotchas
  (Workers limits, GitHub OIDC claims, the GitHub App, aapt2/apksigner, Android install rules).
  Read it before writing server, Action, plugin or SDK code.

## Working rules

- **Design before UI.** Every user-facing surface (Build page and its expired state, pull request
  comment, Update sheet, Slack and Discord messages) starts with a design iteration: mockups or
  options agreed with the maintainer before any implementation. Non-UI work starts directly.
- **Ask in rounds.** Every question or decision for the maintainer, design-review options included,
  goes out as one round through Clinic's `ask_round` tool, each question carrying your
  recommendation. In the conversation, write only each question's title and recommendation. Where
  Clinic isn't available, ask in the conversation in the same shape.
- **Open source.** The repository is public and anyone deploys their own copy. Everything specific
  to a deployment comes from `drop.config.json` or Worker secrets; examples use placeholders such as
  `drop.example.com`, `your-org` and `you/app`.
- **Changelog.** A change people using Drop would notice adds a line under Unreleased in
  [`CHANGELOG.md`](CHANGELOG.md); it becomes the release notes (`scripts/release`).
- **One contract.** The OpenAPI document in `server/` defines the API; the Kotlin client is
  generated from it.
