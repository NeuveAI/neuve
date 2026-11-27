export async function openBrowser(url: string): Promise<boolean> {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["rundll32", "url.dll,FileProtocolHandler", url]
        : ["xdg-open", url];
  try {
    const child = Bun.spawn(command, { stdio: ["ignore", "ignore", "ignore"] });
    return (await child.exited) === 0;
  } catch {
    return false;
  }
}
