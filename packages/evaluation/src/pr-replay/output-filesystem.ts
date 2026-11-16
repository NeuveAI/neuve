import { cc, dlopen, read } from "bun:ffi";
import adapter from "./output-at.c" with { type: "file" };
import {
  closeSync,
  fstatSync,
  lstatSync,
  constants,
  openSync,
  readdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  rmdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { getSystemErrorName } from "node:util";

const load = () => {
  const library =
    process.platform === "darwin"
      ? "/usr/lib/libSystem.B.dylib"
      : process.platform === "linux"
        ? "libc.so.6"
        : null;
  if (library === null)
    throw new Error("candidate outputs require POSIX directory descriptors");
  const native = dlopen(library, {
    mkdirat: { args: ["i32", "cstring", "u32"], returns: "i32" },
    renameat: { args: ["i32", "cstring", "i32", "cstring"], returns: "i32" },
    unlinkat: { args: ["i32", "cstring", "i32"], returns: "i32" },
  });
  const errno =
    process.platform === "darwin"
      ? dlopen(library, { __error: { args: [], returns: "ptr" } }).symbols
          .__error
      : dlopen(library, { __errno_location: { args: [], returns: "ptr" } })
          .symbols.__errno_location;
  // Bun cc cannot read embedded /$bunfs assets. Its private source copy has no output data.
  const temporary = adapter.startsWith("/$bunfs/")
    ? mkdtempSync(join(tmpdir(), "neuve-output-abi-"))
    : null;
  const source = temporary === null ? adapter : join(temporary, "output-at.c");
  let bridge;
  try {
    if (temporary !== null)
      writeFileSync(source, readFileSync(adapter), { flag: "wx", mode: 0o600 });
    bridge = cc({
      source,
      symbols: {
        output_openat: {
          args: ["i32", "cstring", "i32", "u32"],
          returns: "i32",
        },
        output_cloexec: { args: ["i32"], returns: "i32" },
      },
    });
  } finally {
    if (temporary !== null) {
      try {
        unlinkSync(source);
      } finally {
        rmdirSync(temporary);
      }
    }
  }
  return { ...native.symbols, ...bridge.symbols, errno };
};
let loaded: ReturnType<typeof load> | undefined;
const native = () => (loaded ??= load());
const cstring = (name: string) => {
  if (
    name === "" ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\0")
  )
    throw new Error(
      "an output component has no separator, NUL or parent traversal",
    );
  return Buffer.from(`${name}\0`);
};
const failed = (operation: string, name: string) => {
  const pointer = native().errno();
  const errno = pointer === null ? 5 : read.i32(pointer, 0);
  return Object.assign(
    new Error(`${operation} ${name}: ${getSystemErrorName(-errno)}`),
    {
      code: getSystemErrorName(-errno),
    },
  );
};
const directoryFlags =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/** Only these syscalls mutate treatment paths. Names are relative to a held directory. */
export const outputSyscalls = {
  open(parent: number, name: string, flags: number, mode = 0o666) {
    const fd = native().output_openat(parent, cstring(name), flags, mode);
    if (fd < 0) throw failed("openat", name);
    const descriptorFlags = native().output_cloexec(fd);
    if (descriptorFlags < 0 || (descriptorFlags & 1) === 0) {
      const error = failed("fcntl", name);
      closeSync(fd);
      throw error;
    }
    return fd;
  },
  mkdir(parent: number, name: string, mode = 0o777) {
    if (native().mkdirat(parent, cstring(name), mode) < 0)
      throw failed("mkdirat", name);
  },
  rename(parent: number, from: string, to: string) {
    if (native().renameat(parent, cstring(from), parent, cstring(to)) < 0)
      throw failed("renameat", to);
  },
  unlink(parent: number, name: string, directory = false) {
    if (
      native().unlinkat(
        parent,
        cstring(name),
        directory ? (process.platform === "darwin" ? 0x80 : 0x200) : 0,
      ) < 0
    )
      throw failed("unlinkat", name);
  },
};
export const missingOutput = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
const exists = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "EEXIST";

/** Input is canonical and admitted by the caller. No component lookup can follow a later alias. */
export const withOutputDirectory = <T>(
  path: string,
  create: boolean,
  use: (fd: number) => T,
): T => {
  if (
    !path.startsWith("/") ||
    path.includes("\0") ||
    path.split("/").includes("..")
  )
    throw new Error("an output directory must be canonical and absolute");
  let prefix = parse(path).root;
  let fd = openSync(prefix, directoryFlags);
  try {
    for (const name of path.split("/").filter(Boolean)) {
      if (create) {
        try {
          outputSyscalls.mkdir(fd, name);
        } catch (error) {
          if (!exists(error)) throw error;
        }
      }
      const child = outputSyscalls.open(fd, name, directoryFlags);
      prefix = join(prefix, name);
      try {
        // Verify independently of the FFI adapter and its platform ABI.
        const entry = lstatSync(prefix, { bigint: true });
        const opened = fstatSync(child, { bigint: true });
        if (
          !entry.isDirectory() ||
          !opened.isDirectory() ||
          entry.dev !== opened.dev ||
          entry.ino !== opened.ino
        )
          throw new Error(`output directory changed during open: ${prefix}`);
      } catch (error) {
        closeSync(child);
        throw error;
      }
      closeSync(fd);
      fd = child;
    }
    return use(fd);
  } finally {
    closeSync(fd);
  }
};

/** Listing can race, but every removal and descent remains relative to the held directory. */
export const removeOutputEntry = (
  parent: number,
  name: string,
  path: string,
  recursive: boolean,
) => {
  let fd: number;
  try {
    fd = outputSyscalls.open(parent, name, directoryFlags);
  } catch (error) {
    if (missingOutput(error)) return;
    outputSyscalls.unlink(parent, name);
    return;
  }
  try {
    if (!recursive)
      throw new Error(`${path}: removing a directory requires recursive`);
    for (const child of readdirSync(path))
      removeOutputEntry(fd, child, join(path, child), true);
    // A replacement name cannot redirect unlinkat; it removes only an entry of this parent.
    outputSyscalls.unlink(parent, name, true);
  } finally {
    closeSync(fd);
  }
};
