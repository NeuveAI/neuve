// Why: Bun 1.4.0 hung workspace startup here; only the runtime version prevents it, so a Bun or Vite change can bring it back.
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

test("Vite serves while a readiness client polls during its port probe", async () => {
  const root = await mkdtemp(join(tmpdir(), "vite-port-probe-"));
  let child: Bun.Subprocess | undefined;
  let polling: Promise<void> | undefined;
  const controller = new AbortController();
  const requests = new Set<Promise<void>>();
  try {
    const probe = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });
    const port = probe.port;
    probe.stop(true);
    await writeFile(
      join(root, "index.html"),
      "<title>Vite probe ready</title>",
    );
    await writeFile(
      join(root, "vite.config.mjs"),
      "export default { server: { hmr: false, ws: false } };\n",
    );
    const web = resolve(import.meta.dir, "../apps/neuve-web/apps/web");
    const vite = join(
      dirname(Bun.resolveSync("vite/package.json", web)),
      "bin/vite.js",
    );
    let served = false;
    // Ends a hang only: a slow start under load is not one.
    const deadline = performance.now() + 30000;
    polling = (async () => {
      while (
        !controller.signal.aborted &&
        !served &&
        performance.now() < deadline
      ) {
        const request = fetch(`http://127.0.0.1:${port}/`, {
          signal: controller.signal,
        })
          .then(async (response) => {
            if (
              response.ok &&
              (await response.text()).includes("Vite probe ready")
            )
              served = true;
          })
          .catch(() => {})
          .finally(() => requests.delete(request));
        requests.add(request);
        await Bun.sleep(1);
      }
    })();
    child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        vite,
        root,
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--strictPort",
        "--config",
        join(root, "vite.config.mjs"),
      ],
      {
        cwd: root,
        stdin: "ignore",
        stdout: Bun.file(join(root, "vite.log")),
        stderr: Bun.file(join(root, "vite.err.log")),
      },
    );
    await polling;
    expect(served, await Bun.file(join(root, "vite.err.log")).text()).toBe(
      true,
    );
  } finally {
    controller.abort();
    await polling;
    await Promise.all(requests);
    child?.kill("SIGKILL");
    await child?.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 45000);
