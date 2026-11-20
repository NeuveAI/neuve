/**
 * Where a vendor's program is, by the convention T3 Code and opencode follow: what the person set,
 * and only that, or else the program's name. Either is resolved as the operating system would: a
 * path as given, a bare name through the PATH, first match. Nothing is run; whether the program
 * works is for the runtime that starts it to find out.
 */
export const findProgram = (
  name: string,
  setting?: string,
  path?: string,
): string | undefined =>
  (path === undefined
    ? Bun.which(setting ?? name)
    : Bun.which(setting ?? name, { PATH: path })) ?? undefined;
