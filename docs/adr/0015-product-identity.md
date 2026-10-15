# A Product is its application ID, bound to one repository

A Product is identified by its Android application ID, which is unique within a deployment. The
first upload binds it to the uploading repository's GitHub repository ID (an OIDC claim that
survives renames and transfers), and uploads of that application ID from any other repository are
rejected. Allowing the same application ID in several repositories would let their Builds replace
each other on a device, and would let a fork in another Allowed repository take over a Product's
Testers.

## Consequences

The SDK needs no Product setting: it sends the app's own application ID with its Stamp.
