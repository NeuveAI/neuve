import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { z } from "zod";
import { Account, AccountName } from "../../src/index.ts";
import { AccountStore, folderOf, recordFile, scratch } from "./fixtures.ts";

const Outcome = z.discriminatedUnion("_tag", [
  z.object({ _tag: z.literal("Success"), success: Account }),
  z.object({
    _tag: z.literal("Failure"),
    failure: z.object({
      _tag: z.literal("AccountStoreError"),
      message: z.string(),
    }),
  }),
]);

function race(home: string) {
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const successful: z.infer<typeof Account>[] = [];
  function verifyAccount(account: z.infer<typeof Account>) {
    expect(existsSync(folderOf(account))).toBe(true);
    expect(
      readdirSync(AccountStore.claimPath(home, account.name)),
    ).toHaveLength(1);
    const path = recordFile(home, account.name);
    expect(path).toEndWith(".active.json");
    expect(JSON.parse(readFileSync(path, "utf8")).account).toEqual(account);
  }
  return {
    spawn(mode: "adder" | "sweeper", schedule: string, name = "other") {
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          join(import.meta.dir, "sweep-publisher-child.ts"),
          home,
          mode,
          schedule,
          name,
        ],
        { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
      );
      children.push(child);
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      const line = () =>
        Effect.runPromise(
          Effect.promise(async () => {
            for (;;) {
              const end = pending.indexOf("\n");
              if (end >= 0) {
                const value = pending.slice(0, end);
                pending = pending.slice(end + 1);
                return value;
              }
              const value = await reader.read();
              if (value.done)
                throw new Error("child exited before the expected barrier");
              pending += decoder.decode(value.value, { stream: true });
            }
          }).pipe(Effect.timeout("3 seconds")),
        );
      return {
        line,
        release: () => child.stdin.write("x"),
        async outcome() {
          const result = Outcome.parse(JSON.parse(await line()));
          expect(
            await Effect.runPromise(
              Effect.promise(() => child.exited).pipe(
                Effect.timeout("3 seconds"),
              ),
            ),
          ).toBe(0);
          if (result._tag === "Success") {
            successful.push(result.success);
            verifyAccount(result.success);
          }
          return result;
        },
      };
    },
    verify: () => successful.forEach(verifyAccount),
    async close() {
      for (const child of children) {
        if (child.exitCode === null) child.kill();
        await child.exited;
      }
    },
  };
}

// Reason: F4, once a publisher wins the atomic rename, the sweep cannot traverse its live claim.
test("publication wins while a sweep is paused at taking its temporary claim", async () => {
  const { home, close } = scratch();
  const children = race(home);
  try {
    const adder = children.spawn("adder", "publisher-wins");
    expect(await adder.line()).toBe("publishing:1");
    const sweeper = children.spawn("sweeper", "publisher-wins");
    expect(await sweeper.line()).toBe("taking");
    adder.release();
    expect(await adder.line()).toBe("published");
    sweeper.release();
    expect((await sweeper.outcome())._tag).toBe("Success");
    adder.release();
    expect((await adder.outcome())._tag).toBe("Success");
    children.verify();
  } finally {
    await children.close();
    close();
  }
});

// Reason: F4, recursive removal may hold only a tombstone, including deletion just before publication.
for (const schedule of ["held", "deleted"]) {
  test(`add survives a sweep with its temporary claim ${schedule} before publication`, async () => {
    const { home, close } = scratch();
    const children = race(home);
    try {
      const adder = children.spawn("adder", schedule);
      expect(await adder.line()).toBe("publishing:1");
      const sweeper = children.spawn("sweeper", schedule);
      if (schedule === "held") expect(await sweeper.line()).toBe("taken");
      else {
        expect(await sweeper.line()).toBe("deleting-tombstone");
        expect((await sweeper.outcome())._tag).toBe("Success");
      }
      adder.release();
      expect(await adder.line()).toBe("publishing:2");
      adder.release();
      expect(await adder.line()).toBe("published");
      if (schedule === "held") {
        sweeper.release();
        expect(await sweeper.line()).toBe("deleting-tombstone");
        expect((await sweeper.outcome())._tag).toBe("Success");
      }
      adder.release();
      expect((await adder.outcome())._tag).toBe("Success");
      expect(readdirSync(AccountStore.accountsPath(home)).sort()).toEqual([
        "other",
        "work",
      ]);
      children.verify();
    } finally {
      await children.close();
      close();
    }
  });
}

// Reason: F4, losing either the writing claim or the completed claim twice must fail with no live account.
for (const schedule of ["publishing", "writing"]) {
  for (const losses of schedule === "publishing" ? [2] : [1, 2]) {
    test(`add loses its claim during ${schedule} ${losses} time(s) and recovers or refuses`, async () => {
      const { home, close } = scratch();
      const children = race(home);
      try {
        const adder = children.spawn("adder", schedule);
        for (let attempt = 1; attempt <= losses; attempt++) {
          expect(await adder.line()).toBe(`${schedule}:${attempt}`);
          const sweeper = children.spawn(
            "sweeper",
            "deleted",
            `other${attempt}`,
          );
          expect(await sweeper.line()).toBe("deleting-tombstone");
          expect((await sweeper.outcome())._tag).toBe("Success");
          adder.release();
        }
        if (losses === 1) {
          expect(await adder.line()).toBe(`${schedule}:2`);
          adder.release();
          expect(await adder.line()).toBe("published");
          adder.release();
          expect((await adder.outcome())._tag).toBe("Success");
        } else {
          expect(await adder.outcome()).toEqual({
            _tag: "Failure",
            failure: {
              _tag: "AccountStoreError",
              message:
                "Another Neuve process was tidying the account files. Add the account again.",
            },
          });
          expect(
            existsSync(AccountStore.claimPath(home, AccountName.parse("work"))),
          ).toBe(false);
          expect(
            readdirSync(
              join(AccountStore.neuveFolder(home), "accounts", "claude"),
            ),
          ).toHaveLength(2);
        }
        expect(
          readdirSync(AccountStore.accountsPath(home)).some((file) =>
            file.startsWith("."),
          ),
        ).toBe(false);
        children.verify();
      } finally {
        await children.close();
        close();
      }
    });
  }
}
