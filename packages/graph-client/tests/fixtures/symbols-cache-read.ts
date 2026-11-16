import { readGraphSymbols } from "../../src/index.ts";
const [executable, temporaryParent, cacheDirectory] = Bun.argv.slice(2);
if (!executable || !temporaryParent)
  throw new Error("Engine and temporary parent required");
const result = await readGraphSymbols({
  executable,
  temporaryParent,
  ...(cacheDirectory ? { cacheDirectory } : {}),
  files: [
    {
      path: "src/a.ts",
      bytes: new TextEncoder().encode("function alpha() {}\n"),
    },
  ],
});
console.log(
  JSON.stringify({
    sha: result.provider.executable.sha256,
    symbols: result.files.get("src/a.ts")?.symbols.map((s) => s.name),
  }),
);
