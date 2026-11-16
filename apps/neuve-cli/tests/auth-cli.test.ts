// Why: 10.85 says the OpenAI token is never printed, and `neuve auth status` shows the account and
// expiry only. The command's output is where a token would leak to a terminal, a pasted transcript
// or an agent's context, and no type check covers what it prints. This writes a sign-in into a
// scratch XDG_CONFIG_HOME (never the owner's) and reads the command's real output.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RouteProvider } from "@neuve/harness";

const config = mkdtempSync(join(tmpdir(), "neuve-auth-cli-"));
afterAll(() => rmSync(config, { recursive: true, force: true }));

const run = (...args: Array<string>) => {
  const result = Bun.spawnSync(
    ["bun", resolve(import.meta.dir, "../src/cli.ts"), ...args],
    { env: { ...process.env, XDG_CONFIG_HOME: config } },
  );
  return {
    code: result.exitCode,
    out: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
};

test("auth status names the account and expiry, never a token", () => {
  RouteProvider.OpenAiAuth.writeAuth(join(config, "neuve"), {
    version: 1,
    issuer: RouteProvider.OpenAiAuth.OPENAI_ISSUER,
    hostId: "urn:uuid:00000000-0000-4000-8000-000000000000",
    registration: {
      clientId: "oaiapp_test",
      subject: "user-1",
      email: "owner@example.com",
    },
    session: {
      accessToken: "access-secret-value",
      refreshToken: "refresh-secret-value",
      idToken: "eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl",
      expiresAt: Date.parse("2026-10-20T12:00:00Z"),
      scopes: ["openid", "chatgpt.tokens.use.direct"],
      refreshIssuedAt: "2026-10-20T11:00:00.000Z",
    },
  });
  const outputs = [
    run("auth", "status", "openai"),
    run("auth", "status", "--json"),
  ];
  for (const { code, out } of outputs) {
    expect(code).toBe(0);
    expect(out).toContain("owner@example.com");
    expect(out).toContain("2026-10-20T12:00:00.000Z");
    expect(out).not.toContain("secret-value");
    expect(out).not.toContain("eyJ");
  }
  expect(outputs[0]!.out).toContain("ChatGPT plan usage: allowed.");
  // Each run starts Bun on the CLI's sources; under a loaded check that takes seconds.
}, 60_000);

test("auth refuses providers it has no sign-in for", () => {
  const { code, out } = run("auth", "login", "anthropic");
  expect(code).toBe(2);
  expect(out).toContain("only openai has a sign-in");
}, 60_000);

// Why: 10.129's cloud machines hold no sign-in; one refresher runs `neuve auth lease openai` and
// hands each machine an access token through a pipe. This checks the lease carries the access token
// and nothing else of the sign-in, and that a machine's token command can be that very command.
test("auth lease prints only the access token and its expiry, and serves a token command", async () => {
  const folder = join(config, "refresher");
  const expiresAt = Date.now() + 60 * 60_000;
  RouteProvider.OpenAiAuth.writeAuth(folder, {
    version: 1,
    issuer: RouteProvider.OpenAiAuth.OPENAI_ISSUER,
    hostId: "urn:uuid:00000000-0000-4000-8000-000000000001",
    registration: { clientId: "oaiapp_test", subject: "user-1" },
    session: {
      accessToken: "access-lease-value",
      refreshToken: "refresh-secret-value",
      idToken: "eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl",
      expiresAt,
      scopes: ["openid", "chatgpt.tokens.use.direct"],
      refreshIssuedAt: new Date().toISOString(),
    },
  });
  const lease = Bun.spawnSync(
    [
      "bun",
      resolve(import.meta.dir, "../src/cli.ts"),
      "auth",
      "lease",
      "openai",
    ],
    {
      env: {
        ...process.env,
        NEUVE_OPENAI_AUTH_DIR: folder,
        // Ignored here: the refresher always reads its own folder.
        NEUVE_OPENAI_TOKEN_COMMAND: "/nonexistent",
      },
    },
  );
  expect(lease.exitCode).toBe(0);
  expect(JSON.parse(lease.stdout.toString())).toEqual({
    access_token: "access-lease-value",
    expires_at: expiresAt,
  });
  expect(lease.stdout.toString()).not.toContain("secret-value");
  expect(lease.stdout.toString()).not.toContain("eyJ");

  const command = join(config, "lease.sh");
  await Bun.write(
    command,
    `#!/bin/sh\nNEUVE_OPENAI_AUTH_DIR='${folder}' exec '${process.execPath}' '${resolve(import.meta.dir, "../src/cli.ts")}' auth lease openai\n`,
  );
  chmodSync(command, 0o755);
  expect(
    await RouteProvider.OpenAiAuth.accessToken({ tokenCommand: command }),
  ).toEqual({ token: "access-lease-value", expiresAt });

  const empty = Bun.spawnSync(
    [
      "bun",
      resolve(import.meta.dir, "../src/cli.ts"),
      "auth",
      "lease",
      "openai",
    ],
    {
      env: {
        ...process.env,
        NEUVE_OPENAI_AUTH_DIR: join(config, "empty"),
      },
    },
  );
  expect(empty.exitCode).toBe(1);
  expect(empty.stdout.toString()).toBe("");
  expect(empty.stderr.toString()).toContain("not signed in to OpenAI");
}, 60_000);

// Why: the cloud refresher stops `neuve auth lease openai` with SIGTERM. A refresh already sent has
// spent the refresh token, so a lease killed before writing back its replacement would sign the
// cloud out. This drives the command against a local fake issuer that holds its answers.
test("a stopped lease writes back a refresh already sent, and sends none after the stop", async () => {
  const hold = { discovery: 0, token: 0 };
  const seen = { discovery: 0, token: 0 };
  const issuer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const origin = url.origin;
      if (url.pathname === "/.well-known/openid-configuration") {
        seen.discovery += 1;
        await Bun.sleep(hold.discovery);
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          jwks_uri: `${origin}/jwks`,
        });
      }
      if (url.pathname === "/token") {
        seen.token += 1;
        await Bun.sleep(hold.token);
        return Response.json({
          access_token: "rotated-access-value",
          refresh_token: "rotated-refresh-value",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "openid chatgpt.tokens.use.direct",
        });
      }
      return new Response(null, { status: 404 });
    },
  });
  try {
    const folder = join(config, "stopped");
    const signIn = () =>
      RouteProvider.OpenAiAuth.writeAuth(folder, {
        version: 1,
        issuer: `http://127.0.0.1:${issuer.port}`,
        hostId: "urn:uuid:00000000-0000-4000-8000-000000000002",
        registration: { clientId: "oaiapp_test", subject: "user-1" },
        session: {
          accessToken: "expiring-access-value",
          refreshToken: "spent-refresh-value",
          idToken: "eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl",
          expiresAt: Date.now(),
          scopes: ["openid", "chatgpt.tokens.use.direct"],
          refreshIssuedAt: new Date().toISOString(),
        },
      });
    const lease = () =>
      Bun.spawn(
        [
          "bun",
          resolve(import.meta.dir, "../src/cli.ts"),
          "auth",
          "lease",
          "openai",
        ],
        {
          env: { ...process.env, NEUVE_OPENAI_AUTH_DIR: folder },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
    const until = async (done: () => boolean) => {
      const started = Date.now();
      while (!done()) {
        if (Date.now() - started > 30_000) throw new Error("timed out");
        await Bun.sleep(20);
      }
    };
    const stored = () => RouteProvider.OpenAiAuth.readAuth(folder)?.session;

    // Stopped while the refresh is in flight: it completes and is written back; nothing is printed.
    signIn();
    hold.token = 1_500;
    const inFlight = lease();
    await until(() => seen.token === 1);
    inFlight.kill("SIGTERM");
    expect(await inFlight.exited).toBe(143);
    expect(await new Response(inFlight.stdout).text()).toBe("");
    expect(stored()?.refreshToken).toBe("rotated-refresh-value");
    expect(stored()?.accessToken).toBe("rotated-access-value");

    // Stopped before the refresh is sent (during discovery): the refresh token is not spent.
    signIn();
    hold.token = 0;
    hold.discovery = 1_500;
    const early = lease();
    await until(() => seen.discovery === 2);
    early.kill("SIGTERM");
    expect(await early.exited).toBe(143);
    expect(await new Response(early.stderr).text()).toContain(
      "stopped before the refresh was sent",
    );
    expect(seen.token).toBe(1);
    expect(stored()?.refreshToken).toBe("spent-refresh-value");
  } finally {
    void issuer.stop(true);
  }
}, 90_000);
