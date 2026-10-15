# Deployments are config-only repositories pinned to a Drop release

Each Deployment lives in its own repository that holds only configuration: `drop.config.json`,
`drop.config.lock.json`, a `./drop` script and a deploy workflow. The workflow's
`uses: r0adkll/drop/deploy@<ref>` pins the Drop release, and the deploy Action deploys the server
code from that same ref. `./drop` reads the same pin to run setup and local development from a
cached checkout of that release, so setup, CI and local runs use one version, and upgrading Drop is
a one-line change to the ref. `deployment/init.sh` creates such a repository from the starter files
in `deployment/template`, which version with Drop. `r0adkll/drop` itself keeps only placeholders.

## Considered Options

- **A template repository (the earlier design):** each adopter copies the whole of Drop. The copy
  starts a fresh history, so later releases can only be merged by hand across unrelated histories,
  and the server, SDK, Action and plugin are released together, so adopters need upgrades often.
- **A fork:** upgrades are a `git pull`, but forks of a public repository are public, and the
  deployment's lockfile and config would sit beside all of Drop's code.
- **Setup published as an npm package (`npx @r0adkll/drop setup`):** a fourth release channel to
  maintain, and nothing would tie its version to the deploy workflow's pin. A clone of the pinned
  ref needs no publishing and cannot drift.
- **A separate template repository for the starter files:** one more repository to keep in step by
  hand; inside `r0adkll/drop` they release with everything else.

## Consequences

- Nothing deployment-specific is ever committed to `r0adkll/drop`; the Worker bundles the
  deployment's config and lockfile through module aliases, from whichever directory deploys it.
- The lockfile also records the deployment's Cloudflare resources, and setup creates them.
- The deploy Action is released with the SDK, the Gradle plugin and the upload Action, under the
  same version.
- Running `./drop` needs git, Node.js and npm on the operator's machine.
