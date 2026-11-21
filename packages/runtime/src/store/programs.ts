import { join } from "node:path";
import { z } from "zod";
import { AbsoluteFolder, AccountName } from "../account.ts";
import {
  StoreError,
  neuveFolder,
  readJson,
  unlinkIfPresent,
  writeJson,
} from "./files.ts";

/**
 * The program a person set for an account with `neuve auth program`, kept beside the account
 * records so a built-in account, which has no record, can have one too. The runtime that finds a
 * program asks it first ([finding the program](../../../../process/proposals/codex-runtime.md#finding-the-program)).
 */
const Programs = z.strictObject({
  version: z.literal(1),
  programs: z.record(AccountName, AbsoluteFolder),
});
export const programsPath = (home: string) =>
  join(neuveFolder(home), "accounts", "programs.json");

export function programPath(
  home: string,
  name: AccountName,
): string | undefined {
  return readJson(home, programsPath(home), Programs)?.programs[name];
}

/** Sets the account's program, or forgets it when `path` is absent. */
export function setProgramPath(
  home: string,
  name: AccountName,
  path: string | undefined,
): void {
  if (path !== undefined && !AbsoluteFolder.safeParse(path).success)
    throw new StoreError({ message: "Set the program by its absolute path." });
  const { [name]: _previous, ...others } =
    readJson(home, programsPath(home), Programs)?.programs ?? {};
  const programs = path === undefined ? others : { ...others, [name]: path };
  if (Object.keys(programs).length === 0) unlinkIfPresent(programsPath(home));
  else writeJson(home, programsPath(home), { version: 1, programs });
}
