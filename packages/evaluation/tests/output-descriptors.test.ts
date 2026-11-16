import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  appendOutput,
  makeOutputDirectory,
  removeOutput,
  writeOutput,
} from "../src/pr-replay/sources.ts";
import { outputSyscalls } from "../src/pr-replay/output-filesystem.ts";
import { candidateMain } from "../src/candidate/cli.ts";

const environment = { ...process.env };
let base: string,
  treatment: string,
  research: string,
  parent: string,
  protectedPath: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "output-descriptors-"));
  treatment = join(base, "treatment");
  research = join(base, "research");
  parent = join(treatment, "nested");
  mkdirSync(parent, { recursive: true });
  mkdirSync(join(research, "cases"), { recursive: true });
  protectedPath = join(research, "log");
  writeFileSync(protectedPath, "baseline\n");
  writeFileSync(join(parent, "log"), "treatment\n");
  process.env["NEUVE_RESEARCH_ROOT"] = research;
  process.env["NEUVE_TREATMENT_ROOT"] = treatment;
});
afterEach(() => {
  process.env = { ...environment };
  rmSync(base, { recursive: true, force: true });
});
const swap = () => {
  renameSync(parent, join(treatment, "parked"));
  symlinkSync(research, parent);
};
const identity = () => ({
  ino: lstatSync(protectedPath).ino,
  text: readFileSync(protectedPath, "utf8"),
});

for (const family of [
  "append",
  "partial",
  "rename",
  "walk",
  "mkdir",
  "claim",
  "unlink",
] as const)
  test(`actual ${family} syscall cannot follow a substituted parent`, () => {
    const before = identity();
    let triggered = false;
    const key =
      family === "rename"
        ? "rename"
        : family === "mkdir" || family === "claim"
          ? "mkdir"
          : family === "unlink"
            ? "unlink"
            : "open";
    const original = outputSyscalls[key];
    const hook = spyOn(outputSyscalls, key).mockImplementation(
      (...args: Parameters<typeof original>) => {
        const name = args[1];
        if (
          !triggered &&
          typeof name === "string" &&
          (family === "rename" ||
            (family === "partial" && name.startsWith(".neuve-output-")) ||
            (family === "walk" && name === "nested") ||
            (["append", "unlink"].includes(family) && name === "log") ||
            (["mkdir", "claim"].includes(family) && name === "new"))
        ) {
          triggered = true;
          swap();
        }
        // Each hook schedules a real rename and symlink, then delegates the original syscall.
        return Reflect.apply(original, outputSyscalls, args);
      },
    );
    try {
      if (family === "walk")
        expect(() => writeOutput(join(parent, "log"), "candidate\n")).toThrow();
      else if (family === "append")
        appendOutput(join(parent, "log"), "candidate\n");
      else if (family === "mkdir")
        expect(() =>
          makeOutputDirectory(join(parent, "new"), { recursive: true }),
        ).toThrow();
      else if (family === "claim")
        makeOutputDirectory(join(parent, "new"), {
          recursive: false,
        });
      else if (family === "unlink")
        removeOutput(join(parent, "log"), { force: true });
      else writeOutput(join(parent, "log"), "candidate\n", { mode: 0o600 });
    } finally {
      hook.mockRestore();
    }
    expect(triggered).toBe(true);
    expect(identity()).toEqual(before);
    expect(existsSync(join(research, "new"))).toBe(false);
    if (family === "partial" || family === "rename") {
      const leaf = join(treatment, "parked", "log");
      expect(readFileSync(leaf, "utf8")).toBe("candidate\n");
      expect(lstatSync(leaf).mode & 0o777).toBe(0o600);
    }
  });

test("public candidate inventory writes through its held parent after admission", async () => {
  const before = identity();
  let triggered = false;
  const original = outputSyscalls.open;
  const hook = spyOn(outputSyscalls, "open").mockImplementation(
    (fd, name, flags, mode) => {
      if (name === "inventory.json" && !triggered) {
        triggered = true;
        swap();
      }
      return original(fd, name, flags, mode);
    },
  );
  try {
    await candidateMain([
      "manifest",
      "inventory",
      "--out",
      join(parent, "inventory.json"),
    ]);
  } finally {
    hook.mockRestore();
  }
  expect(triggered).toBe(true);
  expect(identity()).toEqual(before);
  expect(existsSync(join(research, "inventory.json"))).toBe(false);
  const manifest = JSON.parse(
    readFileSync(join(treatment, "parked", "inventory.json"), "utf8"),
  );
  expect(manifest.version).toBe(3);
});

test("exclusive directory claims permit exactly one concurrent process", async () => {
  const source = fileURLToPath(
    new URL("../src/pr-replay/sources.ts", import.meta.url),
  );
  const claim = join(parent, "claim");
  const script = `import { makeOutputDirectory } from ${JSON.stringify(source)}; try { makeOutputDirectory(${JSON.stringify(claim)}); process.exit(0); } catch { process.exit(3); }`;
  const results = await Promise.all(
    Array.from(
      { length: 4 },
      () =>
        Bun.spawn([process.execPath, "-e", script], {
          stdout: "ignore",
          stderr: "pipe",
        }).exited,
    ),
  );
  expect(results.sort()).toEqual([0, 3, 3, 3]);
});

test("missing parents and invalid components refuse without writes", () => {
  expect(() =>
    appendOutput(join(parent, "missing", "log"), "candidate"),
  ).toThrow();
  expect(() => writeOutput(`${parent}/../log`, "candidate")).toThrow(
    "parent traversal",
  );
  expect(() => writeOutput(`${parent}/nul\0`, "candidate")).toThrow("NUL");
  expect(identity().text).toBe("baseline\n");
});

for (const shape of ["symlink", "hardlink"] as const)
  test(`append refuses a ${shape} inserted immediately before openat`, () => {
    const target = join(parent, "race-log");
    const before = identity();
    const original = outputSyscalls.open;
    let triggered = false;
    const hook = spyOn(outputSyscalls, "open").mockImplementation(
      (fd, name, flags, mode) => {
        if (name === "race-log" && !triggered) {
          triggered = true;
          if (shape === "symlink") symlinkSync(protectedPath, target);
          else linkSync(protectedPath, target);
        }
        return original(fd, name, flags, mode);
      },
    );
    try {
      expect(() => appendOutput(target, "candidate")).toThrow();
    } finally {
      hook.mockRestore();
    }
    expect(triggered).toBe(true);
    expect(identity()).toEqual(before);
  });

for (const shape of ["symlink", "directory"] as const)
  test(`walk refuses a ${shape} substituted after opening the component`, () => {
    const before = identity();
    const original = outputSyscalls.open;
    let triggered = false;
    const hook = spyOn(outputSyscalls, "open").mockImplementation(
      (fd, name, flags, mode) => {
        const child = original(fd, name, flags, mode);
        if (name === "nested" && !triggered) {
          triggered = true;
          renameSync(parent, join(treatment, "parked"));
          if (shape === "symlink") symlinkSync(research, parent);
          else mkdirSync(parent);
        }
        return child;
      },
    );
    try {
      expect(() => writeOutput(join(parent, "log"), "candidate\n")).toThrow();
    } finally {
      hook.mockRestore();
    }
    expect(triggered).toBe(true);
    expect(identity()).toEqual(before);
    expect(readFileSync(join(treatment, "parked", "log"), "utf8")).toBe(
      "treatment\n",
    );
  });
