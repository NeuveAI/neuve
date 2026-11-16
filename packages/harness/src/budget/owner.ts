import { createHash } from "node:crypto";

/** Preserve path-string identity without sending an unbounded path over the budget socket. */
export const repositoryOwner = (repository: string): string =>
  `repository:${createHash("sha256").update(repository).digest("hex")}`;
