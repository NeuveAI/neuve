import { z } from "zod";
import { readBunLock } from "./bun-lock.ts";
import { NPM_REGISTRY, readNpmRegistryConfig } from "./npm-registry.ts";

/**
 * Ecosystem capabilities (proposal SC4, SC12): each declares, as data, the manifest and lockfile
 * names it reads, how it parses them, its default registry, the hash it verifies and the quoted
 * reference forms the ranking counts. Product code iterates `ECOSYSTEM_CAPABILITIES` and names no
 * ecosystem, the way `chunker.ts` declares its parsing capabilities. A repository whose lockfile no
 * capability reads gets a disclosed gap, never a guess.
 */

/** One package at one resolved version, as a lockfile pins it. */
export const Pin = z.strictObject({
  /** `<ecosystem>:<name>@<version>`, the store's entry key. */
  key: z.string().min(1),
  ecosystem: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  /** The lockfile's hash in its own notation, for npm `sha512-<base64>`. */
  integrity: z.string().min(1),
  /** The lockfile it came from, relative to the repository root. */
  lockfile: z.string().min(1),
  /** The workspaces (manifests) that depend on it directly. */
  workspaces: z.array(z.string()),
});
export type Pin = z.infer<typeof Pin>;

export const GapReason = z.enum([
  // Detection (SC4)
  "no-capability",
  "no-lockfile",
  "unreadable-lockfile",
  "private-registry",
  "not-a-registry-package",
  "no-hash",
  "invalid-name",
  // Fetching (SC6, SC7)
  "disabled",
  "hash-mismatch",
  "refused-archive",
  "over-cap",
  "over-budget",
  "store-full-held",
  "not-found",
  "fetch-failed",
  "no-longer-available",
  // Upstream trees (SC4, SC5)
  "no-commit",
  "host-not-allowed",
  "upstream-over-cap",
  "upstream-failed",
  "upstream-refused",
]);
export type GapReason = z.infer<typeof GapReason>;

/** Something not fetched, and why; disclosed in `neuve stack list` and, later, to the harness. */
export const Gap = z.strictObject({
  reason: GapReason,
  detail: z.string(),
  /** The entry it concerns, when there is one. */
  key: z.string().optional(),
  /** The file it concerns: a lockfile, a manifest or a registry configuration. */
  path: z.string().optional(),
});
export type Gap = z.infer<typeof Gap>;

/** What a capability reads from one lockfile. */
export interface LockfileRead {
  readonly pins: ReadonlyArray<Omit<Pin, "key" | "ecosystem" | "lockfile">>;
  readonly gaps: ReadonlyArray<Gap>;
}

/** The registry a committed configuration names, read for its hosts only, never credentials. */
export interface RegistryConfig {
  /** The default registry's host, when the file sets one. */
  readonly defaultHost?: string;
  /** Hosts per package scope. */
  readonly scopes: ReadonlyMap<string, string>;
}

/** A registry protocol: how Neuve builds its URLs for a validated name and version. */
export interface RegistryProtocol {
  readonly id: string;
  /** The public default registry, the only one fetched from in the first build. */
  readonly host: string;
  readonly validName: (name: string) => boolean;
  readonly validVersion: (version: string) => boolean;
  /** The scope a name belongs to, for scoped registry configuration (`@scope`), or undefined. */
  readonly scopeOf: (name: string) => string | undefined;
  readonly archiveUrl: (base: string, name: string, version: string) => string;
  readonly metadataUrl: (base: string, name: string, version: string) => string;
  readonly attestationsUrl: (
    base: string,
    name: string,
    version: string,
  ) => string;
  /** The name an attestation signs for a package, such as npm's `pkg:npm/<name>@<version>`. */
  readonly attestationSubject: (name: string, version: string) => string;
  /**
   * What a version's metadata document says about its source: the repository field as written, a
   * commit the registry states (unverified), and whether it publishes attestations.
   */
  readonly sourceOf: (metadata: unknown) => {
    readonly repository: unknown;
    readonly statedCommit?: string;
    readonly attested: boolean;
  };
  /** The archive's digest in the lockfile's notation, from its bytes. */
  readonly integrityOf: (bytes: Uint8Array, integrity: string) => string;
  /** The hash algorithm the lockfile's integrity names. */
  readonly hashOf: (integrity: string) => string | undefined;
}

export interface EcosystemCapability {
  readonly id: string;
  readonly ecosystem: string;
  /** Lockfile names it reads, matched against the final path component. */
  readonly lockfiles: ReadonlyArray<string>;
  /** Manifest names that pin nothing without one of its lockfiles beside them (SC4). */
  readonly manifests: ReadonlyArray<string>;
  /** Folders of installed dependencies, never read for pins (they are not the repository's own). */
  readonly installFolders: ReadonlyArray<string>;
  /** Committed registry configuration it reads for hosts only. */
  readonly registryConfigs: ReadonlyArray<string>;
  readonly registry: RegistryProtocol;
  /** The hash it verifies. */
  readonly hash: string;
  readonly readLockfile: (text: string) => LockfileRead;
  readonly readRegistryConfig: (name: string, text: string) => RegistryConfig;
  /**
   * The quoted forms a source file uses to reference the package (SC3), counted by `git grep -F`.
   * Manifests and lockfiles are left out of the count.
   */
  readonly referenceForms: (name: string) => ReadonlyArray<string>;
}

export const BUN_LOCK: EcosystemCapability = {
  id: "bun-lock",
  ecosystem: "npm",
  lockfiles: ["bun.lock"],
  manifests: ["package.json"],
  installFolders: ["node_modules"],
  registryConfigs: ["bunfig.toml", ".npmrc"],
  registry: NPM_REGISTRY,
  hash: "sha512",
  readLockfile: readBunLock,
  readRegistryConfig: readNpmRegistryConfig,
  referenceForms: (name) => [
    `"${name}"`,
    `'${name}'`,
    `"${name}/`,
    `'${name}/`,
  ],
};

/** The capabilities this build has, in the order their lockfiles are read. */
export const ECOSYSTEM_CAPABILITIES: ReadonlyArray<EcosystemCapability> = [
  BUN_LOCK,
];

/**
 * Lockfile families declared without a reader yet (ST4). A repository with one of these and no
 * capability's lockfile gets one disclosed gap naming it.
 */
export const UNREAD_LOCKFILES: ReadonlyArray<{
  readonly name: string;
  readonly ecosystem: string;
}> = [
  { name: "bun.lockb", ecosystem: "npm" },
  { name: "package-lock.json", ecosystem: "npm" },
  { name: "npm-shrinkwrap.json", ecosystem: "npm" },
  { name: "pnpm-lock.yaml", ecosystem: "npm" },
  { name: "yarn.lock", ecosystem: "npm" },
  { name: "go.sum", ecosystem: "go" },
  { name: "Cargo.lock", ecosystem: "cargo" },
  { name: "uv.lock", ecosystem: "pypi" },
  { name: "poetry.lock", ecosystem: "pypi" },
];

export const pinKey = (ecosystem: string, name: string, version: string) =>
  `${ecosystem}:${name}@${version}`;
