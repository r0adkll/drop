# Drop

Drop distributes internal builds of Android apps from CI to the people testing them, and lets
those apps update themselves to newer builds.

## Language

### Distribution

**Product**:
An app distributed through Drop, linked to the GitHub repository that builds it and installed under
a single Android application ID.
_Avoid_: App, project

**Build**:
One uploaded, installable binary of a Product, identified by its version code and the commit it
was built from.
_Avoid_: Artifact, release, binary

**Channel**:
A named stream of Builds of one Product that an installed Build follows for updates.
_Avoid_: Track, flavor

**Default channel**:
The Channel a Product's default-branch Builds go to, and where Builds on an ended Pull request
channel are sent.
_Avoid_: Main channel, stable channel

**Pull request channel**:
A Channel holding the Builds of one pull request; it ends when the pull request is merged or
closed.
_Avoid_: PR track, branch channel

**Signer**:
The certificate a Build is signed with. A Build can only update an installed Build with the same
Signer.
_Avoid_: Signature, key

**Build page**:
The web page for a single Build, with its QR code and install button.
_Avoid_: Download page, landing page

**Stamp**:
The Product, Channel and CI run written into a Build when it is built, by which Drop recognises an
installed Build.
_Avoid_: Build metadata, fingerprint

### People and access

**Tester**:
A person, identified by their GitHub account, who may install Builds of a Product.
_Avoid_: User, member

**Allowed repository**:
A GitHub repository that may upload Builds to a deployment, because the deployment lists it or its
whole Owner.
_Avoid_: Source, trusted repo

**Owner**:
A GitHub user or organization that a deployment lists whole, so that all of its repositories are
Allowed repositories.
_Avoid_: Tenant, account

**Public product**:
A Product whose Builds anyone with a link can install, without signing in.
_Avoid_: Open product, unlisted

**Private product**:
A Product whose Builds only Testers who can read its repository may install.
_Avoid_: Protected product, internal product

### Clients

**Update check**:
A request from an installed Build asking whether a newer Build exists on its Channel.
_Avoid_: Poll, version check

**Update**:
A newer Build offered to an installed Build by an Update check.
_Avoid_: New version, upgrade

**Update sheet**:
Drop's ready-made prompt that an app can choose to show, offering an Update and carrying it through
download and install.
_Avoid_: Update dialog, popup
