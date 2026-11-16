// Owner death and delayed recovery cross process boundaries; filesystem calls stay real.
import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  rmSync,
  mkdirSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileLocked, processAlive, withFileLock } from "../src/file-lock.ts";

const root = mkdtempSync(join(tmpdir(), "file-lock-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const fixture = () => {
  const directory = mkdtempSync(join(root, "case-"));
  return { directory, lock: join(directory, "lock") };
};
const dead = () => {
  expect(processAlive(2147483647)).toBe(false);
  return `2147483647 ${randomUUID()}\n`;
};
const worker = join(import.meta.dir, "fixtures/file-lock-worker.ts");
const within = async <A>(promise: Promise<A>, ms = 3000) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("fixture timed out")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

// Only sibling removal is injected. Publication and the next acquisition use real filesystem calls.
test("post-link sibling cleanup failure cannot strand the canonical lock or block the next caller", async () => {
  const f = fixture();
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      worker,
      "post-link-cleanup-failure",
      f.directory,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  try {
    const output = new Response(child.stdout).text();
    const errors = new Response(child.stderr).text();
    expect(await within(child.exited)).toBe(0);
    expect(await errors).toBe("");
    expect(JSON.parse(await output)).toEqual({ entries: 2, siblings: 1 });
    expect(existsSync(f.lock)).toBe(false);
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
});

for (const role of ["interleaving", "guard-interleaving"]) {
  test(`${role}: delayed recovery never removes a live replacement or overlaps holders`, async () => {
    const f = fixture();
    writeFileSync(f.lock, dead());
    if (role === "guard-interleaving") {
      mkdirSync(`${f.lock}.recovery`);
      writeFileSync(join(`${f.lock}.recovery`, dead().trimEnd()), "");
    }
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", worker, role, f.directory],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      const output = new Response(child.stdout).text();
      const error = new Response(child.stderr).text();
      expect(await within(child.exited, 5000)).toBe(0);
      expect(await error).toBe("");
      if (role === "interleaving") {
        const events: string[] = JSON.parse(await output);
        expect(events.slice(0, 2)).toEqual(["A entered", "A released"]);
        expect(events).toContain("B entered");
        expect(events).toContain("C entered");
      } else expect(JSON.parse(await output)).toEqual({ maximum: 1 });
      expect(readdirSync(f.directory)).toEqual([]);
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
  }, 10000);
}

test("a recoverer killed while holding the guard leaves a recoverable guard", async () => {
  const f = fixture();
  writeFileSync(f.lock, dead());
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", worker, "die-with-guard", f.directory],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  try {
    const reader = child.stdout.getReader();
    const ready = await within(reader.read());
    reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toBe("guard held\n");
    expect(readFileSync(f.lock, "utf8")).toMatch(/^2147483647 /);
    child.kill("SIGKILL");
    await child.exited;
    let entered = 0;
    await withFileLock(
      f.lock,
      async () => {
        entered++;
      },
      1500,
    );
    expect(entered).toBe(1);
    expect(readdirSync(f.directory)).toEqual([]);
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
});

test("separate processes serialize repeated dead-lock and dead-guard recovery without losing counter updates", async () => {
  const f = fixture();
  writeFileSync(join(f.directory, "counter"), "0");
  const children = [];
  const replies: string[] = [];
  let notify = () => {};
  try {
    for (let i = 0; i < 3; i++) {
      let ready = () => {};
      const prepared = new Promise<void>((done) => {
        ready = done;
      });
      const child = Bun.spawn(
        [process.execPath, "--no-env-file", worker, "stress", f.directory],
        {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "inherit",
          ipc(message) {
            if (message === "ready") ready();
            else {
              replies.push(String(message));
              if (replies.length === 3) notify();
            }
          },
        },
      );
      children.push(child);
      await within(prepared);
    }
    for (let round = 0; round < 12; round++) {
      writeFileSync(f.lock, dead());
      const guard = `${f.lock}.recovery`;
      mkdirSync(guard);
      writeFileSync(join(guard, dead().trimEnd()), "");
      replies.length = 0;
      const completed = new Promise<void>((done) => {
        notify = done;
      });
      for (const child of children) child.send("go");
      await within(completed, 2000);
      expect(replies).toEqual(["ok", "ok", "ok"]);
      expect(existsSync(f.lock)).toBe(false);
      expect(existsSync(guard)).toBe(false);
    }
    expect(readFileSync(join(f.directory, "counter"), "utf8")).toBe("36");
    expect(readdirSync(f.directory)).toEqual(["counter"]);
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
  }
}, 35000);

test("a live holder excludes contenders until timeout, including a live recovery guard", async () => {
  const f = fixture();
  await withFileLock(f.lock, async () => {
    const bytes = readFileSync(f.lock, "utf8");
    expect(bytes).toMatch(new RegExp(`^${process.pid} [0-9a-f-]{36}\\n$`));
    await expect(
      withFileLock(
        f.lock,
        async () => {
          throw new Error("overlap");
        },
        20,
      ),
    ).rejects.toBeInstanceOf(FileLocked);
    expect(readFileSync(f.lock, "utf8")).toBe(bytes);
  });
  writeFileSync(f.lock, dead());
  mkdirSync(`${f.lock}.recovery`);
  const name = `${process.pid} ${randomUUID()}`;
  writeFileSync(join(`${f.lock}.recovery`, name), "");
  await expect(
    withFileLock(
      f.lock,
      async () => {
        throw new Error("overlap");
      },
      20,
    ),
  ).rejects.toBeInstanceOf(FileLocked);
  expect(readdirSync(`${f.lock}.recovery`)).toEqual([name]);
});

test("failure releases the lock, cancellation stays effective, and release preserves another marker", async () => {
  const f = fixture();
  await expect(
    withFileLock(f.lock, async () => {
      throw new Error("failure");
    }),
  ).rejects.toThrow("failure");
  expect(existsSync(f.lock)).toBe(false);
  const aborted = AbortSignal.abort(new Error("cancelled"));
  await expect(
    withFileLock(f.lock, async () => {}, 100, aborted),
  ).rejects.toThrow("cancelled");
  expect(existsSync(f.lock)).toBe(false);
  await withFileLock(f.lock, async () => {
    const controller = new AbortController();
    const waiting = withFileLock(
      f.lock,
      async () => {
        throw new Error("overlap");
      },
      500,
      controller.signal,
    );
    controller.abort(new Error("cancelled while waiting"));
    await expect(waiting).rejects.toThrow("cancelled while waiting");
  });
  const replacement = `${process.pid} ${randomUUID()}\n`;
  await expect(
    withFileLock(f.lock, async () => {
      writeFileSync(f.lock, replacement);
    }),
  ).rejects.toThrow("ownership was lost");
  expect(readFileSync(f.lock, "utf8")).toBe(replacement);
});

// A suspended legacy writer can hold a PID-less publication gap for any duration.
for (const text of ["", "unparseable partial marker"]) {
  test(`aged ${text === "" ? "empty" : "partial"} legacy marker refuses with removal advice and never enters work`, async () => {
    const f = fixture();
    writeFileSync(f.lock, text);
    const age = new Date("2000-01-01T00:00:00Z");
    utimesSync(f.lock, age, age);
    let entered = false;
    const failure = await withFileLock(
      f.lock,
      async () => {
        entered = true;
      },
      30,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(FileLocked);
    if (!(failure instanceof FileLocked))
      throw new Error("missing lock refusal");
    expect(failure.owner).toBe(0);
    expect(failure.message).toContain(f.lock);
    expect(failure.message).toContain("no recorded owner");
    expect(failure.message).toContain(
      "most likely left by an older Neuve build",
    );
    expect(failure.message).toContain(
      "safe to remove once no older Neuve is running",
    );
    expect(entered).toBe(false);
    expect(readFileSync(f.lock, "utf8")).toBe(text);
    expect(readdirSync(f.directory)).toEqual(["lock"]);
  });
}

test("a caller waiting on an ownerless legacy lock acquires after its file goes away", async () => {
  const f = fixture();
  writeFileSync(f.lock, "");
  let entered = false;
  const waiting = withFileLock(
    f.lock,
    async () => {
      entered = true;
    },
    1000,
  );
  try {
    await Bun.sleep(40);
    expect(entered).toBe(false);
    rmSync(f.lock);
    await waiting;
    expect(entered).toBe(true);
    expect(readdirSync(f.directory)).toEqual([]);
  } finally {
    rmSync(f.lock, { force: true });
    await waiting;
  }
});

test("a recent empty legacy publication gap and an aged partial live PID are never displaced", async () => {
  for (const text of ["", `${process.pid} partial`]) {
    const f = fixture();
    writeFileSync(f.lock, text);
    if (text !== "") {
      const age = new Date("2000-01-01T00:00:00Z");
      utimesSync(f.lock, age, age);
    }
    await expect(
      withFileLock(
        f.lock,
        async () => {
          throw new Error("overlap");
        },
        30,
      ),
    ).rejects.toBeInstanceOf(FileLocked);
    expect(readFileSync(f.lock, "utf8")).toBe(text);
  }
});

for (const point of ["empty-sibling", "before-link", "after-link"]) {
  test(`a writer killed at ${point} leaves no partial canonical lock and cannot block the next caller`, async () => {
    const f = fixture();
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", worker, point, f.directory],
      { stdin: "ignore", stdout: "pipe", stderr: "inherit" },
    );
    try {
      const reader = child.stdout.getReader();
      const ready = await within(reader.read());
      reader.releaseLock();
      expect(new TextDecoder().decode(ready.value)).toBe(
        "publication paused\n",
      );
      if (point === "after-link")
        expect(readFileSync(f.lock, "utf8")).toMatch(
          new RegExp(`^${child.pid} [0-9a-f-]{36}\\n$`),
        );
      else expect(existsSync(f.lock)).toBe(false);
      child.kill("SIGKILL");
      await child.exited;
      const leftovers = readdirSync(f.directory).filter((name) =>
        name.includes(".marker-"),
      );
      expect(leftovers).toHaveLength(1);
      let entered = false;
      await withFileLock(
        f.lock,
        async () => {
          entered = true;
        },
        1500,
      );
      expect(entered).toBe(true);
      expect(existsSync(f.lock)).toBe(false);
      expect(readdirSync(f.directory)).toEqual(leftovers);
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
  });
}

test("dead-owner recovery rechecks inode even when a replacement has identical contents and age", async () => {
  const f = fixture();
  writeFileSync(f.lock, dead());
  const age = new Date("2000-01-01T00:00:00Z");
  utimesSync(f.lock, age, age);
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      worker,
      "dead-owner-replaced",
      f.directory,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  try {
    const output = new Response(child.stdout).text();
    const errors = new Response(child.stderr).text();
    expect(await within(child.exited)).toBe(0);
    expect(await errors).toBe("");
    expect(JSON.parse(await output)).toEqual({ guards: 2 });
    expect(readdirSync(f.directory)).toEqual([]);
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
});

for (const code of ["EPERM", "ENOTSUP", "EXDEV"]) {
  test(`link failure ${code} cleans the sibling and refuses without entering work or creating the canonical lock`, async () => {
    const f = fixture();
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        worker,
        `link-failure-${code}`,
        f.directory,
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
    );
    try {
      const errors = new Response(child.stderr).text();
      expect(await within(child.exited)).toBe(0);
      expect(await errors).toBe("");
      expect(readdirSync(f.directory)).toEqual([]);
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
  });
}

for (const scenario of [
  "release-read",
  "release-read-work",
  "release-read-stat",
  "release-read-unlink",
  "release-read-foreign",
  "foreign",
  "sibling-success",
  "sibling-work",
  "sibling-cancel",
  "publish-two",
  "guard-two",
  "probe",
  "acquire-read",
  "deadline",
]) {
  test(`operational lock failure ${scenario} retains errors and permits only confirmed cleanup`, async () => {
    const f = fixture();
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "fixtures/file-lock-errors.ts"),
        scenario,
        f.directory,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    try {
      const output = new Response(child.stdout).text();
      const errors = new Response(child.stderr).text();
      const exit = await within(child.exited);
      expect(await errors).toBe("");
      expect(exit).toBe(0);
      const result = JSON.parse(await output);
      if (!["sibling-success"].includes(scenario))
        expect(result.errors).toBeGreaterThan(0);
      if (scenario === "publish-two") expect(result.errors).toBe(2);
      expect(result.injections).toBeGreaterThanOrEqual(
        scenario === "foreign" ? 0 : 1,
      );
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
  });
}
