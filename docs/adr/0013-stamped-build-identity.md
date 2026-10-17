# Installed Builds are recognised by a stamp, not by hashing the APK

The Gradle plugin writes the Product, Channel and GitHub run ID into the APK at build time, and the
SDK sends that stamp with each Update check; the server finds the Build uploaded from that run.
Hashing the installed APK on the device would have identified Builds without any build-time step,
but it costs a read of the whole APK and still cannot tell a local build which Channel to follow.

## Consequences

A run may upload at most one Build per Product and Form factor
([ADR 0017](0017-builds-have-a-form-factor.md)), otherwise the stamp is ambiguous. A second upload
from the same run replaces the first while the first is still pending (its files not yet
confirmed), so a failed upload can be retried. Once confirmed, it is replaced only by a later attempt
of the run (*Re-run jobs* keeps the run ID and raises `run_attempt`): the Build keeps its ID and
Build page URL, and its file is swapped. An upload from the same or an earlier attempt is rejected.
Re-running a workflow therefore succeeds, and an installed Build from the earlier attempt still
resolves, because the stamp names the run, not the attempt.

An APK with no stamp (a local build) is unknown to Drop: it follows the Channel set in the app's Drop
configuration and treats every Build there as newer.
