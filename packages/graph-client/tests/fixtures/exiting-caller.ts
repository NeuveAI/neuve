// A stopping preparation child: told to stop, it exits soon after, whatever its inspection is doing.
import { runGraphInspection } from "../../src/index.ts";
import { request } from "../graph-client-support.ts";

const [executable, repository, revision] = Bun.argv.slice(2);
if (!executable || !repository || !revision)
  throw new Error("Missing caller arguments");
process.on("SIGTERM", () => setTimeout(() => process.exit(143), 200));
await runGraphInspection(request(executable, repository, revision, false), {
  emit: async () => {},
}).catch(() => {});
await new Promise(() => {});
