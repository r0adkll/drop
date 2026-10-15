# Installed Builds are recognised by a stamp, not by hashing the APK

The Gradle plugin writes the Product, Channel and GitHub run ID into the APK at build time, and the
SDK sends that stamp with each Update check; the server finds the Build uploaded from that run.
Hashing the installed APK on the device would have identified Builds without any build-time step,
but it costs a read of the whole APK and still cannot tell a local build which Channel to follow.

## Consequences

A run may upload at most one Build per Product, otherwise the stamp is ambiguous; the server rejects
a second one. An APK with no stamp (a local build) is unknown to Drop: it follows the Channel set in
the app's Drop configuration and treats every Build there as newer.
