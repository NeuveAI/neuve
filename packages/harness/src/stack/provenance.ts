import { createHash, type KeyObject } from "node:crypto";
import { bundleFromJSON } from "@sigstore/bundle";
import { crypto as sigstoreCrypto } from "@sigstore/core";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import {
  Verifier,
  toSignedEntity,
  toTrustMaterial,
  type TrustMaterial,
} from "@sigstore/verify";
import { SIGSTORE_TRUSTED_ROOT } from "./sigstore-trusted-root.ts";

/**
 * Where an entry's upstream tree is, and how much that is proven (proposal SC4). In order:
 *
 * 1. **Attested upstream**: a SLSA provenance attestation that passes real Sigstore verification:
 *    the bundle's certificate chains to the Sigstore root, its transparency-log entry checks, the
 *    DSSE signature verifies, the signed subject's digest equals the fetched package's digest, and
 *    the certificate's source repository is the one the registry metadata names. The commit is read
 *    from what was verified (the predicate's `gitCommit`, which must equal the certificate's source
 *    digest).
 * 2. **Registry-stated upstream**: a registry field such as npm's `gitHead`, unverified.
 *
 * Tags are never guessed: no commit means no upstream tree, disclosed.
 */

export type SourceLevel = "attested" | "registry-stated";

export interface RepositoryLocation {
  readonly host: string;
  /** `owner/repo` or a group path, without `.git`. */
  readonly path: string;
  /** The package's folder inside the repository, when the registry names one. */
  readonly directory?: string;
}

