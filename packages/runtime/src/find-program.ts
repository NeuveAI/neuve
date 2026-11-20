/**
 * Where a vendor's program is, by the convention T3 Code and opencode follow: a path the person set,
 * used as given, or else the program's name resolved through the PATH, first match. Nothing is run;
 * whether the program works is for the runtime that starts it to find out.
 */
export const findProgram = (
  name: string,
  setting?: string,
  path?: string,
): string | undefined =>
  (path === undefined
    ? Bun.which(setting ?? name)
    : Bun.which(setting ?? name, { PATH: path })) ?? undefined;
