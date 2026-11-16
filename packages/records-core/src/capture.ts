/**
 * The part of Records that hooks use: the spool, capture state, process ancestry, identity and the
 * worker starter. None of it opens SQLite (D18), and importing it loads no SQL client, so a hook
 * stays small and fast.
 */
export * as Ancestry from "./ancestry.ts";
export * as Caller from "./caller.ts";
export * as Identity from "./identity.ts";
export * as Sessions from "./sessions.ts";
export * as Spool from "./spool.ts";
export * as Starter from "./starter.ts";
export { canonicalJson, sha256Hex } from "./canonical.ts";
export {
  UnknownSession,
  SpoolWriteFailed,
  RepositoryUnavailable,
} from "./errors.ts";
export { mintUlid } from "./ids.ts";
export {
  STORE_DIRECTORY_MODE,
  resolveStoreLocation,
  type StoreLocation,
} from "./location.ts";
