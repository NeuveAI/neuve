// Observe the real worker after Bun has loaded runtime flags, config and environment.
import "../../../../packages/records-core/tests/fixture-worker-lifetime.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const directory = z.string().parse(process.env.NEUVE_FIXTURE_OWNER);
writeFileSync(
  join(directory, `${process.pid}.json`),
  JSON.stringify({
    argv: [...process.execArgv, ...process.argv],
    projectEnv: process.env.NEUVE_PROJECT_ENV_MARKER ?? null,
  }),
);
