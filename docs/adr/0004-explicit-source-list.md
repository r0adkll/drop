# A deployment serves the repositories its listed Owners install it on

Each Drop deployment has one operator and serves only the accounts its config lists. Every entry
names an Owner, a GitHub user or organization, and entries may come from any number of accounts,
such as a personal account plus an organization. Within a listed Owner, the repositories that may
upload are the ones the deployment's GitHub App is installed on, as chosen in GitHub's installation
settings (*All repositories* or *Only select repositories*). An upload is accepted only when its
OIDC token's `repository_owner_id` is a listed Owner's ID and its `repository_id` is in that
Owner's installation. The list is required and is the deployment's trust boundary: an empty list
accepts nothing, and an installation by an unlisted account grants nothing.

Owners are matched by numeric ID, never by name: a renamed or deleted account's name can be
registered by someone else, but its ID is never reused. Setup (`./drop setup`) resolves each listed Owner
to its ID through the GitHub API and writes `drop.config.lock.json`, which is checked in and bundled
into the Worker; the deploy check fails while a listed Owner is missing from it. Repository IDs come
from the installation itself, which the Worker records from the App's `installation` and
`installation_repositories` webhooks.

Drop is open source and meant to be easy to deploy, so anyone else runs their own deployment on
their own Cloudflare account; there is no shared, multi-tenant service.

## Considered Options

- **One Owner per deployment:** simpler, but someone whose apps span a personal account and an
  organization would need two deployments.
- **Config lists Owners and single repositories, IDs in a lockfile; the App only posts comments:**
  every new app or removed app needs a config change and a redeploy, when the App every deployment
  already installs can carry the same choice.
- **The App's installations alone, with no list:** a deployment covering several accounts needs a
  public App, and anyone can install a public App, so installation cannot be the boundary. A
  private App works only for a single account.
- **Pinning an Owner's ID on its first installation instead of a lockfile:** no setup step, but
  trust would rest on whichever account first installed under a listed name, and the pinned IDs
  would live in D1 rather than in reviewable, checked-in config.

## Consequences

- Nothing specific to one deployment (domains, accounts) may be hard-coded in the repository; it all
  comes from deployment configuration.
- Uploads depend on the GitHub App being installed, not only pull request comments
  ([ADR 0010](0010-github-app-for-access.md)), and the Worker must keep its record of installations
  current from webhooks.
- The App must be installable by every listed Owner, which means strangers can install it too. Drop
  ignores installations and webhooks from accounts the list doesn't cover.
- Per-repository config entries remain only to grant exceptions, such as allowing
  `pull_request_target` or `workflow_run` uploads; they do not grant access by themselves.
