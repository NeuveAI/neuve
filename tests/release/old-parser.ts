/**
 * Whether an archive member is one of the old oxc parser's files. Release builds once carried the
 * parser's package under `lib/neuve/oxc-parser/`, its scoped packages `@oxc-parser/binding-<platform>`
 * and `@oxc-project/types`, and its native binding `parser.<platform>.node`. Those names are matched
 * as whole path segments, so a hashed asset that happens to contain "oxc" is not a match. The
 * notices keep oxc's licence text on purpose, so they are left out.
 */
export function isOldParserFile(member: string): boolean {
  if (member.includes("/share/neuve/notices/")) return false;
  return member
    .split("/")
    .some(
      (segment) =>
        segment === "oxc-parser" ||
        segment === "@oxc-parser" ||
        segment === "@oxc-project" ||
        /^parser\.[a-z0-9-]+\.node$/.test(segment),
    );
}
