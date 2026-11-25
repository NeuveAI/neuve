import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { findSkills, skillRoots } from "../src/skills.ts";

test("discovery returns one absolute folder per valid skill name in root order", async () => {
  const roots = skillRoots({
    home: "home",
    cwd: "project",
    carried: "carried",
  });
  const user = resolve("home/.agents/skills");
  const project = resolve("project/.agents/skills");
  const carried = resolve("project/carried");
  const fixture = (name: string, description?: string) =>
    `---\nname: ${name}\n${description === undefined ? "" : `description: ${description}\n`}---\n`;
  const folders = new Map([
    [user, ["duplicate", "manual", "incomplete", "nameless"]],
    [project, ["duplicate", "manual", "incomplete"]],
    [carried, ["duplicate", "incomplete", "unique"]],
  ]);
  const files = new Map([
    [`${user}/duplicate/SKILL.md`, fixture("duplicate", "Personal copy")],
    [
      `${user}/manual/SKILL.md`,
      "---\nname: manual\ndescription: Manual only\ndisable-model-invocation: true\n---\n",
    ],
    [`${user}/incomplete/SKILL.md`, fixture("incomplete")],
    [`${user}/nameless/SKILL.md`, "---\ndescription: Missing name\n---\n"],
    [`${project}/manual/SKILL.md`, fixture("manual", "Shadowed")],
    [`${project}/duplicate/SKILL.md`, fixture("duplicate", "Project copy")],
    [
      `${project}/incomplete/SKILL.md`,
      fixture("incomplete", "Valid project copy"),
    ],
    [`${carried}/duplicate/SKILL.md`, fixture("duplicate", "Carried copy")],
    [
      `${carried}/incomplete/SKILL.md`,
      fixture("incomplete", "Shadowed carried copy"),
    ],
    [
      `${carried}/unique/SKILL.md`,
      "---\r\nname: unique\r\ndescription: >-\r\n  Carried\r\n  only\r\n---\r\n",
    ],
  ]);
  expect(
    await findSkills(roots, {
      list: async (path) => folders.get(path) ?? [],
      read: async (path) => files.get(path),
    }),
  ).toEqual([
    {
      name: "duplicate",
      folder: `${user}/duplicate`,
      description: "Personal copy",
    },
    {
      name: "incomplete",
      folder: `${project}/incomplete`,
      description: "Valid project copy",
    },
    {
      name: "unique",
      folder: `${carried}/unique`,
      description: "Carried only",
    },
  ]);
});
