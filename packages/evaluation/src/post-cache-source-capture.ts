import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";

export type CapturedFile = Readonly<{
  path: string;
  sha256: string;
  mode: number;
  bytes: number;
}>;

const relativeInput = (path: string): string => {
  if (
    isAbsolute(path) ||
    normalize(path) !== path ||
    path.split(sep).includes("..") ||
    path === "."
  )
    throw new Error(`Unsafe capture path: ${path}`);
  if (
    path === "apps/neuve-web" ||
    path.startsWith("apps/neuve-web/") ||
    path === "design/neuve-web" ||
    path.startsWith("design/neuve-web/")
  )
    throw new Error(`Excluded capture path: ${path}`);
  return path;
};

export const guardedSourcePath = async (
  root: string,
  path: string,
): Promise<string> => {
  const parts = relativeInput(path).split(sep);
  let cursor = root;
  const rootMetadata = await lstat(cursor);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink())
    throw new Error(`Unsafe capture root: ${root}`);
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part);
    const metadata = await lstat(cursor);
    if (metadata.isSymbolicLink())
      throw new Error(`Capture refuses symlink: ${cursor}`);
    if (index < parts.length - 1 && !metadata.isDirectory())
      throw new Error(`Capture ancestor is not a directory: ${cursor}`);
  }
  return cursor;
};

export const captureSourceFiles = async (input: {
  root: string;
  paths: readonly string[];
  destination?: string;
}): Promise<readonly CapturedFile[]> => {
  const result: CapturedFile[] = [];
  for (const path of [...input.paths].sort()) {
    const source = await guardedSourcePath(input.root, path);
    const metadata = await lstat(source);
    if (!metadata.isFile())
      throw new Error(`Capture input is not a regular file: ${source}`);
    const bytes = await readFile(source);
    const mode = metadata.mode & 0o777;
    result.push({
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mode,
      bytes: bytes.length,
    });
    if (input.destination !== undefined) {
      const target = join(input.destination, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: "wx" });
      await chmod(target, mode);
    }
  }
  return result;
};

export const graphCapturePaths = async (
  root: string,
): Promise<readonly string[]> => {
  const paths = [
    "go.mod",
    "go.sum",
    "mise.toml",
    "internal/agentsetup/brain-reference.md",
  ];
  const visit = async (path: string): Promise<void> => {
    const directory = await guardedSourcePath(root, path);
    if (!(await lstat(directory)).isDirectory())
      throw new Error(`Capture directory expected: ${directory}`);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "testdata") continue;
      const relative = join(path, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`Capture refuses symlink: ${relative}`);
      if (entry.isDirectory()) await visit(relative);
      else if (
        entry.isFile() &&
        !entry.name.endsWith("_test.go") &&
        /\.(go|c|h)$/.test(entry.name)
      )
        paths.push(relative);
    }
  };
  await visit("cmd/entire-graph");
  await visit("internal");
  return [...new Set(paths)].sort();
};

export const deriveCapturedWorkspace = (
  value: unknown,
): Readonly<Record<string, unknown>> => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("workspaces" in value) ||
    !Array.isArray(value.workspaces)
  )
    throw new Error("Root workspace manifest must contain workspaces.");
  return {
    ...value,
    workspaces: [
      "apps/neuve-cli",
      "packages/graph-client",
      "packages/evaluation",
      "packages/records-core",
      "packages/records-schema",
      "packages/semantic-client",
    ],
  };
};
