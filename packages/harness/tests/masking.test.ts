import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { maskText } from "../src/masking.ts";

test("keeps the permissive email grammar and global match boundaries", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["a@b.co", "<email>"],
    ["a@b.c a@.co a@..co", "a@b.c a@.co <email>"],
    ["a@b.co123", "<email>123"],
    ["a@b.co.12", "<email>.12"],
    ["a@b.co.cd9", "<email>9"],
    ["a@b.c@d.ef", "a@<email>"],
    ["a@!b@c.de", "a@!<email>"],
    ["a@b.co@d.ef", "<email>@d.ef"],
    ["a@b.co1@d.ef", "<email><email>"],
    ["a@b.co.a@d.ef", "<email><email>"],
    ["a@b.co!c@d.ef", "<email>!<email>"],
    ["éa@b.co🙂c@d.ef", "é<email>🙂<email>"],
    ["._%+-@.-.CO", "<email>"],
    ["@b.co a@ b.co a@b.c", "@b.co a@ b.co a@b.c"],
  ];
  for (const [input, expected] of cases) {
    expect(maskText(input)).toBe(expected);
  }
});

test("preserves declared identifier and credential masking before email matching", () => {
  expect(maskText("ABC-123 abc a.b a@b.co", ["ABC-123", "ab", "a.b"])).toBe(
    "<masked> abc <masked> <email>",
  );
  expect(
    maskText(
      "sk-ant-abcdefgh sk-abcdefghijklmnopqrst ghp_abcdefghijklmnopqrst github_pat_abcdefghijklmnopqrst xoxb-abcdefghij lin_api_abcdefghijklmnopqrst lin_oauth_abcdefghijklmnopqrst",
    ),
  ).toBe(
    "sk-ant-<masked> sk-<masked> gh_<masked> github_pat_<masked> xox-<masked> lin_<masked> lin_<masked>",
  );
  expect(maskText("a@b.co", ["b.co"])).toBe("a@<masked>");
});

test("agrees with the original matcher on bounded exhaustive and generated strings", () => {
  const old = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  const check = (text: string) =>
    expect(maskText(text)).toBe(text.replace(old, "<email>"));
  let layer = [""];
  for (let length = 0; length <= 7; length++) {
    for (const text of layer) check(text);
    if (length < 7)
      layer = layer.flatMap((text) =>
        ["a", ".", "@", "!"].map((char) => text + char),
      );
  }
  let seed = 42;
  const alphabet = "abAZ09._%+-@!é🙂";
  for (let sample = 0; sample < 20_000; sample++) {
    let text = "";
    for (let index = 0; index < 80; index++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      text += alphabet[seed % alphabet.length];
    }
    check(text);
  }
});

for (const name of [
  "no-at",
  "invalid-local",
  "invalid-domain",
  "invalid-dots",
  "candidates",
  "matches",
]) {
  test(`masks complete 10 MiB ${name} text within an external bound`, () => {
    const child = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("fixtures/masking-large.ts", import.meta.url)),
        name,
      ],
      {
        encoding: "utf8",
        timeout: 5000,
        killSignal: "SIGKILL",
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stdout).toContain(`"name":"${name}"`);
  }, 6000);
}
