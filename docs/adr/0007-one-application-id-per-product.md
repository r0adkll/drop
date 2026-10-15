# One application ID per Product

Each Product installs under exactly one Android application ID, and all of its Channels share it,
so a device holds at most one Build of a Product at a time. Letting Channels carry their own
application ID suffix would allow side-by-side installs, but every part of Drop (the model, the
Update check, the Tester app) would then have to reason about several install slots per Product.
When side-by-side installs are really wanted, they are two Products.
