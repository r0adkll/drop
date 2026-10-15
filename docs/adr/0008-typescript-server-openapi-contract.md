# TypeScript server in a monorepo, with OpenAPI as the contract

The server is written in TypeScript (Hono), which is native to Workers, rather than Kotlin/JS or
Kotlin/Wasm, whose Workers tooling is immature and whose bundles are large. It lives in one
repository with the Android code, and an OpenAPI document in the server is the single definition
of the API, from which the Kotlin client is generated so the two languages cannot drift.
