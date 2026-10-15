# Drop Action

Uploads an Android Build to a Drop deployment. Usage is in the [repository README](../README.md);
behaviour in [`docs/design.md`](../docs/design.md#upload-authentication).

```sh
npm install
npm test
npm run typecheck
npm run build     # bundles src/ into dist/index.mjs, which is checked in
```

GitHub runs the Action from `dist/`, so rebuild and commit it with every change to `src/`. CI fails
when `dist/` is out of date. Request and response types come from the server's OpenAPI document
(`../server/src/generated/openapi.ts`).
