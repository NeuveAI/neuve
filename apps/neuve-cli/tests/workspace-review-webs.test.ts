import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { announcedChild, closeChild } from "../src/workspace-child.ts";
import { ReviewWebs } from "../src/workspace-review-build.ts";

// Why: opening aliases must share one server, while an exited server must be reopened.
test("canonical aliases open one server and server exit clears its handle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "review-webs-"));
  const alias = `${directory}-alias`;
  const script = join(directory, "serve.ts");
  const base = `/review/${"a".repeat(64)}/`;
  await symlink(directory, alias);
  await writeFile(
    script,
    `const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response("shared")});process.send({kind:"review-ready",url:server.url.origin+${JSON.stringify(base)}});`,
  );
  const webs = new ReviewWebs<Awaited<ReturnType<typeof announcedChild>>>();
  const children: Bun.Subprocess[] = [];
  let starts = 0;
  const start = async (project: string) => {
    starts++;
    const web = await announcedChild({
      command: [process.execPath, "--no-env-file", script],
      cwd: project,
      env: {},
      base,
      log: join(directory, "web.log"),
      signal: new AbortController().signal,
    });
    children.push(web.child);
    return web;
  };
  try {
    const [first, second] = await Promise.all([
      webs.open(directory, start),
      webs.open(alias, start),
    ]);
    expect(first).toBe(second);
    expect(starts).toBe(1);
    expect(await (await fetch(first.url)).text()).toBe("shared");
    expect(await webs.open(alias, start)).toBe(first);
    expect(starts).toBe(1);
    await closeChild(first.child);
    const reopened = await webs.open(alias, start);
    expect(reopened.child.pid).not.toBe(first.child.pid);
    expect(starts).toBe(2);
    expect(await (await fetch(reopened.url)).text()).toBe("shared");
    expect([...webs.values()]).toEqual([]);
  } finally {
    await Promise.all(children.map((child) => closeChild(child)));
    await rm(alias, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);
