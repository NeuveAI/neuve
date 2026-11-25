import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

export function skillRoots({
  home,
  cwd,
  carried,
}: {
  home: string;
  cwd: string;
  carried?: string | undefined;
}) {
  return {
    user: resolve(home, ".agents", "skills"),
    project: resolve(cwd, ".agents", "skills"),
    carried: carried === undefined ? undefined : resolve(cwd, carried),
  };
}

const metadata = z.object({
  name: z
    .string()
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().trim().min(1),
  "disable-model-invocation": z.unknown().optional(),
});

function frontmatter(text: string) {
  const yaml = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(
    text,
  )?.[1];
  if (yaml === undefined) return;
  try {
    return metadata.safeParse(Bun.YAML.parse(yaml)).data;
  } catch {
    return undefined;
  }
}

function missing(error: unknown): undefined {
  if (!(
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  ))
    throw error;
}

const localFiles = {
  async list(path: string) {
    const entries = await readdir(path, { withFileTypes: true }).catch(missing);
    return (entries ?? [])
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name);
  },
  async read(path: string) {
    if ((await stat(path).catch(missing))?.isFile())
      return readFile(path, "utf8").catch(missing);
  },
};

export async function findSkills(
  { user, project, carried }: ReturnType<typeof skillRoots>,
  files: typeof localFiles = localFiles,
) {
  const seen = new Set<string>();
  const skills: { folder: string; name: string; description: string }[] = [];
  for (const root of [user, project, carried]) {
    if (root === undefined) continue;
    for (const entry of (await files.list(root)).toSorted()) {
      const folder = join(root, entry);
      const text = await files.read(join(folder, "SKILL.md"));
      const skill = text === undefined ? undefined : frontmatter(text);
      if (skill === undefined || seen.has(skill.name)) continue;
      seen.add(skill.name);
      if (
        /^(?:true|yes|on|1)$/i.test(String(skill["disable-model-invocation"]))
      )
        continue;
      skills.push({ folder, name: skill.name, description: skill.description });
    }
  }
  return skills;
}
