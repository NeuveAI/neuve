// Why: 10.129 runs reviews on cloud machines that share one ChatGPT sign-in whose refresh token
// rotates. Each machine must hold no sign-in: it asks one refresher for access tokens through a
// program, and keeps them in memory only. What could go wrong lives at the process boundary, which
// no type checks: a machine that runs the program on every request, keeps a token past its expiry,
// quotes the program's output (a token) in an error, or quietly refreshes a sign-in it was told to
// lease. These tests run real programs in a scratch folder, never the owner's sign-in.
import { afterAll, afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTH_DIRECTORY_VARIABLE,
  LEASE_TEMPORARY_FAILURE,
  OpenAiAuthError,
  TOKEN_COMMAND_VARIABLE,
  accessToken,
  authDirectory,
  rejectedToken,
  signInProblem,
  signedIn,
  withLock,
} from "../src/openai-auth.ts";

const scratch = mkdtempSync(join(tmpdir(), "neuve-openai-lease-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const saved = {
  dir: process.env[AUTH_DIRECTORY_VARIABLE],
  command: process.env[TOKEN_COMMAND_VARIABLE],
};
afterEach(() => {
  for (const [name, value] of [
    [AUTH_DIRECTORY_VARIABLE, saved.dir],
    [TOKEN_COMMAND_VARIABLE, saved.command],
  ] as const)
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
});

let programs = 0;
/** A token command: a shell script that counts its runs in a file, then prints `body` or exits. */
const program = (body: string, exit = 0) => {
  programs += 1;
  const path = join(scratch, `lease-${programs}.sh`);
  const count = `${path}.runs`;
  writeFileSync(
    path,
    `#!/bin/sh\necho run >> '${count}'\nprintf '%s' '${body}'\nexit ${exit}\n`,
  );
  chmodSync(path, 0o755);
  return {
    path,
    runs: () => {
      try {
        return readFileSync(count, "utf8").split("\n").filter(Boolean).length;
      } catch {
        return 0;
      }
    },
  };
};

const lease = (token: string, expiresAt: number) =>
  JSON.stringify({ access_token: token, expires_at: expiresAt });

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OpenAiAuthError) return error;
    throw error;
  }
  throw new Error("expected an OpenAiAuthError");
};

test("NEUVE_OPENAI_AUTH_DIR names the sign-in folder itself, and must be absolute", () => {
  expect(
    authDirectory({ [AUTH_DIRECTORY_VARIABLE]: "/vol/auth/openai" }, "/home/x"),
  ).toBe("/vol/auth/openai");
  expect(
    authDirectory(
      { [AUTH_DIRECTORY_VARIABLE]: "", XDG_CONFIG_HOME: "/xdg" },
      "/home/x",
    ),
  ).toBe("/xdg/neuve");
  expect(() =>
    authDirectory({ [AUTH_DIRECTORY_VARIABLE]: "auth" }, "/home/x"),
  ).toThrow(`${AUTH_DIRECTORY_VARIABLE} must be an absolute path`);
});

test("a lease is kept in memory until five minutes before it expires, and overlapping calls share one run", async () => {
  let now = 1_000_000;
  const command = program(lease("leased-secret-1", now + 60 * 60_000));
  const options = { tokenCommand: command.path, now: () => now };
  const [first, second] = await Promise.all([
    accessToken(options),
    accessToken(options),
  ]);
  expect(first).toEqual({
    token: "leased-secret-1",
    expiresAt: 1_000_000 + 60 * 60_000,
  });
  expect(second).toEqual(first);
  now += 50 * 60_000;
  expect(await accessToken(options)).toEqual(first);
  expect(command.runs()).toBe(1);
  // Under five minutes left: the program runs again (it hands back the same lease here).
  now += 6 * 60_000;
  expect(await accessToken(options)).toEqual(first);
  expect(command.runs()).toBe(2);
});

