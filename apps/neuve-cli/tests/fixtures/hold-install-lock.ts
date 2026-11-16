// Holds the install lock with a tracked child running, as an install building the CLI does, until
// it is stopped, for the test that stops it.
import {
  runTracked,
  stopOnSignals,
  withInstallLock,
} from "../../scripts/install-local.ts";

const [prefix, pidFile] = Bun.argv.slice(2);
if (prefix === undefined || pidFile === undefined)
  throw new Error("usage: hold-install-lock.ts <prefix> <pid file>");
stopOnSignals();
await withInstallLock(prefix, () =>
  runTracked(["sh", "-c", `echo $$ > '${pidFile}'; exec sleep 60`], "/"),
);
