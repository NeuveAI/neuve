import { maskText } from "../../src/masking.ts";

const size = 10 * 1024 * 1024;
const cases = {
  "no-at": ["a".repeat(size), "a".repeat(size)],
  "invalid-local": ["a".repeat(size) + "@!", "a".repeat(size) + "@!"],
  "invalid-domain": ["a@" + "a".repeat(size), "a@" + "a".repeat(size)],
  "invalid-dots": ["a@" + "a.".repeat(size / 2), "a@" + "a.".repeat(size / 2)],
  candidates: [
    "a@b.c!".repeat(Math.ceil(size / 6)),
    "a@b.c!".repeat(Math.ceil(size / 6)),
  ],
  matches: [
    "a@b.co!".repeat(Math.ceil(size / 7)),
    "<email>!".repeat(Math.ceil(size / 7)),
  ],
};
const name = process.argv[2];
if (!name || !(name in cases))
  throw new Error("Unknown synthetic masking case");
const selected = Object.entries(cases).find(([key]) => key === name);
if (!selected) throw new Error("Missing synthetic masking case");
const [input, expected] = selected[1];
if (input === undefined || expected === undefined)
  throw new Error("Missing fixture text");
const started = performance.now();
const output = maskText(input);
const elapsedMs = performance.now() - started;
if (output !== expected) throw new Error("Complete masked text differs");
console.log(
  JSON.stringify({
    name,
    inputBytes: input.length,
    outputBytes: output.length,
    elapsedMs,
    rss: process.memoryUsage().rss,
  }),
);