test("a failing program's exit status says whether to retry, and its output is never quoted", async () => {
  const temporary = program("", LEASE_TEMPORARY_FAILURE);
  const refused = program("leaked-secret-2", 1);
  const garbled = program("not json leaked-secret-3");
  const expired = program(lease("leaked-secret-4", 5));
  const quick = [0, 0, 0];
  const errors = [
    await failure(
      accessToken({ tokenCommand: temporary.path, leaseRetryDelaysMs: quick }),
    ),
    await failure(accessToken({ tokenCommand: refused.path })),
    await failure(accessToken({ tokenCommand: garbled.path })),
    await failure(accessToken({ tokenCommand: expired.path })),
  ];
  expect(errors.map((error) => [error.code, error.transient])).toEqual([
    ["lease", true],
    ["lease", false],
    ["lease", false],
    ["lease", true],
  ]);
  for (const error of errors) expect(error.message).not.toContain("leaked");
  // Exit 75 is tried four times; a failure is not kept, so the next call runs the program again.
  expect(temporary.runs()).toBe(4);
  await failure(
    accessToken({ tokenCommand: temporary.path, leaseRetryDelaysMs: quick }),
  );
  expect(temporary.runs()).toBe(8);
});

/** A token command that exits 75 on its first `busy` runs, then prints `body`. */
const busy = (runs: number, body: string) => {
  programs += 1;
  const path = join(scratch, `busy-${programs}.sh`);
  const count = `${path}.runs`;
  writeFileSync(
    path,
    `#!/bin/sh\necho run >> '${count}'\nif [ "$(wc -l < '${count}')" -le ${runs} ]; then exit ${LEASE_TEMPORARY_FAILURE}; fi\nprintf '%s' '${body}'\n`,
  );
  chmodSync(path, 0o755);
  return {
    path,
    runs: () => readFileSync(count, "utf8").split("\n").filter(Boolean).length,
  };
};

// Why: one refresher serves every machine and every model call, so under load it exits 75 often;
// failing the lease at once ended recomposes and restarted whole review attempts.
test("a busy refresher (exit 75) is asked again after a short wait, and nothing else is retried", async () => {
  const delays = [20, 20, 20];
  const recovers = busy(2, lease("leased-secret-9", Date.now() + 60 * 60_000));
  expect(
    await accessToken({
      tokenCommand: recovers.path,
      leaseRetryDelaysMs: delays,
    }),
  ).toMatchObject({ token: "leased-secret-9" });
  expect(recovers.runs()).toBe(3);

  const stays = busy(99, "");
  const stayed = await failure(
    accessToken({ tokenCommand: stays.path, leaseRetryDelaysMs: delays }),
  );
  expect([stayed.code, stayed.transient]).toEqual(["lease", true]);
  expect(stayed.message).toContain("a temporary failure");
  expect(stays.runs()).toBe(4);

  // A wait that would pass the deadline is not taken: the last exit 75 fails the lease.
  const late = busy(99, "");
  const cut = await failure(
    accessToken({
      tokenCommand: late.path,
      tokenCommandTimeoutMs: 500,
      leaseRetryDelaysMs: [1_000, 1_000, 1_000],
    }),
  );
  expect([cut.code, cut.transient]).toEqual(["lease", true]);
  expect(late.runs()).toBe(1);

  // Why: the review found a wait that fit the deadline could leave the last run a few milliseconds,
  // which then failed as "did not finish within 0 s" instead of reporting the busy refresher.
  // The wait (100 to 300 ms) fits this deadline, but would leave the retry under a second.
  const squeezed = busy(99, "");
  const kept = await failure(
    accessToken({
      tokenCommand: squeezed.path,
      tokenCommandTimeoutMs: 1_000,
      leaseRetryDelaysMs: [200, 200, 200],
    }),
  );
  expect([kept.code, kept.transient]).toEqual(["lease", true]);
  expect(kept.message).toContain("exited with 75 (a temporary failure)");
  expect(kept.message).not.toContain("did not finish");
  expect(squeezed.runs()).toBe(1);

  const refused = program("leaked-secret-10", 1);
  const error = await failure(
    accessToken({ tokenCommand: refused.path, leaseRetryDelaysMs: delays }),
  );
  expect([error.code, error.transient]).toEqual(["lease", false]);
  expect(error.message).not.toContain("leaked");
  expect(refused.runs()).toBe(1);
});

