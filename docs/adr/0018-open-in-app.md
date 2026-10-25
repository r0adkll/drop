# A Build page can offer its Build to the installed app

A Build page can carry **Open in App**, which opens the installed app at a link its upload gave,
and the app's SDK offers that one Build for install, whatever Channel the installed Build follows.
The workflow passes the link as a template, `open-in-app: trailhead://drop/{build}`, and Drop fills
in the Build's ID. The app recognises its own link, reads the ID and calls `drop.check(buildId)`;
the SDK asks its own configured server, so the link carries an ID and never a server. The page
wraps the link in an Android `intent:` URL aimed at the Product's application ID, with the Build
page as its fallback, so it opens only the Drop-installed app (not a store build claiming the same
scheme) and a phone without it stays on the page rather than going to Google Play.

## Considered Options

- **One link per Product in the deployment config**, beside `displayName` and `icon`: the operator
  owns it, and it can't carry the Build, so the app could only open, not offer an install.
- **A Drop link the SDK handles itself**: no setup, but it adds an exported activity to every
  internal Build and opens the app without its own say in the URI.
- **The link as given, without the intent wrapper**: works in more browsers, but may open a store
  copy or a chooser, and fails silently or with an error page when nothing handles it.

## Consequences

An installed Build follows the Channel stamped into it ([ADR 0013](0013-stamped-build-identity.md)),
so installing a Build from another Channel switches the app to that Channel: a `pr/151` Build
follows `pr/151` until its pull request closes, then is offered the default Channel's newest. The
SDK keeps no Channel override. The switch happens inside the app, with the Tester's say, so
[ADR 0011](0011-no-tester-app-in-first-milestone.md) still holds. Any page can open the app's link
with any Build ID, so the server offers only a Build of the installed Product and Form factor, and
the Tester still confirms the install. Older Builds can be opened too; one Android won't install
over the installed Build is offered as a reinstall, as an Update check does.
