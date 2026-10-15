import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/errors";
import { createTokenVerifier } from "../../src/oidc";
import { AUDIENCE, NOW, createIssuer, jwksFetch } from "./support";

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

describe("createTokenVerifier", () => {
  it("accepts a GitHub token for this deployment and parses its claims", async () => {
    const issuer = await createIssuer();
    const verify = createTokenVerifier({ audience: AUDIENCE, fetch: jwksFetch([issuer.publicJwk]).fetch, now: () => NOW });

    const claims = await verify(await issuer.sign());

    expect(claims).toEqual({
      repository: "your-org/trailhead",
      repositoryId: 1001,
      repositoryOwnerId: 2001,
      repositoryVisibility: "public",
      eventName: "push",
      ref: "refs/heads/main",
      sha: "a".repeat(40),
      runId: 11384729304,
      runAttempt: 1,
      runNumber: 1876,
      workflow: "Android",
    });
  });

  it.each([
    ["another audience", { audience: "https://other.example.com" }],
    ["another issuer", { issuer: "https://issuer.example.com" }],
    ["an expired token", { iat: Math.floor(NOW / 1000) - 1000, exp: Math.floor(NOW / 1000) - 120 }],
    ["a token not yet valid", { nbf: Math.floor(NOW / 1000) + 300 }],
  ])("rejects %s", async (_name, options) => {
    const issuer = await createIssuer();
    const verify = createTokenVerifier({ audience: AUDIENCE, fetch: jwksFetch([issuer.publicJwk]).fetch, now: () => NOW });

    const error = await rejection(verify(await issuer.sign({}, options)));

    expect(error.status).toBe(401);
    expect(error.code).toBe("token_invalid");
  });

  it("tolerates a minute of clock skew", async () => {
    const issuer = await createIssuer();
    const verify = createTokenVerifier({ audience: AUDIENCE, fetch: jwksFetch([issuer.publicJwk]).fetch, now: () => NOW });

    await expect(verify(await issuer.sign({}, { exp: Math.floor(NOW / 1000) - 30 }))).resolves.toBeDefined();
  });

  it("rejects a token signed by a key that isn't GitHub's", async () => {
    const github = await createIssuer("key-1");
    const forger = await createIssuer("key-1");
    const verify = createTokenVerifier({ audience: AUDIENCE, fetch: jwksFetch([github.publicJwk]).fetch, now: () => NOW });

    expect((await rejection(verify(await forger.sign()))).code).toBe("token_invalid");
  });

  it("rejects symmetric algorithms", async () => {
    const issuer = await createIssuer();
    const verify = createTokenVerifier({ audience: AUDIENCE, fetch: jwksFetch([issuer.publicJwk]).fetch, now: () => NOW });
    const hs256 = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256", kid: issuer.kid })
      .setIssuer("https://token.actions.githubusercontent.com")
      .setAudience(AUDIENCE)
      .setExpirationTime(Math.floor(NOW / 1000) + 60)
      .sign(new TextEncoder().encode("secret"));

    expect((await rejection(verify(hs256))).code).toBe("token_invalid");
  });

  it("rejects a token missing a claim Drop uses", async () => {
    const issuer = await createIssuer();
    const verify = createTokenVerifier({ audience: AUDIENCE, fetch: jwksFetch([issuer.publicJwk]).fetch, now: () => NOW });

    const error = await rejection(verify(await issuer.sign({ run_attempt: undefined })));

    expect(error.code).toBe("token_invalid");
    expect(error.message).toContain("run_attempt");
  });

  it("caches the key set and refetches it once when GitHub rotates keys", async () => {
    const old = await createIssuer("old");
    const rotated = await createIssuer("new");
    const keys = jwksFetch([old.publicJwk], [old.publicJwk, rotated.publicJwk]);
    let now = NOW;
    const verify = createTokenVerifier({ audience: AUDIENCE, fetch: keys.fetch, now: () => now });

    await verify(await old.sign());
    await verify(await old.sign());
    expect(keys.calls).toHaveLength(1);

    now += 60_000;
    await expect(verify(await rotated.sign({}, { iat: Math.floor(now / 1000) - 10 }))).resolves.toBeDefined();
    expect(keys.calls).toHaveLength(2);
  });

  it("doesn't refetch for an unknown key straight after fetching", async () => {
    const issuer = await createIssuer("known");
    const keys = jwksFetch([issuer.publicJwk]);
    const verify = createTokenVerifier({ audience: AUDIENCE, fetch: keys.fetch, now: () => NOW });

    expect((await rejection(verify(await issuer.sign({}, { kid: "made-up" })))).code).toBe("token_invalid");
    expect(keys.calls).toHaveLength(1);
  });
});
