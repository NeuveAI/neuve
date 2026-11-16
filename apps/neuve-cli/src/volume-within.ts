/** Whether an absolute path is on or beneath a volume's mount point. */
export const within = (root: string, path: string) =>
  root === "/"
    ? path.startsWith("/")
    : path === root || path.startsWith(`${root}/`);
