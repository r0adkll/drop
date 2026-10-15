# Android only; iOS deferred, desktop out of scope

Drop supports Android only. iOS needs a different install path (ad-hoc signing, device UDID
registration, `itms-services` links, no in-app install), so it is deferred to a later iteration
rather than shaping the first one. Desktop platforms are out of scope: macOS already has Sparkle
for in-app updates.

## Consequences

The data model and APIs still carry a platform field so that adding iOS later is additive.
