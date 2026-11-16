import {
  readOutlines,
  captureOutlineSource,
} from "../../../src/graph-outline.ts";
console.log(
  JSON.stringify({ stage: "ready", source: captureOutlineSource().key }),
);
await new Promise<void>((resolve) =>
  process.stdin.once("data", () => resolve()),
);
const result = await readOutlines(
  [
    {
      path: "identical.ts",
      bytes: new TextEncoder().encode(
        "// " +
          process.env.OUTLINE_CASE +
          "\n" +
          "export function alpha(input: string) { return input; }\n".repeat(
            5000,
          ),
      ),
    },
  ],
  captureOutlineSource(),
);
console.log(
  JSON.stringify({ stage: "done", kind: result.context("identical.ts").kind }),
);
