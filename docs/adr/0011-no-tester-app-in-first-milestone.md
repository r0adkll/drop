# No tester-side app in the first milestone

Testers install Builds from Build pages, and apps update themselves through the SDK; there is no
tester-side updater, neither a native Tester app nor Obtainium. Both add a surface (feeds, per-
Tester credentials in links, channel switching outside the app) that the first milestone does not
need in order to replace Firebase App Distribution.

## Considered Options

- **Obtainium** (researched against its source at commit `af286fa`): its generic HTML source can
  follow a per-Channel page, and `obtainium://app/{json}` links add an app in one tap, so it could
  serve as the Tester app. It tracks only one source per application ID, cannot tell when a pull
  request closes, sends only static credentials, and reports nothing back. It remains the first
  candidate if a tester-side updater is wanted later.
- **A native Tester app:** deferred for the same reason, and because it duplicates what the SDK
  already does inside each app.
