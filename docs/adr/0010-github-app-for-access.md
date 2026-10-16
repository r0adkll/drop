# A GitHub App checks repo access and talks to pull requests

A Product is public or private according to its repository's visibility, read from the upload's
OIDC token; deployment config can force a public repository's Product private, never the reverse.
Testers of a private Product must be able to read its repository. Drop checks that with a GitHub
App installed on the Allowed repositories: its user tokens see only repositories both the person
and the App can access, so they answer "can this person read it" without asking Testers for
anything broader.

The same App receives pull request webhooks (so Drop knows when a Pull request channel ends) and
posts the comment announcing each Build on its pull request. Builds on any other Channel are
announced with a comment on their commit, which GitHub lets an App create with *Contents: read*
but edit or delete only with *Contents: write*. Write would let the App push code, so Drop never
takes it, and commit comments are post-only. The App therefore holds *Metadata: read*,
*Contents: read* and *Pull requests: read and write*, and nothing else.

## Considered Options

- **OAuth App with the `repo` scope:** asks every Tester for read/write access to all their private
  repositories.
- **Scope-less OAuth App plus a server token listing collaborators:** misses access granted through
  organization teams unless Drop resolves membership itself.
- **Posting the pull request comment from the Action with `GITHUB_TOKEN`:** would have kept the App
  read-only, but every workflow would need `pull-requests: write` and its own comment step.
- **A check run instead of a commit comment:** needs only *Checks: write* and can be edited, but
  puts nothing on the commit page itself; the link sits one click into the commit's checks.

## Consequences

Each deployment needs its own GitHub App. Setup (`./drop setup`) creates it through GitHub's
manifest flow, under the personal account of whoever runs setup: it opens GitHub's create-App form
pre-filled from a manifest, receives GitHub's redirect on `localhost`, exchanges the code for the
App's credentials, keeps the private key and webhook secret for the Worker's secrets (uploaded with
its first deploy, or with `wrangler secret bulk` once it exists), and writes the App's ID and slug
into `drop.config.lock.json`. The App is
private when the setup account is the only listed Owner, and public otherwise, so that the other
Owners can install it ([ADR 0004](0004-explicit-source-list.md)). *Contents: read* is the costliest
of these: anyone holding the App's private key can read the source of every repository it is
installed on. An Owner who installed the App before it asked for Contents must accept the new
permission in GitHub; until then Drop skips commit comments. Because the App posts the pull
request comments and decides which repositories may upload, it is part of the first milestone even
though private Products come later.

A setup page on the Worker was considered first. It was dropped because a Worker cannot set its
own secrets, so the page would have had to display the private key for the operator to copy into
`wrangler secret put` anyway, and because a public setup route on every deployment is attack
surface kept for a page used once.
