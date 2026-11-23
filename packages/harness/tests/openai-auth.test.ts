// Why: 10.85 keeps the OpenAI sign-in readable only by the user, refreshed as needed, and never in
// logs or output. Those properties live at the file and token-endpoint boundary, which no type
// checks: a wrong mode, a token in an error message or a refresh that races a rotating token only
// shows on a real machine, weeks later. This drives the whole sign-in against a local fake issuer
// (discovery, JWKS, a signed ID token, the token and revocation endpoints) in a scratch config
// folder, never the real endpoint or the owner's files.
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OpenAiAuthError,
  OPENAI_SCOPES,
  accessToken,
  authDirectory,
  authFilePath,
  readAuth,
  signIn,
  signOut,
  signedIn,
  status,
  withLock,
  writeAuth,
} from "../src/openai-auth.ts";

const scratch = mkdtempSync(join(tmpdir(), "neuve-openai-auth-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const b64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/** A fake issuer: discovery, JWKS, token and revocation endpoints, with a request log. */
const fakeIssuer = async () => {
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

let issuer: Awaited<ReturnType<typeof fakeIssuer>>;
beforeAll(async () => {
  issuer = await fakeIssuer();
});
afterAll(() => issuer.stop());

/**
 * The owner's browser: opens the listener's start page, follows its redirect to the authorisation
 * request (recorded in `seen`), then returns to the callback, after `before` has had its turn.
 */
const browser =
  (
    clientId: string,
    seen: Array<URL>,
    before?: (callback: URL) => Promise<void>,
  ) =>
  async (link: string) => {
    expect(link).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/start\/[\w-]{43}$/);
    const start = await fetch(link, { redirect: "manual" });
    expect(start.status).toBe(302);
    const url = new URL(start.headers.get("location")!);
    seen.push(url);
    issuer.state.nonce = url.searchParams.get("nonce") ?? undefined;
    const redirect = new URL(url.searchParams.get("redirect_uri")!);
    redirect.searchParams.set("code", "one-time-code");
    redirect.searchParams.set("state", url.searchParams.get("state")!);
    redirect.searchParams.set("client_id", clientId);
    await before?.(redirect);
    const answer = await fetch(redirect);
    expect(answer.status).toBe(200);
  };

/** A raw GET with a chosen Host header, which fetch would not send. */
const rawGet = (url: URL, host: string) =>
  new Promise<string>((resolve, reject) => {
    let reply = "";
    void Bun.connect({
      hostname: url.hostname,
      port: Number(url.port),
      socket: {
        open: (socket) => {
          socket.write(
            `GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
          );
        },
        data: (_socket, data) => {
          reply += data.toString();
        },
        close: () => resolve(reply),
        error: (_socket, error) => reject(error),
      },
    });
  });

const secrets = (text: string) =>
  [
    ...text.matchAll(/(access|refresh)-secret-\d+|eyJ[\w-]+\.[\w-]+\.[\w-]+/g),
  ].map((match) => match[0]);

test("the sign-in folder follows XDG_CONFIG_HOME only when it is absolute", () => {
  expect(authDirectory({ XDG_CONFIG_HOME: "/x/config" }, "/home/u")).toBe(
    "/x/config/neuve",
  );
  expect(authDirectory({ XDG_CONFIG_HOME: "relative" }, "/home/u")).toBe(
    "/home/u/.config/neuve",
  );
  expect(authDirectory({ XDG_CONFIG_HOME: "" }, "/home/u")).toBe(
    "/home/u/.config/neuve",
  );
  expect(authDirectory({}, "/home/u")).toBe("/home/u/.config/neuve");
});

test("a first sign-in registers, stores the tokens at mode 0600 and shows no token", async () => {
  const directory = join(scratch, "first", "neuve");
  const seen: Array<URL> = [];
  const result = await signIn({
    directory,
    issuer: issuer.issuer,
    openBrowser: browser("oaiapp_test", seen),
  });
  const authorize = seen[0]!;
  expect(authorize.searchParams.get("client_id")).toBe("dynamic_agent_client");
  expect(authorize.searchParams.get("agent_name_hint")).toBe("Neuve");
  expect(authorize.searchParams.get("ext_agent_host_id")).toMatch(/^urn:uuid:/);
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorize.searchParams.get("resource")).toBe(
    "https://api.openai.com/v1",
  );
  expect(authorize.searchParams.get("scope")).toContain(
    "chatgpt.tokens.use.direct",
  );
  expect(authorize.searchParams.get("redirect_uri")).toMatch(
    /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/,
  );
  // The code exchange used the issued client, the PKCE verifier and the same redirect URI.
  const exchange = issuer.state.tokenForms.at(-1)!;
  expect(exchange["client_id"]).toBe("oaiapp_test");
  expect(exchange["code_verifier"]?.length).toBeGreaterThan(40);
  expect(exchange["redirect_uri"]).toBe(
    authorize.searchParams.get("redirect_uri")!,
  );

  expect(statSync(authFilePath(directory)).mode & 0o777).toBe(0o600);
  expect(statSync(directory).mode & 0o777).toBe(0o700);
  expect(result).toMatchObject({
    signedIn: true,
    email: "owner@example.com",
    planUsage: true,
    clientRegistered: true,
  });
  expect(secrets(JSON.stringify(result))).toEqual([]);
  expect(secrets(JSON.stringify(status({ directory })))).toEqual([]);
  // The file itself holds them; nothing else does.
  expect(secrets(readFileSync(authFilePath(directory), "utf8")).length).toBe(3);

  // A second sign-in reuses the issued client and does not register again.
  const again: Array<URL> = [];
  await signIn({
    directory,
    issuer: issuer.issuer,
    openBrowser: browser("oaiapp_test", again),
  });
  expect(again[0]!.searchParams.get("client_id")).toBe("oaiapp_test");
  expect(again[0]!.searchParams.has("agent_name_hint")).toBe(false);
  expect(again[0]!.searchParams.get("ext_agent_host_id")).toBe(
    authorize.searchParams.get("ext_agent_host_id"),
  );
  // It names the account with the retained ID token, reached only through the start page's
  // redirect, so the hint is never in a URL the CLI prints or hands to the browser opener.
  expect(authorize.searchParams.has("id_token_hint")).toBe(false);
  expect(again[0]!.searchParams.get("id_token_hint")).toMatch(/^eyJ/);
});

test("a sign-in file anyone else can read is refused", async () => {
  const directory = join(scratch, "mode", "neuve");
  await signIn({
    directory,
    issuer: issuer.issuer,
    openBrowser: browser("oaiapp_mode", []),
  });
  chmodSync(authFilePath(directory), 0o644);
  expect(() => readAuth(directory)).toThrow(/mode 0644/);
  await expect(
    accessToken({ directory, issuer: issuer.issuer }),
  ).rejects.toMatchObject({
    code: "file-mode",
  });
});

test("an expiring token is refreshed once for concurrent callers, and the refresh token rotates", async () => {
  const directory = join(scratch, "refresh", "neuve");
  await signIn({
    directory,
    issuer: issuer.issuer,
    openBrowser: browser("oaiapp_refresh", []),
  });
  const newer = JSON.parse(readFileSync(authFilePath(directory), "utf8"));
  newer.futureRoot = true;
  newer.session.futureNested = true;
  writeFileSync(authFilePath(directory), JSON.stringify(newer));
  const before = readAuth(directory)!.session!;
  const refreshes = issuer.state.refreshes;
  // An hour and four minutes later: inside the five-minute margin.
  const later = () => before.expiresAt - 4 * 60_000;
  const tokens = await Promise.all(
    [1, 2, 3, 4].map(() =>
      accessToken({ directory, issuer: issuer.issuer, now: later }),
    ),
  );
  expect(issuer.state.refreshes - refreshes).toBe(1);
  expect(new Set(tokens.map((t) => t.token)).size).toBe(1);
  expect(tokens[0]!.token).not.toBe(before.accessToken);
  const after = readAuth(directory)!.session!;
  expect(after.refreshToken).not.toBe(before.refreshToken);
  expect(
    JSON.parse(readFileSync(authFilePath(directory), "utf8")),
  ).toMatchObject({ futureRoot: true, session: { futureNested: true } });
  const form = issuer.state.tokenForms.findLast(
    (f) => f["grant_type"] === "refresh_token",
  )!;
  expect(form["refresh_token"]).toBe(before.refreshToken);
  expect(form["client_id"]).toBe("oaiapp_refresh");
  expect(form["resource"]).toBe("https://api.openai.com/v1");
  expect(statSync(authFilePath(directory)).mode & 0o777).toBe(0o600);

  // A token with time left is used as stored: no refresh.
  await accessToken({ directory, issuer: issuer.issuer });
  expect(issuer.state.refreshes - refreshes).toBe(1);

  // Concurrent callers recovering from a refusal must renew once even with time left on the token.
  const recovered = await Promise.all(
    [1, 2, 3, 4].map(() =>
      accessToken({ directory, issuer: issuer.issuer }, after.accessToken),
    ),
  );
  expect(issuer.state.refreshes - refreshes).toBe(2);
  expect(new Set(recovered.map((t) => t.token)).size).toBe(1);
  expect(recovered[0]!.token).not.toBe(after.accessToken);
});

test("an unusable refresh token ends the session without leaking it, and keeps the registration", async () => {
  const directory = join(scratch, "unusable", "neuve");
  await signIn({
    directory,
    issuer: issuer.issuer,
    openBrowser: browser("oaiapp_gone", []),
  });
  const before = readAuth(directory)!;
  issuer.state.refreshError = "invalid_grant";
  try {
    const error = await accessToken({
      directory,
      issuer: issuer.issuer,
      now: () => before.session!.expiresAt,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OpenAiAuthError);
    expect((error as OpenAiAuthError).code).toBe("refresh-unusable");
    expect((error as Error).message).toContain("invalid_grant");
    expect(secrets((error as Error).message)).toEqual([]);
  } finally {
    issuer.state.refreshError = undefined;
  }
  const after = readAuth(directory)!;
  expect(after.session).toBeUndefined();
  expect(after.registration?.clientId).toBe("oaiapp_gone");
  expect(after.hostId).toBe(before.hostId);
  await expect(
    accessToken({ directory, issuer: issuer.issuer }),
  ).rejects.toMatchObject({
    code: "signed-out",
  });
});

test("signing out revokes the refresh token and keeps the registration", async () => {
  const directory = join(scratch, "logout", "neuve");
  await signIn({
    directory,
    issuer: issuer.issuer,
    openBrowser: browser("oaiapp_out", []),
  });
  const refresh = readAuth(directory)!.session!.refreshToken!;
  const result = await signOut({ directory, issuer: issuer.issuer });
  expect(result).toEqual({ hadSession: true, revoked: true });
  expect(issuer.state.revoked).toContain(refresh);
  expect(readAuth(directory)!.session).toBeUndefined();
  expect(readAuth(directory)!.registration?.clientId).toBe("oaiapp_out");
  expect(status({ directory }).signedIn).toBe(false);
});

test("a sign-in that returns another account than the registered one is refused", async () => {
  const directory = join(scratch, "mismatch", "neuve");
  await signIn({
    directory,
    issuer: issuer.issuer,
    openBrowser: browser("oaiapp_mm", []),
  });
  issuer.state.subject = "someone-else";
  try {
    await expect(
      signIn({
        directory,
        issuer: issuer.issuer,
        openBrowser: browser("oaiapp_mm", []),
      }),
    ).rejects.toMatchObject({ code: "account-mismatch" });
  } finally {
    issuer.state.subject = "user-123";
  }
  expect(readAuth(directory)!.registration?.subject).toBe("user-123");
});

test("a callback with the wrong state or Host is refused without ending the sign-in", async () => {
  const directory = join(scratch, "callback-checks", "neuve");
  const answers: Array<string> = [];
  const result = await signIn({
    directory,
    issuer: issuer.issuer,
    openBrowser: browser("oaiapp_checks", [], async (callback) => {
      const wrong = new URL(callback);
      wrong.searchParams.set("state", "x".repeat(43));
      answers.push(String((await fetch(wrong)).status));
      answers.push(
        (await rawGet(callback, `localhost:${callback.port}`)).split(
          "\r\n",
        )[0]!,
      );
    }),
  });
  expect(answers[0]).toBe("400");
  expect(answers[1]).toContain("404");
  // The real callback still completed the sign-in.
  expect(result.signedIn).toBe(true);
});

for (const tamper of ["signature", "audience", "nonce"] as const)
  test(`an ID token with a bad ${tamper} fails the sign-in and stores no session`, async () => {
    const directory = join(scratch, `tamper-${tamper}`, "neuve");
    issuer.state.tamper = tamper;
    try {
      await expect(
        signIn({
          directory,
          issuer: issuer.issuer,
          openBrowser: browser(`oaiapp_${tamper}`, []),
        }),
      ).rejects.toMatchObject({ code: "invalid-id-token" });
    } finally {
      issuer.state.tamper = undefined;
    }
    expect(readAuth(directory)?.session).toBeUndefined();
  });

test("a refresh that returns another account keeps the rotated pair and stops using it", async () => {
  const directory = join(scratch, "refresh-mismatch", "neuve");
  await signIn({
    directory,
    issuer: issuer.issuer,
    openBrowser: browser("oaiapp_rmm", []),
  });
  const before = readAuth(directory)!.session!;
  issuer.state.refreshSubject = "someone-else";
  try {
    await expect(
      accessToken({
        directory,
        issuer: issuer.issuer,
        now: () => before.expiresAt,
      }),
    ).rejects.toMatchObject({ code: "account-mismatch" });
  } finally {
    issuer.state.refreshSubject = undefined;
  }
  const after = readAuth(directory)!.session!;
  // The spent refresh token is gone; the new pair is kept, marked, and not used.
  expect(after.refreshToken).not.toBe(before.refreshToken);
  expect(after.identity?.state).toBe("mismatch");
  expect(signedIn({ directory })).toBe(false);
  expect(status({ directory }).identityNotice).toContain("mismatch");
  const refreshes = issuer.state.refreshes;
  await expect(
    accessToken({ directory, issuer: issuer.issuer }),
  ).rejects.toMatchObject({ code: "account-mismatch" });
  expect(issuer.state.refreshes).toBe(refreshes);
});

test("a refresh answer without token_type is still the rotated pair, and is used", async () => {
  const directory = join(scratch, "no-token-type", "neuve");
  await signIn({
    directory,
    issuer: issuer.issuer,
    openBrowser: browser("oaiapp_ntt", []),
  });
  const before = readAuth(directory)!.session!;
  issuer.state.omitTokenType = true;
  try {
    const token = await accessToken({
      directory,
      issuer: issuer.issuer,
      now: () => before.expiresAt,
    });
    const after = readAuth(directory)!.session!;
    expect(token.token).toBe(after.accessToken);
    expect(after.refreshToken).not.toBe(before.refreshToken);
    expect(after.identity).toBeUndefined();
  } finally {
    issuer.state.omitTokenType = false;
  }
});

test("an unusable refresh never wipes a session another process saved meanwhile", async () => {
  const directory = join(scratch, "reread", "neuve");
  await signIn({
    directory,
    issuer: issuer.issuer,
    openBrowser: browser("oaiapp_reread", []),
  });
  const stored = readAuth(directory)!;
  const theirs = {
    ...stored.session!,
    accessToken: "access-secret-theirs",
    refreshToken: "refresh-secret-theirs",
    expiresAt: stored.session!.expiresAt + 3_600_000,
  };
  issuer.state.refreshError = "refresh_token_reused";
  // While this process's refresh is in flight, another one (ignoring a stale lock) saves its own.
  issuer.state.duringRefresh = () =>
    writeAuth(directory, { ...stored, session: theirs });
  try {
    const token = await accessToken({
      directory,
      issuer: issuer.issuer,
      now: () => stored.session!.expiresAt,
    }).catch((error: unknown) => error);
    expect(token).toMatchObject({ token: "access-secret-theirs" });
  } finally {
    issuer.state.refreshError = undefined;
    issuer.state.duringRefresh = undefined;
  }
  expect(readAuth(directory)!.session?.refreshToken).toBe(
    "refresh-secret-theirs",
  );
});

test("the lock breaks only a stale lock, waits for a live one, and frees only its own", async () => {
  const directory = join(scratch, "lock", "neuve");
  await signIn({
    directory,
    issuer: issuer.issuer,
    openBrowser: browser("oaiapp_lock", []),
  });
  const lock = join(directory, "openai-auth.lock");
  // A dead process's lock, a minute and a half old: broken, and the refresh goes ahead.
  writeFileSync(lock, "99999 dead-marker\n");
  const old = new Date(Date.now() - 90_000);
  utimesSync(lock, old, old);
  const before = readAuth(directory)!.session!;
  const token = await accessToken({
    directory,
    issuer: issuer.issuer,
    now: () => before.expiresAt,
  });
  expect(token.token).not.toBe(before.accessToken);
  expect(existsSync(lock)).toBe(false);

  // A live lock is waited for, then given up on, and left in place.
  writeFileSync(lock, "1 live-marker\n");
  await expect(
    withLock(directory, async () => "ran", { waitMs: 300 }),
  ).rejects.toMatchObject({ code: "lock-timeout" });
  expect(readFileSync(lock, "utf8")).toBe("1 live-marker\n");
  rmSync(lock);

  // A lock that another process took over meanwhile is not removed on release.
  await withLock(directory, async () => {
    writeFileSync(lock, "2 other-marker\n");
  });
  expect(readFileSync(lock, "utf8")).toBe("2 other-marker\n");
  rmSync(lock);
});

test("the start page answers once, at an unguessable path", async () => {
  const directory = join(scratch, "start-once", "neuve");
  const answers: Array<number> = [];
  let start = "";
  await signIn({
    directory,
    issuer: issuer.issuer,
    openBrowser: async (link) => {
      start = link;
      await browser("oaiapp_once", [], async () => {
        // The same link again, and the fixed prefix without its secret segment.
        answers.push((await fetch(link, { redirect: "manual" })).status);
        answers.push(
          (await fetch(new URL("/auth/start", link), { redirect: "manual" }))
            .status,
        );
      })(link);
    },
  });
  expect(answers).toEqual([404, 404]);
  expect(start.split("/").at(-1)?.length).toBe(43);
});

test("a code exchange that fails saves no registration, so no planted client ID is kept", async () => {
  const directory = join(scratch, "failed-exchange", "neuve");
  issuer.state.exchangeError = "invalid_grant";
  try {
    await expect(
      signIn({
        directory,
        issuer: issuer.issuer,
        openBrowser: browser("oaiapp_planted", []),
      }),
    ).rejects.toMatchObject({ code: "token-endpoint" });
  } finally {
    issuer.state.exchangeError = undefined;
  }
  const after = readAuth(directory);
  expect(after?.registration).toBeUndefined();
  expect(after?.session).toBeUndefined();
  // The next sign-in registers afresh with the dynamic client.
  const seen: Array<URL> = [];
  await signIn({
    directory,
    issuer: issuer.issuer,
    openBrowser: browser("oaiapp_real", seen),
  });
  expect(seen[0]!.searchParams.get("client_id")).toBe("dynamic_agent_client");
  expect(readAuth(directory)!.registration?.clientId).toBe("oaiapp_real");
});

// Discovery is shared by issuer across independent auth operations, with failure fan-out and retry.
test("concurrent discoveries share fetches, keep issuer keys separate and retry failures", async () => {
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const calls: string[] = [];
  const stopAfterDiscovery = new Error("browser boundary reached");
  let fail = true;
  const fetcher: typeof globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input
            : input.url,
      );
      calls.push(url.origin);
      if (calls.length === 2) started.resolve();
      await gate.promise;
      return Response.json(
        {
          issuer: url.origin,
          authorization_endpoint: `${url.origin}/authorize`,
          token_endpoint: `${url.origin}/token`,
          jwks_uri: `${url.origin}/jwks`,
        },
        { status: fail ? 503 : 200 },
      );
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  const issuerA = `https://discovery-${crypto.randomUUID()}.example.com`;
  const issuerB = `https://discovery-${crypto.randomUUID()}.example.com`;
  const login = (issuer: string, name: string) =>
    signIn({
      directory: join(scratch, name),
      issuer,
      fetch: fetcher,
      openBrowser: () => {
        throw stopAfterDiscovery;
      },
    });
  const a = login(issuerA, "discover-a");
  const b = login(issuerA, "discover-b");
  const c = login(issuerB, "discover-c");
  const outcomes = Promise.allSettled([a, b, c]);
  await started.promise;
  gate.resolve();
  const results = await outcomes;
  expect(calls.sort()).toEqual([issuerA, issuerB].sort());
  expect(results.map((r) => r.status)).toEqual([
    "rejected",
    "rejected",
    "rejected",
  ]);
  if (results[0]?.status === "rejected" && results[1]?.status === "rejected") {
    expect(results[0].reason).toBe(results[1].reason);
    expect(results[0].reason).toBeInstanceOf(OpenAiAuthError);
  }
  fail = false;
  await expect(login(issuerA, "discover-retry")).rejects.toBe(
    stopAfterDiscovery,
  );
  await expect(login(issuerA, "discover-remembered")).rejects.toBe(
    stopAfterDiscovery,
  );
  expect(calls.filter((issuer) => issuer === issuerA)).toHaveLength(2);
}, 60000);

// Reason: only the default sign-in may inherit NEUVE_OPENAI_AUTH_DIR or a token command.
test("authOptionsFor preserves default resolution and isolates added sign-ins", async () => {
  const { authOptionsFor, authDirectory } =
    await import("../src/openai-auth.ts");
  expect(authOptionsFor({ kind: "neuve-sign-in" })).toEqual({});
  expect(
    authOptionsFor({ kind: "neuve-sign-in" }).directory ?? authDirectory(),
  ).toBe(authDirectory());
  expect(
    authOptionsFor({ kind: "neuve-sign-in", folder: "/scratch/added" }),
  ).toEqual({ directory: "/scratch/added", tokenCommand: null });
});

// Never strand a spent credential or block sign-out because an older reader dropped identity keys.
test("refresh saves the rotated pair and keeps newer identity fields, and sign-out removes the whole session", async () => {
  const directory = join(scratch, "identity-newer");
  const now = Date.now();
  const base = {
    version: 1 as const,
    issuer: "http://identity.fixture.invalid",
    hostId: "urn:uuid:00000000-0000-0000-0000-000000000000",
    registration: { clientId: "fixture" },
    session: {
      accessToken: "fixture-old",
      refreshToken: "fixture-refresh-old",
      idToken: "fixture-id",
      expiresAt: now - 1,
      scopes: OPENAI_SCOPES.split(" "),
      refreshIssuedAt: new Date(now).toISOString(),
      identity: { state: "unverified" as const, reason: "fixture" },
    },
  };
  writeAuth(directory, base);
  writeFileSync(
    authFilePath(directory),
    JSON.stringify({
      ...base,
      futureRoot: true,
      registration: { ...base.registration, futureRegistration: true },
      session: {
        ...base.session,
        futureSession: true,
        identity: { ...base.session.identity, future: { keep: true } },
      },
    }),
  );
  let refreshes = 0;
  const fetcher = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration"))
        return Response.json({
          issuer: base.issuer,
          authorization_endpoint: `${base.issuer}/authorize`,
          token_endpoint: `${base.issuer}/token`,
          jwks_uri: `${base.issuer}/jwks`,
        });
      if (url.endsWith("/token")) {
        refreshes++;
        return Response.json({
          access_token: "fixture-rotated",
          refresh_token: "fixture-refresh-rotated",
          expires_in: 3600,
          scope: OPENAI_SCOPES,
        });
      }
      throw new Error("unexpected fixture request");
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  const token = await accessToken({
    directory,
    fetch: fetcher,
    now: () => now,
  });
  expect(refreshes).toBe(1);
  expect(token.token).toBe("fixture-rotated");
  expect(
    JSON.parse(readFileSync(authFilePath(directory), "utf8")),
  ).toMatchObject({
    futureRoot: true,
    session: {
      accessToken: "fixture-rotated",
      refreshToken: "fixture-refresh-rotated",
      futureSession: true,
      identity: { ...base.session.identity, future: { keep: true } },
    },
  });
  let browserOpened = false;
  await expect(
    signIn({
      directory,
      issuer: base.issuer,
      fetch: fetcher,
      openBrowser: () => {
        browserOpened = true;
      },
    }),
  ).rejects.toThrow("cannot preserve newer fields");
  expect(browserOpened).toBe(false);
  expect(refreshes).toBe(1);
  expect(await signOut({ directory, fetch: fetcher })).toEqual({
    hadSession: true,
    revoked: false,
  });
  expect(JSON.parse(readFileSync(authFilePath(directory), "utf8"))).toEqual({
    version: base.version,
    issuer: base.issuer,
    hostId: base.hostId,
    futureRoot: true,
    registration: { ...base.registration, futureRegistration: true },
  });
});
