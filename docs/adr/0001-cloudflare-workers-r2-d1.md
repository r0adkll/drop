# Cloudflare Workers, R2 and D1 are the only server runtime

The server is one Cloudflare Worker, with binaries in R2 and metadata in D1. The deciding factor is
cost: R2 charges nothing for egress, and builds are downloaded far more often than they are
uploaded, so a typical deployment runs inside the free tier. We accept lock-in to Cloudflare in
exchange; the server is not written to run anywhere else.

## Consequences

Workers on the free and $5 plans reject request bodies over 100 MB, and APKs can exceed that.
Builds are therefore never uploaded through the Worker: it hands CI a presigned URL and CI writes
the file to R2 directly.