export interface Upstream extends RepositoryLocation {
  readonly level: SourceLevel;
  readonly commit: string;
  /** `https://<host>/<path>.git`, built by Neuve. */
  readonly url: string;
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A registry-stated repository, normalised to an allowed host and a safe path, or undefined. Accepts
 * the forms package metadata uses (`git+https://`, `https://`, `git://`, `git+ssh://git@`,
 * `git@host:`, `github:` and `gitlab:` shorthands, bare `owner/repo`), and always yields an HTTPS
 * location: the scheme the metadata wrote is never used.
 */
export const normaliseRepository = (
  raw: unknown,
): RepositoryLocation | undefined => {
  let url: unknown = raw;
  let directory: unknown;
  if (typeof raw === "object" && raw !== null) {
    url = (raw as { url?: unknown }).url;
    directory = (raw as { directory?: unknown }).directory;
  }
  if (typeof url !== "string") return undefined;
  let text = url.trim().replace(/#.*$/, "");
  let host: string | undefined;
  let path: string | undefined;
  const shorthand = /^(github|gitlab):([^/]+\/[^/]+)$/.exec(text);
  if (shorthand !== null) {
    host = `${shorthand[1]}.com`;
    path = shorthand[2];
  } else if (/^[A-Za-z0-9][\w.-]*\/[\w.-]+$/.test(text)) {
    host = "github.com";
    path = text;
  } else {
    const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(text);
    if (scp !== null) text = `ssh://${scp[1]}/${scp[2]}`;
    try {
      const parsed = new URL(text.replace(/^git\+/, ""));
      if (!["https:", "http:", "git:", "ssh:"].includes(parsed.protocol))
        return undefined;
      host = parsed.hostname.toLowerCase();
      path = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
    } catch {
      return undefined;
    }
  }
  if (host === undefined || path === undefined) return undefined;
  let segments = path
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/");
  const marker = segments.indexOf("-");
  if (marker !== -1) segments = segments.slice(0, marker);
  if (host === "github.com") segments = segments.slice(0, 2);
  if (
    segments.length < 2 ||
    !segments.every((s) => SEGMENT.test(s) && s !== "..")
  )
    return undefined;
  const folder =
    typeof directory === "string" &&
    directory
      .split("/")
      .every((s) => s === "" || (SEGMENT.test(s) && s !== ".."))
      ? directory.replace(/^\/+|\/+$/g, "")
      : undefined;
  return {
    host,
    path: segments.join("/"),
    ...(folder === undefined || folder === "" ? {} : { directory: folder }),
  };
};

export const repositoryUrl = (location: RepositoryLocation) =>
  `https://${location.host}/${location.path}.git`;

const sameRepository = (a: RepositoryLocation, b: RepositoryLocation) =>
  a.host === b.host && a.path.toLowerCase() === b.path.toLowerCase();

/**
 * Bun's crypto has no default digest for ECDSA and RSA keys, which Node's OpenSSL takes as SHA-256
 * when `crypto.verify` is given none; the Sigstore libraries rely on that default for the
 * transparency log's signed entry timestamp and DSSE signatures. This supplies exactly Node's
 * default, so verification is the same check it is under Node, never a weaker one.
 */
let digestDefaultInstalled = false;
const installDigestDefault = () => {
  if (digestDefaultInstalled) return;
  digestDefaultInstalled = true;
  const original = sigstoreCrypto.verify;
  (sigstoreCrypto as { verify: typeof original }).verify = (
    data,
    key,
    signature,
    algorithm,
  ) => {
    const type = (key as KeyObject).asymmetricKeyType;
    return original(
      data,
      key,
      signature,
      algorithm ?? (type === "ec" || type === "rsa" ? "sha256" : undefined),
    );
  };
};

let trust: TrustMaterial | undefined;
const trustMaterial = () => {
  installDigestDefault();
  trust ??= toTrustMaterial(TrustedRoot.fromJSON(SIGSTORE_TRUSTED_ROOT));
  return trust;
};

/** Fulcio's certificate extensions for the source repository and its commit. */
const OID_SOURCE_REPOSITORY = "1.3.6.1.4.1.57264.1.12";
const OID_SOURCE_DIGEST = "1.3.6.1.4.1.57264.1.13";
const OID_ISSUER = "1.3.6.1.4.1.57264.1.8";

/** A DER UTF8String's text (Fulcio's v2 extensions). */
const derString = (bytes: Uint8Array) => {
  if (bytes[0] !== 0x0c) return undefined;
  let length = bytes[1] ?? 0;
  let at = 2;
  if ((length & 0x80) !== 0) {
    const count = length & 0x7f;
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + (bytes[2 + i] ?? 0);
    at = 2 + count;
  }
  return new TextDecoder().decode(bytes.subarray(at, at + length));
};

/**
 * The OIDC issuer each git host's CI signs with (Fulcio's issuer extension): an attestation counts
 * only when its certificate was issued for that host's own CI, so a certificate from another
 * identity provider that names the same repository is not enough. Hosts without an entry are never
 * attested.
 */
export const CI_ISSUERS: Readonly<Record<string, string>> = {
  "github.com": "https://token.actions.githubusercontent.com",
  "gitlab.com": "https://gitlab.com",
};

export interface AttestationCheck {
  /** The signed subject's name the registry protocol states, such as npm's `pkg:npm/<name>@<version>`. */
  readonly subject: string;
  /** The fetched archive's sha512, hex; it already equals the lockfile's hash. */
  readonly sha512Hex: string;
  /** The repository the registry metadata names. */
  readonly repository: RepositoryLocation;
}

/**
 * Verifies a registry's attestations document for one package and returns the attested commit, or
 * the reason it is not attested. Only a SLSA provenance attestation counts.
 */
export const verifyAttestations = (
  document: unknown,
  check: AttestationCheck,
): { readonly commit: string } | { readonly refused: string } => {
  const attestations = (document as { attestations?: unknown } | undefined)
    ?.attestations;
  if (!Array.isArray(attestations)) return { refused: "no attestations" };
  const provenance = attestations.find(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { predicateType?: unknown }).predicateType ===
        "string" &&
      (entry as { predicateType: string }).predicateType.startsWith(
        "https://slsa.dev/provenance/",
      ),
  ) as { predicateType: string; bundle: unknown } | undefined;
  if (provenance === undefined) return { refused: "no provenance attestation" };
  try {
    const bundle = bundleFromJSON(provenance.bundle);
    const signer = new Verifier(trustMaterial()).verify(toSignedEntity(bundle));
    const extension = (oid: string) => {
      const found = signer.identity?.oids?.find(
        (entry) => entry.oid?.id.join(".") === oid,
      );
      return found === undefined ? undefined : derString(found.value);
    };
    const issuer = extension(OID_ISSUER);
    const expectedIssuer = CI_ISSUERS[check.repository.host];
    if (expectedIssuer === undefined || issuer !== expectedIssuer)
      return {
        refused: `the certificate's issuer is ${issuer ?? "absent"}, not ${expectedIssuer ?? "a CI issuer known"} for ${check.repository.host}`,
      };
    const sourceRepository = extension(OID_SOURCE_REPOSITORY);
    const sourceDigest = extension(OID_SOURCE_DIGEST);
    if (sourceRepository === undefined || sourceDigest === undefined)
      return {
        refused: "the certificate names no source repository and commit",
      };
    const certified = normaliseRepository(sourceRepository);
    if (certified === undefined || !sameRepository(certified, check.repository))
      return {
        refused: `the certificate names ${sourceRepository}, not the repository the registry names (${check.repository.host}/${check.repository.path})`,
      };
    if (bundle.content.$case !== "dsseEnvelope")
      return { refused: "the provenance is not a DSSE envelope" };
    const envelope = bundle.content.dsseEnvelope;
    if (envelope.payloadType !== "application/vnd.in-toto+json")
      return { refused: `unexpected payload type ${envelope.payloadType}` };
    const statement = JSON.parse(
      Buffer.from(envelope.payload).toString("utf8"),
    ) as {
      subject?: Array<{ name?: string; digest?: Record<string, string> }>;
      predicate?: {
        buildDefinition?: {
          resolvedDependencies?: Array<{ digest?: Record<string, string> }>;
        };
        invocation?: { configSource?: { digest?: Record<string, string> } };
      };
    };
    const expectedName = check.subject;
    const subject = (statement.subject ?? []).find((entry) => {
      let name = entry.name ?? "";
      try {
        name = decodeURIComponent(name);
      } catch {
        // Compared as written.
      }
      return name === expectedName;
    });
    if (subject === undefined)
      return { refused: `the attestation does not name ${expectedName}` };
    if (subject.digest?.["sha512"]?.toLowerCase() !== check.sha512Hex)
      return {
        refused: "the attested digest is not the fetched package's digest",
      };
    const commit =
      statement.predicate?.buildDefinition?.resolvedDependencies?.[0]?.digest?.[
        "gitCommit"
      ] ?? statement.predicate?.invocation?.configSource?.digest?.["sha1"];
    if (commit === undefined || !/^[0-9a-f]{40}$/.test(commit))
      return { refused: "the attestation names no commit" };
    if (commit !== sourceDigest.toLowerCase())
      return {
        refused:
          "the attested commit differs from the certificate's source commit",
      };
    return { commit };
  } catch (error) {
    return {
      refused:
        `Sigstore verification failed: ${error instanceof Error ? error.message : String(error)}`.slice(
          0,
          300,
        ),
    };
  }
};

/** The hex sha512 of bytes, for the attestation's subject digest. */
export const sha512Hex = (bytes: Uint8Array) =>
  createHash("sha512").update(bytes).digest("hex");
