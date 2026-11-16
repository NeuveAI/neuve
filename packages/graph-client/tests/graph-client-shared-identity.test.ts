// Count engine invocations and hash reads at the public inspection boundary.
import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { runGraphInspection, type GraphCommandReceipt } from "../src/index.ts";
import {
  fakeExecutable,
  fixtureRepository,
  removeRoots,
  request,
  waitForFile,
} from "./graph-client-support.ts";

afterEach(removeRoots);

async function engine(mode = "reported-build-identity") {
  const executable = await fakeExecutable(mode);
  const source = await Bun.file(executable).text();
  await Bun.write(
    executable,
    source.replace(
      'if (command === "version") {',
      `
if (command === "version" || command === "capabilities") {
  appendFileSync(controlRoot + "/facts-calls", command + "\\n");
  if (command === "version") {
    writeFileSync(controlRoot + "/facts-started", "started");
    await wait("facts-release");
  }
}
if (command === "version") {`,
    ),
  );
  return { executable, root: dirname(executable) };
}

async function paired(
  mode = "reported-build-identity",
  cancelHolder = false,
  cancelAll = false,
) {
  const repository = await fixtureRepository();
  const { executable, root } = await engine(mode);
  const receipts: GraphCommandReceipt[][] = [[], []];
  const views = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const controllers = [new AbortController(), new AbortController()];
  const inspect = (index: number) =>
    runGraphInspection(
      request(executable, repository.root, repository.first, false),
      {
        reuseIdentity: true,
        signal: controllers[index]!.signal,
        emit: async () => {},
        onCommand: (receipt) => {
          receipts[index]!.push(receipt);
          if (receipt.stage === "worktree_add") views[index]!.resolve();
        },
      },
    );
  const first = inspect(0);
  // Attach rejection handlers before cancellation can reject either inspection.
  const firstResult = Promise.allSettled([first]);
  await waitForFile(join(root, "facts-started"));
  const second = inspect(1);
  const secondResult = Promise.allSettled([second]);
  await views[1]!.promise;
  // Both worktree commands have settled; drain their continuations into the shared run.
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (cancelHolder || cancelAll) controllers[0]!.abort();
  if (cancelAll) controllers[1]!.abort();
  await Bun.write(join(root, "facts-release"), "go");
  const results = [...(await firstResult), ...(await secondResult)];
  const retry = () =>
    runGraphInspection(
      request(executable, repository.root, repository.first, false),
      { reuseIdentity: true, emit: async () => {} },
    );
  return { results, receipts, root, inspect, retry };
}

test("cold inspections share version/capabilities, joiners omit those receipts", async () => {
  const { results, receipts, root, inspect } = await paired();
  expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
  expect(await Bun.file(join(root, "facts-calls")).text()).toBe(
    "version\ncapabilities\n",
  );
  expect(
    receipts[0]!
      .filter((r) => ["version", "capabilities"].includes(r.stage))
      .map((r) => r.stage),
  ).toEqual(["version", "capabilities"]);
  expect(
    receipts[1]!.filter((r) => ["version", "capabilities"].includes(r.stage)),
  ).toEqual([]);
  await inspect(1);
  expect(await Bun.file(join(root, "facts-calls")).text()).toBe(
    "version\ncapabilities\n",
  );
}, 60000);

test.each(["bad-build-identity", "malformed-capabilities"])(
  "provider validation failure %s reaches all callers and is retryable",
  async (mode) => {
    const { results, root, inspect } = await paired(mode);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    if (results[0]?.status === "rejected" && results[1]?.status === "rejected")
      expect(results[0].reason).toBe(results[1].reason);
    await expect(inspect(1)).rejects.toThrow();
    const calls = (await Bun.file(join(root, "facts-calls")).text())
      .trim()
      .split("\n");
    expect(calls.filter((c) => c === "version")).toHaveLength(2);
    expect(calls.filter((c) => c === "capabilities")).toHaveLength(
      mode === "bad-build-identity" ? 0 : 2,
    );
  },
  60000,
);

test("cancelling the holder preserves a live subscriber's provider commands", async () => {
  const { results, root } = await paired("reported-build-identity", true);
  expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled"]);
  expect(await Bun.file(join(root, "facts-calls")).text()).toBe(
    "version\ncapabilities\n",
  );
}, 60000);

test("cancelling every subscriber stops the provider run and permits a later claim", async () => {
  const { results, root, retry } = await paired(
    "reported-build-identity",
    false,
    true,
  );
  expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
  expect(await Bun.file(join(root, "facts-calls")).text()).toBe("version\n");
  await retry();
  expect(await Bun.file(join(root, "facts-calls")).text()).toBe(
    "version\nversion\ncapabilities\n",
  );
}, 60000);

test("concurrent cold inspections hash each configured file identity once", async () => {
  const repository = await fixtureRepository();
  const executable = await fakeExecutable("reported-build-identity");
  const reads = spyOn(fs, "createReadStream");
  try {
    const inspect = () =>
      runGraphInspection(
        request(executable, repository.root, repository.first, false),
        { reuseIdentity: true, emit: async () => {} },
      );
    await Promise.all([inspect(), inspect()]);
    expect(
      reads.mock.calls.filter(([path]) => path === executable),
    ).toHaveLength(1);
    // A changed executable gets a different identity and must be hashed again.
    fs.appendFileSync(executable, "\n// changed identity\n");
    await inspect();
    expect(
      reads.mock.calls.filter(([path]) => path === executable),
    ).toHaveLength(2);
  } finally {
    reads.mockRestore();
  }
}, 60000);

// One held build must not claim another build's version/capabilities request.
test("different executable digests run provider commands independently", async () => {
  const repository = await fixtureRepository();
  const a = await engine();
  const b = await engine();
  let firstSettled = false;
  const inspect = (executable: string) =>
    runGraphInspection(
      request(executable, repository.root, repository.first, false),
      { reuseIdentity: true, emit: async () => {} },
    );
  const first = inspect(a.executable).finally(() => {
    firstSettled = true;
  });
  const firstResult = Promise.allSettled([first]);
  await waitForFile(join(a.root, "facts-started"));
  const second = inspect(b.executable);
  const secondResult = Promise.allSettled([second]);
  await waitForFile(join(b.root, "facts-started"));
  await Bun.write(join(b.root, "facts-release"), "go");
  expect((await secondResult).map((r) => r.status)).toEqual(["fulfilled"]);
  expect(firstSettled).toBe(false);
  await Bun.write(join(a.root, "facts-release"), "go");
  expect((await firstResult).map((r) => r.status)).toEqual(["fulfilled"]);
  for (const { root } of [a, b])
    expect(await Bun.file(join(root, "facts-calls")).text()).toBe(
      "version\ncapabilities\n",
    );
}, 60000);
