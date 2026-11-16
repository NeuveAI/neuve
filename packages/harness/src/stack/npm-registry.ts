import { createHash } from "node:crypto";
import type { RegistryConfig, RegistryProtocol } from "./capability.ts";

/**
 * The npm registry protocol: names, versions and the URLs Neuve builds for them. Only
 * `registry.npmjs.org` is fetched from in the first build; the tarball URL is built from the name
 * and version, never taken from the lockfile or the registry's metadata.
 */

const NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/;
const VERSION =
  /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const encodedName = (name: string) => name.replace("/", "%2f");

export const NPM_REGISTRY: RegistryProtocol = {
  id: "npm-registry",
  host: "registry.npmjs.org",
  validName: (name) =>
    name.length <= 214 && NAME.test(name) && !name.includes(".."),
  validVersion: (version) => version.length <= 256 && VERSION.test(version),
  scopeOf: (name) => (name.startsWith("@") ? name.split("/")[0] : undefined),
  archiveUrl: (base, name, version) =>
    `${base}/${name}/-/${name.split("/").pop()}-${version}.tgz`,
  metadataUrl: (base, name, version) =>
    `${base}/${encodedName(name)}/${version}`,
  attestationsUrl: (base, name, version) =>
    `${base}/-/npm/v1/attestations/${encodedName(name)}@${version}`,
  attestationSubject: (name, version) => `pkg:npm/${name}@${version}`,
  sourceOf: (metadata) => {
    const doc = (
      typeof metadata === "object" && metadata !== null ? metadata : {}
    ) as {
      repository?: unknown;
      gitHead?: unknown;
      dist?: { attestations?: unknown };
    };
    return {
      repository: doc.repository,
      ...(typeof doc.gitHead === "string" && /^[0-9a-f]{40}$/.test(doc.gitHead)
        ? { statedCommit: doc.gitHead }
        : {}),
      attested: doc.dist?.attestations !== undefined,
    };
  },
  integrityOf: (bytes, integrity) => {
    const algorithm = integrity.split("-")[0] ?? "sha512";
    return `${algorithm}-${createHash(algorithm).update(bytes).digest("base64")}`;
  },
  hashOf: (integrity) => {
    const algorithm = /^(sha512|sha384|sha256|sha1)-/.exec(integrity)?.[1];
    return algorithm;
  },
};

const hostOf = (value: unknown): string | undefined => {
  const url =
    typeof value === "string"
      ? value
      : typeof value === "object" && value !== null && "url" in value
        ? (value as { url: unknown }).url
        : undefined;
  if (typeof url !== "string") return undefined;
  try {
    return new URL(url.trim()).hostname.toLowerCase();
  } catch {
    return url.trim().toLowerCase() || undefined;
  }
};

/**
 * The registry hosts a committed `bunfig.toml` or `.npmrc` names: the default and per scope. Only
 * the `registry` settings are read; tokens, passwords and every other key are never looked at.
 */
export const readNpmRegistryConfig = (
  name: string,
  text: string,
): RegistryConfig => {
  const scopes = new Map<string, string>();
  if (name === "bunfig.toml") {
    let parsed: unknown;
    try {
      parsed = Bun.TOML.parse(text);
    } catch {
      return { scopes };
    }
    const install =
      typeof parsed === "object" && parsed !== null && "install" in parsed
        ? (parsed as { install: unknown }).install
        : undefined;
    if (typeof install !== "object" || install === null) return { scopes };
    const record = install as Record<string, unknown>;
    const scoped = record["scopes"];
    if (typeof scoped === "object" && scoped !== null)
      for (const [scope, value] of Object.entries(scoped)) {
        const host = hostOf(value);
        if (host !== undefined)
          scopes.set(scope.startsWith("@") ? scope : `@${scope}`, host);
      }
    const defaultHost = hostOf(record["registry"]);
    return defaultHost === undefined ? { scopes } : { defaultHost, scopes };
  }
  let defaultHost: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(@[^:=\s]+:)?registry\s*=\s*(.+?)\s*$/.exec(line);
    if (match === null) continue;
    const host = hostOf(match[2]?.replace(/^["']|["']$/g, ""));
    if (host === undefined) continue;
    if (match[1] === undefined) defaultHost = host;
    else scopes.set(match[1].slice(0, -1), host);
  }
  return defaultHost === undefined ? { scopes } : { defaultHost, scopes };
};
