// Calls the installer directly with a prefix, as any code path in this process could, for the test
// that the shared copy is refused under every spelling in check mode.
import { installLocalCli } from "../../scripts/install-local.ts";

const [prefix, cli, graph] = Bun.argv.slice(2);
if (prefix === undefined || cli === undefined || graph === undefined)
  throw new Error("usage: install-direct.ts <prefix> <cli> <graph>");
try {
  await installLocalCli({
    cli,
    graph,
    prefix,
    graphVersion: "dev",
    graphWorkspaceRevision: null,
  });
  process.stdout.write("installed\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
}
