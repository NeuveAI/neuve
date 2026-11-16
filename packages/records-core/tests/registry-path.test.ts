import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";

for (const platform of ["linux", "darwin"]) {
  for (const value of [undefined, "", "relative", "/absolute"]) {
    test(`${platform}: registry and budget paths with XDG_STATE_HOME=${JSON.stringify(value)}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "registry-path-"));
      const home = join(root, "home");
      const cwd = join(root, "cwd");
      const absolute = join(root, "state");
      mkdirSync(cwd);
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          `--config=${devNull}`,
          "-e",
          `
          Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });
          const { registryPath, registerRepository, readRegistry } = await import(${JSON.stringify(new URL("../src/registry.ts", import.meta.url).href)});
          const { budgetDirectory } = await import(${JSON.stringify(new URL("../src/budget-directory.ts", import.meta.url).href)});
          const { storeLocationIn } = await import(${JSON.stringify(new URL("../src/location.ts", import.meta.url).href)});
          const { Effect } = await import(${JSON.stringify(import.meta.resolve("effect"))});
          const fs = await import(${JSON.stringify(import.meta.resolve("@effect/platform-bun/BunFileSystem"))});
          const { readdirSync } = await import("node:fs");
          delete process.env.NEUVE_TEST_PROCESS;
          delete process.env.NEUVE_BUDGET_DIRECTORY;
          const run = (effect) => Effect.runPromise(effect.pipe(Effect.provide(fs.layer)));
          const added = await run(registerRepository(storeLocationIn(${JSON.stringify(join(root, "git"))}), "repository"));
          console.log(JSON.stringify({ path: registryPath(), budget: budgetDirectory(), added, registry: await run(readRegistry()), cwd: readdirSync(process.cwd()) }));
        `,
        ],
        {
          cwd,
          env: {
            ...process.env,
            HOME: home,
            XDG_STATE_HOME: value === "/absolute" ? absolute : value,
            BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(root, "transpiler"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      try {
        const [code, out, err] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect({ code, err }).toEqual({ code: 0, err: "" });
        const base =
          platform === "darwin"
            ? join(home, "Library", "Application Support", "Neuve")
            : join(
                value === "/absolute"
                  ? absolute
                  : join(home, ".local", "state"),
                "neuve",
              );
        expect(JSON.parse(out)).toEqual({
          path: join(base, "repositories.json"),
          budget: join(base, "budget"),
          added: true,
          registry: {
            version: 1,
            repositories: [
              { store: join(root, "git", "neuve"), repository: "repository" },
            ],
          },
          cwd: [],
        });
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
