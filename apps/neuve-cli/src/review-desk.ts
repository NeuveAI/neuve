import { mkdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Effect } from "effect";
import { z } from "zod";
import { resolveStoreLocation } from "@neuve/records-core";
import { reviewFetch } from "../../neuve-web/apps/web/serve-handler.ts";
import { claimDesk, deskSocket, liveDesk } from "./review-desk-claim.ts";
import { diagnoseDesk, REVIEW_DESK_COMMAND } from "./review-desk-config.ts";
import { requireRepositorySetup } from "./setup-status.ts";
import { quote } from "./shell-quote.ts";

/** The port `neuve review desk` asks for first. */
export const DEFAULT_DESK_PORT = 4141;

export const REVIEW_DESK_HELP = `Usage: neuve review ${REVIEW_DESK_COMMAND} [--repo <path>] [--port <n>]
  Open the batch overview and the review desk for the repository on this machine
  (http://127.0.0.1:${DEFAULT_DESK_PORT}/ unless that port is in use; --port 0 picks a free port).
  It runs until Ctrl-C. A second call for the same repository prints the open desk's address.
  Run neuve setup in the repository first.
`;

const fetchHandler = z.custom<
  (request: Request) => Response | Promise<Response>
>((value) => typeof value === "function");
const serverEntry = z.object({ default: z.object({ fetch: fetchHandler }) });
const portNumber = z.coerce.number().int().min(0).max(65535);

const addressInUse = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "EADDRINUSE";

/**
 * `neuve review desk`: serves the installed desk folder from this process, so neither Bun nor a
 * build is needed at run time. The web app picks its repository when its server starts
 * (`NEUVE_REPOSITORY`), so one desk folder, built once for `/`, serves any repository.
 */
export const runReviewDesk = async (
  args: readonly string[],
  version: string,
): Promise<number> => {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: false,
    options: {
      repo: { type: "string" },
      port: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help === true) {
    await Bun.write(Bun.stdout, REVIEW_DESK_HELP);
    return 0;
  }
  const port = portNumber.safeParse(values.port ?? DEFAULT_DESK_PORT);
  if (!port.success) {
    await Bun.write(
      Bun.stderr,
      `--port takes a number from 0 to 65535, not ${JSON.stringify(values.port)}.\n`,
    );
    return 2;
  }
  const repository = await requireRepositorySetup(
    await realpath(values.repo ?? process.cwd()),
  );
  if (repository === undefined) return 1;
  const again = `neuve review ${REVIEW_DESK_COMMAND}${values.repo === undefined ? "" : ` --repo ${quote(repository)}`}`;
  const desk = await diagnoseDesk(version);
  if (desk.kind !== "ready") {
    await Bun.write(Bun.stderr, `${desk.detail}\n${desk.fix}\n`);
    return 1;
  }
  const location = await Effect.runPromise(resolveStoreLocation(repository));
  await mkdir(location.directory, { recursive: true, mode: 0o700 });
  const socket = await deskSocket(location);
  let claim = await claimDesk(socket);
  if (claim === undefined) {
    // The open desk answers once it serves; a start under load can take a few seconds.
    const address = await liveDesk(socket, 15_000);
    if (address !== undefined) {
      await Bun.write(
        Bun.stdout,
        `Review desk: ${address}\nIt is already open for this repository.\n`,
      );
      return 0;
    }
    // The holder may have ended since: its lock then ended with it.
    claim = await claimDesk(socket);
    if (claim === undefined) {
      await Bun.write(
        Bun.stderr,
        `A review desk for this repository is starting or stopping.\nWait a moment, then run:\n${again}\n`,
      );
      return 1;
    }
  }
  const stopped = Promise.withResolvers<void>();
  const stop = () => stopped.resolve();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.once(signal, stop);
  let server: Bun.Server<undefined> | undefined;
  try {
    // The web app's server reads these when it loads; the workspace-only addresses never apply.
    process.env["NEUVE_REPOSITORY"] = repository;
    process.env["NODE_ENV"] = "production";
    delete process.env["NEUVE_CODING_URL"];
    delete process.env["NEUVE_HOST_URL"];
    delete process.env["NEUVE_HOST_TOKEN_FILE"];
    const entry = serverEntry.parse(
      await import(
        pathToFileURL(join(desk.directory, "server/server.js")).href
      ),
    );
    const client = await realpath(join(desk.directory, "client"));
    const served = reviewFetch(client, "/", (request) =>
      entry.default.fetch(request),
    );
    // This process keeps the server it loaded; an install replaces the folder beside it. Once
    // desk.json is another file, no page mixes the new client with the old server.
    const metadata = join(desk.directory, "desk.json");
    const loaded = await stat(metadata);
    const fetch = async (request: Request) => {
      const now = await stat(metadata).catch(() => undefined);
      if (
        now === undefined ||
        now.ino !== loaded.ino ||
        now.mtimeMs !== loaded.mtimeMs
      )
        return new Response(
          `The review desk was reinstalled. Stop this neuve review ${REVIEW_DESK_COMMAND} with Ctrl-C and run it again.\n`,
          {
            status: 503,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          },
        );
      return served(request);
    };
    const serve = (at: number) =>
      Bun.serve({ hostname: "127.0.0.1", port: at, idleTimeout: 0, fetch });
    try {
      server = serve(port.data);
    } catch (error) {
      // Only the default port gives way; a port the person named is theirs to free.
      if (values.port !== undefined || !addressInUse(error)) throw error;
      server = serve(0);
      await Bun.write(
        Bun.stderr,
        `Port ${DEFAULT_DESK_PORT} is in use. The desk uses port ${server.port} instead.\n`,
      );
    }
    const address = `http://127.0.0.1:${server.port}/`;
    claim.publish(address);
    await Bun.write(Bun.stdout, `Review desk: ${address}\n`);
    await stopped.promise;
    return 0;
  } finally {
    try {
      await server?.stop(true);
    } finally {
      await claim.close();
      for (const signal of signals) process.off(signal, stop);
    }
  }
};
