import { resolve } from "node:path";
import { Starter } from "@neuve/records-core";

/** Use the CLI entry explicitly because a test runner can own `Bun.main`. */
export const thisBuild = (): ReadonlyArray<string> =>
  Starter.currentCliCommand(resolve(import.meta.dir, "cli.ts"));
