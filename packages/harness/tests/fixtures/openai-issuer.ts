const b64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

export const fakeIssuer = async () => {
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const state = {
    issued: 0,
    refreshes: 0,
    revoked: [] as Array<string>,
    tokenForms: [] as Array<Record<string, string>>,
    nonce: undefined as string | undefined,
    refreshError: undefined as string | undefined,
    subject: "user-123",
    /** The subject a refresh's ID token names, when it differs from the sign-in's. */
    refreshSubject: undefined as string | undefined,
    /** Breaks the next sign-in's ID token in one way. */
    tamper: undefined as "signature" | "audience" | "nonce" | undefined,
    /** Leaves `token_type` out of refresh answers. */
    omitTokenType: false,
    /** Runs while a refresh is in flight, as another process would. */
    duringRefresh: undefined as (() => void) | undefined,
    /** Fails the next authorization-code exchange with this OAuth error. */
    exchangeError: undefined as string | undefined,
  };
  const sign = async (payload: Record<string, unknown>) => {
    const head = b64({ alg: "RS256", kid: "k1", typ: "JWT" });
    const body = b64(payload);
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keys.privateKey,
      new TextEncoder().encode(`${head}.${body}`),
    );
    return `${head}.${body}.${Buffer.from(signature).toString("base64url")}`;
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      const issuer = url.origin;
      if (url.pathname === "/.well-known/openid-configuration")
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/api/accounts/authorize`,
          token_endpoint: `${issuer}/api/accounts/oauth/token`,
          jwks_uri: `${issuer}/jwks`,
          revocation_endpoint: `${issuer}/revoke`,
        });
      if (url.pathname === "/jwks")
        return Response.json({ keys: [{ ...jwk, kid: "k1", alg: "RS256" }] });
      if (url.pathname === "/revoke") {
        const form = Object.fromEntries(
          new URLSearchParams(await request.text()),
        );
        state.revoked.push(form["token"] ?? "");
        return new Response(null, { status: 200 });
      }
      if (url.pathname === "/api/accounts/oauth/token") {
        const form = Object.fromEntries(
          new URLSearchParams(await request.text()),
        );
        state.tokenForms.push(form);
        if (form["grant_type"] === "refresh_token") {
          state.refreshes += 1;
          state.duringRefresh?.();
          if (state.refreshError !== undefined)
            return Response.json(
              { error: state.refreshError },
              { status: 400 },
            );
          // Slow enough that concurrent callers overlap.
          await Bun.sleep(150);
        } else if (state.exchangeError !== undefined)
          return Response.json({ error: state.exchangeError }, { status: 400 });
        state.issued += 1;
        const n = state.issued;
        const now = Math.floor(Date.now() / 1000);
        const refreshing = form["grant_type"] === "refresh_token";
        const tamper = refreshing ? undefined : state.tamper;
        let idToken = await sign({
          iss: issuer,
          aud:
            tamper === "audience" ? "oaiapp_someone_else" : form["client_id"],
          sub: refreshing
            ? (state.refreshSubject ?? state.subject)
            : state.subject,
          email: "owner@example.com",
          name: "Owner",
          iat: now,
          exp: now + 3600,
          ...(refreshing
            ? {}
            : { nonce: tamper === "nonce" ? "another-nonce" : state.nonce }),
        });
        if (tamper === "signature")
          idToken = `${idToken.slice(0, idToken.lastIndexOf(".") + 1)}${Buffer.from("forged").toString("base64url")}`;
        return Response.json({
          access_token: `access-secret-${n}`,
          refresh_token: `refresh-secret-${n}`,
          ...(refreshing && state.omitTokenType
            ? {}
            : { token_type: "Bearer" }),
          expires_in: 3600,
          scope:
            "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke",
          id_token: idToken,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    issuer: `http://127.0.0.1:${server.port}`,
    state,
    stop: () => server.stop(true),
  };
};
