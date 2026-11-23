import { expect, test } from "bun:test";
import { isOldParserFile } from "./release/old-parser.ts";

const NAME = "neuve-darwin-arm64";

// Why: the release tests prove the old parser's files left the archive. Matching "oxc" anywhere in a
// path failed a release when a hashed asset of the review desk's bundle happened to contain "OxC".
test("a hashed asset that contains oxc is not the old parser's file", () => {
  expect(
    isOldParserFile(
      `${NAME}/lib/neuve/desk/client/assets/settings-BsOxC9iB.js`,
    ),
  ).toBe(false);
  expect(
    isOldParserFile(`${NAME}/lib/neuve/desk/client/assets/parser-Oxc1.js`),
  ).toBe(false);
});

test("each of the old parser's real file names is a match", () => {
  for (const member of [
    `${NAME}/lib/neuve/oxc-parser/src-js/old.node`,
    `${NAME}/lib/neuve/oxc-parser/package.json`,
    `${NAME}/lib/neuve/node_modules/@oxc-parser/binding-darwin-arm64/package.json`,
    `${NAME}/lib/neuve/node_modules/@oxc-parser/binding-darwin-arm64/parser.darwin-arm64.node`,
    `${NAME}/lib/neuve/node_modules/@oxc-project/types/package.json`,
    `${NAME}/lib/neuve/parser.linux-x64-gnu.node`,
  ])
    expect(isOldParserFile(member)).toBe(true);
});

test("oxc's licence text in the notices is expected", () => {
  expect(
    isOldParserFile(
      `${NAME}/share/neuve/notices/bun@1.4.4/oxc-project__oxc/LICENSE`,
    ),
  ).toBe(false);
});
