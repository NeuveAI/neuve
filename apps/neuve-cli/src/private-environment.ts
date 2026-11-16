import { open, rename, rm } from "node:fs/promises";

export async function writePrivateEnvironment(
  path: string,
  contents: string,
): Promise<void> {
  const temporary = path + "." + crypto.randomUUID();
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(contents, "utf8");
    await file.close();
    await rename(temporary, path);
  } catch (cause) {
    await file.close().catch(() => {});
    await rm(temporary, { force: true });
    throw cause;
  }
}