test("a machine told to lease never reads or refreshes a sign-in folder, and both settings at once are refused", async () => {
  const command = program(lease("leased-secret-5", Date.now() + 60 * 60_000));
  process.env[TOKEN_COMMAND_VARIABLE] = command.path;
  expect((await accessToken()).token).toBe("leased-secret-5");
  expect(signedIn()).toBe(true);
  // An explicit folder (the refresher's own call, or a test's) uses the folder, not the program.
  expect(signedIn({ directory: join(scratch, "empty") })).toBe(false);
  expect(
    (
      await failure(
        accessToken({ directory: join(scratch, "empty"), now: Date.now }),
      )
    ).code,
  ).toBe("signed-out");
  process.env[AUTH_DIRECTORY_VARIABLE] = join(scratch, "shared");
  const both = await failure(accessToken());
  expect(both.code).toBe("configuration");
  expect(signedIn()).toBe(false);
  // The route check and the review command show this reason, not a hint to sign in.
  expect(signInProblem()).toContain("not both");
  delete process.env[AUTH_DIRECTORY_VARIABLE];
  process.env[TOKEN_COMMAND_VARIABLE] = "lease.sh";
  expect((await failure(accessToken())).code).toBe("configuration");
  process.env[TOKEN_COMMAND_VARIABLE] = join(scratch, "missing.sh");
  expect(signedIn()).toBe(false);
  expect(command.runs()).toBe(1);
});

/** A token command whose shell starts a child: `body` runs after the child's PID is written to `pids`. */
const parent = (child: string, body: string) => {
  programs += 1;
  const path = join(scratch, `parent-${programs}.sh`);
  const pids = `${path}.pids`;
  writeFileSync(path, `#!/bin/sh\n${child} &\necho $! >> '${pids}'\n${body}\n`);
  chmodSync(path, 0o755);
  return {
    path,
    /** Whether the child ended: polled, since its kill lands a moment after the lease fails. A zombie (killed, not yet reaped by init) has ended. */
    childGone: async () => {
      const pid = readFileSync(pids, "utf8").trim();
      for (let i = 0; i < 100; i++) {
        const state = Bun.spawnSync(["ps", "-o", "stat=", "-p", pid])
          .stdout.toString()
          .trim();
        if (state === "" || state.startsWith("Z")) return true;
        await Bun.sleep(50);
      }
      return false;
    },
  };
};

// Why: the review found the time limit only killed the program itself, so a child that kept its
// output open (a script that runs curl or modal without exec) held a review machine indefinitely.
test("the time limit, the output cap and the program's exit stop the children it started too", async () => {
  // Each child sleeps 140 s, far past this test's 20 s: a lease that waited for one fails by that
  // timeout, so no elapsed time is asserted.
  const stalls = parent("sleep 140", "wait");
  const stalled = await failure(
    accessToken({ tokenCommand: stalls.path, tokenCommandTimeoutMs: 300 }),
  );
  expect([stalled.code, stalled.transient]).toEqual(["lease", true]);
  expect(await stalls.childGone()).toBe(true);

  // The program prints a lease and exits, but leaves a child holding its output.
  const lingers = parent(
    "sleep 140",
    `printf '%s' '${lease("leaked-secret-6", Date.now() + 60 * 60_000)}'`,
  );
  const lingered = await failure(accessToken({ tokenCommand: lingers.path }));
  expect(lingered.message).toContain("left a process holding its output");
  expect(lingered.message).not.toContain("leaked");
  expect(await lingers.childGone()).toBe(true);

  const floods = parent("sleep 140", "yes leaked-secret-7");
  const flooded = await failure(accessToken({ tokenCommand: floods.path }));
  expect([flooded.code, flooded.transient]).toEqual(["lease", false]);
  expect(flooded.message).toContain("more than 64 KiB");
  expect(flooded.message).not.toContain("leaked");
  expect(await floods.childGone()).toBe(true);
}, 20_000);

test("a lease the provider refused is not reused", async () => {
  const command = program(lease("revoked-secret-8", Date.now() + 60 * 60_000));
  const options = { tokenCommand: command.path };
  const { token } = await accessToken(options);
  expect((await accessToken(options)).token).toBe(token);
  expect(command.runs()).toBe(1);
  rejectedToken("some-other-token");
  await Bun.sleep(0);
  await accessToken(options);
  expect(command.runs()).toBe(1);
  rejectedToken(token);
  await Bun.sleep(0);
  await accessToken(options);
  expect(command.runs()).toBe(2);
});

test("a stop ends the wait for a held lock, and never interrupts the work that holds it", async () => {
  const folder = join(scratch, "locked");
  const stop = new AbortController();
  let released!: () => void;
  const holder = withLock(
    folder,
    () => new Promise<void>((done) => (released = done)),
  );
  const waiting = withLock(folder, async () => "ran", { signal: stop.signal });
  await Bun.sleep(200);
  stop.abort();
  const stopped = await failure(waiting);
  expect([stopped.code, stopped.transient]).toEqual(["stopped", true]);
  released();
  await holder;
});
