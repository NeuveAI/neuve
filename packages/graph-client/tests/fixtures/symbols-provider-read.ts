import { join } from "node:path";
import { readGraphSymbols } from "../../src/index.ts";

const executable = Bun.argv[2],
  temporaryParent = Bun.argv[3];
if (!executable || !temporaryParent)
  throw new Error("Executable and temporary parent required");
const result = await readGraphSymbols({
  executable,
  temporaryParent,
  cacheDirectory: join(temporaryParent, "cache"),
  files: [
    {
      path: "review.ts",
      bytes: new TextEncoder().encode(
        "export function reviewed() { return 1; }\n",
      ),
    },
  ],
});
console.log(
  JSON.stringify({
    provider: result.provider.name,
    symbols: result.files
      .get("review.ts")
      ?.symbols.map((symbol) => symbol.name),
    outline: result.files.get("review.ts")?.outline != null,
  }),
);
