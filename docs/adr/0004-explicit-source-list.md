# A deployment serves an explicit list of accounts and repositories

Each Drop deployment has one operator and serves only the repositories its config lists. Every
entry is either a whole GitHub account (all of its repositories may upload) or a single repository,
and entries may come from any number of accounts, such as a personal account plus an organization.
The list is required and is the deployment's only boundary: an empty list accepts nothing. Setup
records the numeric ID behind each entry, and uploads are matched against the IDs in the upload's
OIDC token, so renaming an account or repository neither breaks nor widens access. Drop is open
source and meant to be easy to deploy, so anyone else runs their own deployment on their own
Cloudflare account; there is no shared, multi-tenant service.

## Considered Options

- **One Owner per deployment:** simpler, but someone whose apps span a personal account and an
  organization would need two deployments.
- **Repositories only, no whole-account entries:** every new app would need a config change.

## Consequences

- Nothing specific to one deployment (domains, accounts, repositories) may be hard-coded in the
  repository; it all comes from deployment configuration.
- The GitHub App must be installable by every listed account, which means strangers can install it
  too. Drop ignores installations and webhooks for repositories the list doesn't cover.
