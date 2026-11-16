// The real BFF must compile its server-function URLs under the same prefix as pages.
// A disposable repository and home keep this proof away from personal Records and settings.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  reviewBase,
  serveCodingUi,
  type CodingUi,
} from "@ace/host/app-gateway";

// Why: the production build and gateway must preserve routing, commands, security and streaming.
const source = resolve(import.meta.dir, "../../..");
const webRoot = join(source, "apps/neuve-web/apps/web");
import { buildReviewWeb } from "../src/workspace-review-build.ts";
import { announcedChild, closeChild } from "../src/workspace-child.ts";
import { hostBudget } from "../../../packages/harness/src/budget/local.ts";

for (const mode of ["hosted", "floor"]) {
  describe(mode, () => {
    let directory: string;
    const lifetime = new AbortController();
    let budget: string;
    let host: Awaited<ReturnType<typeof hostBudget>>;
    const launchers = new Set<Bun.Subprocess>();
    let base: string;
    let app: CodingUi | undefined;
    let child: Bun.Subprocess | undefined;
    let upstream: string;
    let command: string;
    let readCommand: string;
    let assets: string[];

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "review-route-live-"));
      budget = await mkdtemp("/tmp/n123-route-");
      host = await hostBudget({ directory: budget, threads: 2, fixed: 4 });
      if (!host) throw new Error("Missing route test host");
      await host.claims.ready;
      const repository = join(directory, "repository");
      const home = join(directory, "home");
      await Promise.all([
        mkdir(repository),
        mkdir(home),
        writeFile(join(directory, "index.html"), "<title>Coding home</title>"),
      ]);
      const environment = {
        PATH: process.env.PATH ?? "",
        // Native compilers can see the host CPU count beyond the sandbox quota.
        ROLLDOWN_WORKER_THREADS: process.env.ROLLDOWN_WORKER_THREADS ?? "4",
        RAYON_NUM_THREADS: process.env.RAYON_NUM_THREADS ?? "4",
        HOME: home,
        TMPDIR: directory,
        XDG_CONFIG_HOME: home,
        NEUVE_REPOSITORY: repository,
        NEUVE_BUDGET_DIRECTORY: budget,
        TSR_TMP_DIR: join(directory, "router"),
      };
      const initialized = Bun.spawnSync(["git", "init", "-q", repository], {
        env: environment,
      });
      if (initialized.exitCode) throw new Error(initialized.stderr.toString());
      base = reviewBase(repository);
      const buildOptions = {
        source,
        base,
        builds: join(directory, "builds"),
        cache: join(directory, "cache"),
        temporary: join(directory, "tmp"),
        executable: process.execPath,
        environment,
        log: join(directory, "build.log"),
        signal: new AbortController().signal,
      };
      // Two independent launchers must also share a build, across their process boundary.
      const buildScript = join(directory, "build.ts");
      await writeFile(
        buildScript,
        `import {buildReviewWeb} from ${JSON.stringify(join(source, "apps/neuve-cli/src/workspace-review-build.ts"))}; console.log(await buildReviewWeb({...JSON.parse(process.env.BUILD_OPTIONS),signal:new AbortController().signal}));`,
      );
      const runBuild = async () => {
        const process = Bun.spawn(
          [buildOptions.executable, "--no-env-file", buildScript],
          {
            // A launcher invoked by a Git hook must hash the source checkout, not the caller's index.
            env: {
              ...environment,
              GIT_DIR: join(directory, "foreign.git"),
              BUILD_OPTIONS: JSON.stringify(buildOptions),
            },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        launchers.add(process);
        try {
          const [output, error, code] = await Promise.all([
            new Response(process.stdout).text(),
            new Response(process.stderr).text(),
            process.exited,
          ]);
          if (code !== 0) throw new Error(error);
          return output.trim();
        } finally {
          await closeChild(process);
          launchers.delete(process);
        }
      };
      const [built, concurrent] = await Promise.all([runBuild(), runBuild()]);
      expect(concurrent).toBe(built);
      const completed = await stat(join(built, "../complete"));
      const buildLog = await Bun.file(buildOptions.log).text();
      expect(buildLog.match(/building client environment/g)).toHaveLength(1);
      // A fresh launcher and concurrent in-process opens must find the published build unchanged.
      expect(await runBuild()).toBe(built);
      expect(await Promise.all([runBuild(), runBuild()])).toEqual([
        built,
        built,
      ]);
      expect(
        await Promise.all([
          buildReviewWeb(buildOptions),
          buildReviewWeb(buildOptions),
        ]),
      ).toEqual([built, built]);
      expect((await stat(join(built, "../complete"))).mtimeMs).toBe(
        completed.mtimeMs,
      );
      const reopenedLog = await Bun.file(buildOptions.log).text();
      expect(reopenedLog.match(/building client environment/g)).toHaveLength(1);
      expect(reopenedLog.startsWith(buildLog)).toBe(true);
      expect(
        reopenedLog
          .slice(buildLog.length)
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual(
        Array.from({ length: 5 }, () =>
          expect.objectContaining({
            type: "review-build.shared-work",
            role: "waiter",
          }),
        ),
      );
      // Why: relocated output must still resolve the real app's external workspace dependencies.
      const serving =
        mode === "floor"
          ? await buildReviewWeb({
              ...buildOptions,
              lifetime: lifetime.signal,
              environment: {
                ...environment,
                NEUVE_BUDGET_DIRECTORY: join(budget, "absent"),
              },
            })
          : built;
      if (mode === "floor") {
        expect(serving).toContain("workspace-web-v5/floor/launcher-");
        expect(await realpath(resolve(serving, "../node_modules"))).toBe(
          await realpath(join(webRoot, "node_modules")),
        );
        expect(await Bun.file(buildOptions.log).text()).toContain(
          '"floorOutput":"linked"',
        );
      }
      const started = await announcedChild({
        command: [
          process.execPath,
          "--no-env-file",
          join(webRoot, "serve.ts"),
          serving,
        ],
        cwd: webRoot,
        env: {
          ...environment,
          NODE_ENV: "production",
          NEUVE_REVIEW_BASE: base,
        },
        base,
        log: join(directory, "server.log"),
        signal: buildOptions.signal,
      });
      child = started.child;
      upstream = new URL(started.url).origin;
      // Start's manifest retains the exported names while client chunks are minified.
      const serverFiles = await readdir(join(serving, "server/assets"));
      const manifest = (
        await Promise.all(
          serverFiles
            .filter((name) => name.endsWith(".js"))
            .map((name) =>
              Bun.file(join(serving, "server/assets", name)).text(),
            ),
        )
      ).join("\n");
      app = await serveCodingUi({
        directory,
        port: 0,
        host: { url: "ws://127.0.0.1:12345/ws", token: "a".repeat(64) },
        review: async (key) =>
          base === `/review/${key}/` ? upstream + base : undefined,
      });
      const id = /id: "([a-f0-9]+)",\s*name: "sendDecision"/.exec(
        manifest,
      )?.[1];
      const readId = /id: "([a-f0-9]+)",\s*name: "loadReviewCycle"/.exec(
        manifest,
      )?.[1];
      if (!id || !readId)
        throw new Error(
          `No production server-function IDs. Inspect ${directory}`,
        );
      command = new URL(`${base}_serverFn/${id}`, app.url).href;
      readCommand = new URL(`${base}_serverFn/${readId}`, app.url).href;
      assets = await readdir(join(serving, "client/assets"));
    }, 150_000);

    afterAll(async () => {
      await app?.close();
      if (child) await closeChild(child);
      lifetime.abort();
      await Promise.all([...launchers].map((launcher) => closeChild(launcher)));
      await host?.close();
      if (budget) await rm(budget, { recursive: true, force: true });
      if (directory) await rm(directory, { recursive: true, force: true });
    }, 30_000);

    test("real review health and client modules use the coding origin's project prefix", async () => {
      if (!app) throw new Error("No coding listener");
      expect(
        await (await fetch(new URL(base + "api/health", app.url))).json(),
      ).toEqual({ status: "ready" });
      expect((await fetch(upstream + base + "api/health")).status).toBe(200);
      expect(new URL(command).origin).toBe(new URL(app.url).origin);
    }, 30_000);

    test("the built page and its scripts, styles, fonts and favicon load under the project base", async () => {
      if (!app) throw new Error("No coding listener");
      const page = await fetch(new URL(base + "mock", app.url));
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toContain(
        "frame-ancestors 'self'",
      );
      expect(page.headers.get("x-frame-options")).toBe("SAMEORIGIN");
      const html = await page.text();
      expect(html).toContain(`${base}assets/`);
      expect(html).not.toContain("/@vite/client");
      const referenced = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
        .map((match) => match[1])
        .filter(
          (path): path is string =>
            path !== undefined && path.startsWith(`${base}assets/`),
        );
      expect(referenced.length).toBeGreaterThan(0);
      for (const path of referenced) {
        const response = await fetch(new URL(path, app.url));
        try {
          expect(response.status).toBe(200);
        } finally {
          await response.body?.cancel();
        }
      }
      for (const extension of [".js", ".css", ".woff2"]) {
        const name = assets.find((asset) => asset.endsWith(extension));
        expect(name).toBeDefined();
        const response = await fetch(new URL(`${base}assets/${name}`, app.url));
        expect(response.status).toBe(200);
        expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
      }
      expect((await fetch(new URL(base + "favicon.svg", app.url))).status).toBe(
        200,
      );
      expect((await fetch(upstream + "/api/health")).status).toBe(404);
    }, 30_000);

    test("the built listener refuses a rebinding Host on pages, commands, events and static files", async () => {
      for (const path of [
        base + "mock",
        new URL(readCommand).pathname,
        base + "api/events",
        base + "favicon.svg",
      ]) {
        const response = await fetch(upstream + path, {
          headers: {
            Host: "rebound.invalid",
            Origin: "http://rebound.invalid",
            "Sec-Fetch-Site": "same-origin",
          },
          signal: AbortSignal.timeout(10_000),
        });
        try {
          expect(response.status).toBe(403);
        } finally {
          await response.body?.cancel();
        }
      }
    }, 30_000);

    // Why: the records event at sequence 0 must cross the gateway and its close must leave the BFF serving.
    // It reads the frame's meaning, not its bytes: the event may gain fields, which the web app's own tests cover.
    test("the real event stream crosses the gateway and closes without breaking the BFF", async () => {
      if (!app) throw new Error("No coding listener");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      // One whole frame, which ends at a blank line however the stream splits it into chunks.
      const readFrame = async (
        reader: ReadableStreamDefaultReader<Uint8Array>,
      ) => {
        const decoder = new TextDecoder();
        let text = "";
        while (!text.includes("\n\n")) {
          const { done, value } = await reader.read();
          if (done)
            throw new Error(
              `The event stream closed before a whole frame: ${JSON.stringify(text)}`,
            );
          text += decoder.decode(value, { stream: true });
        }
        const fields = new Map<string, string[]>();
        for (const line of text.slice(0, text.indexOf("\n\n")).split("\n")) {
          if (line.startsWith(":")) continue;
          const colon = line.indexOf(":");
          const name = colon < 0 ? line : line.slice(0, colon);
          const value =
            colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
          fields.set(name, [...(fields.get(name) ?? []), value]);
        }
        return {
          event: fields.get("event")?.at(-1) ?? "message",
          data: fields.get("data")?.join("\n"),
        };
      };
      try {
        const response = await fetch(new URL(base + "api/events", app.url), {
          signal: controller.signal,
        });
        expect(response.headers.get("content-type")).toContain(
          "text/event-stream",
        );
        const reader = response.body?.getReader();
        if (!reader) throw new Error("No event stream");
        const frame = await readFrame(reader);
        expect(frame.event).toBe("records");
        expect(frame.data).toBeDefined();
        // The disposable repository has no store, so its mark is the empty one.
        expect(JSON.parse(frame.data ?? "")).toMatchObject({
          sequence: 0,
          jobs: "",
        });
        controller.abort();
        await reader.cancel().catch(() => {});
        expect((await fetch(upstream + base + "api/health")).status).toBe(200);
      } finally {
        clearTimeout(timeout);
        controller.abort();
      }
    }, 30_000);

    test("real server functions reject foreign writes and reach input validation from the coding origin", async () => {
      if (!app) throw new Error("No coding listener");
      for (const headers of [
        { Origin: "https://foreign.invalid" },
        { "Sec-Fetch-Site": "cross-site" },
        {},
      ]) {
        expect(
          (
            await fetch(command, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...headers },
              body: "{}",
            })
          ).status,
        ).toBe(403);
      }
      const response = await fetch(command, {
        method: "POST",
        headers: { Origin: new URL(app.url).origin, "x-tsr-serverFn": "true" },
        body: new FormData(),
      });
      const body = await response.text();
      expect(body).toContain("unitId");
      expect(body).toContain("invalid_type");
      expect(body).not.toContain("Seroval Error");
    }, 30_000);

    test("the real BFF retains its own CSRF checks on cross-site GET server-function navigations", async () => {
      if (!app) throw new Error("No coding listener");
      for (const headers of [
        { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate" },
        { Referer: "https://foreign.invalid/" },
        { Referer: app.url },
        {},
      ]) {
        expect((await fetch(readCommand, { headers })).status).toBe(403);
      }
      const accepted = await fetch(readCommand, {
        headers: { Origin: new URL(app.url).origin, "x-tsr-serverFn": "true" },
      });
      const body = await accepted.text();
      expect(body).toContain("invalid_type");
      expect(body).not.toContain("Seroval Error");
    }, 30_000);
  });
}
