import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { prepareGraphSnapshot } from "../src/index.ts";
import {
  fakeExecutable,
  fixtureRepository,
  removeRoots,
} from "./graph-client-support.ts";

afterEach(removeRoots);

// Why: a preparation failure must retain Graph's last diagnostic instead of only an exit code.
test.each([false, true])(
  "failed Graph command retains a bounded last stderr line (long=%s)",
  async (long) => {
    const repo = await fixtureRepository();
    const executable = await fakeExecutable("prepared-service-answered");
    const diagnostic = long
      ? "x".repeat(4000) + " final diagnostic"
      : "final diagnostic";
    writeFileSync(
      executable,
      readFileSync(executable, "utf8").replace(
        "const command = process.argv[2];",
        `const command = process.argv[2]; if(command === "version") { console.error("earlier diagnostic"); console.error(${JSON.stringify(diagnostic)}); process.exit(23); }`,
      ),
    );
    const failure = await Effect.runPromise(
      prepareGraphSnapshot(
        { repository: repo.root, revision: repo.second, executable },
        { cacheDirectory: join(dirname(executable), "cache") },
      ),
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw failure;
    expect(failure.cause).toBeInstanceOf(Error);
    if (!(failure.cause instanceof Error)) throw failure;
    expect(failure.cause.message).toStartWith("Graph version exited with 23.");
    expect(failure.cause.message).toEndWith("final diagnostic");
    expect(failure.cause.message).not.toContain("earlier diagnostic");
    expect(failure.cause.message.length).toBeLessThanOrEqual(1100);
  },
);
