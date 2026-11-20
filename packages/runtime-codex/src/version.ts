/**
 * What a Codex release is to this runtime, read from the handshake and judged against the table
 * in `compatibility.json`, as T3 Code judges its own: only a release marked broken is refused.
 */
import table from "./compatibility.json" with { type: "json" };
import { RELEASE } from "./generated/methods.ts";

export type Verdict =
  | { readonly kind: "supported"; readonly version: string }
  | {
      readonly kind: "unsupported";
      readonly version: string;
      readonly advice: string;
    }
  | { readonly kind: "broken"; readonly version: string };

/** The release in `initialize`'s user agent, after the client's own name: `neuve/0.171.0 (…)`. */
export const versionOf = (userAgent: string): string | undefined =>
  /^[^/\s]+\/(\d+\.\d+\.\d+(?:-[\w.]+)?)/.exec(userAgent)?.[1];

export const judge = (
  version: string | undefined,
  broken: ReadonlyArray<string> = table.broken,
): Verdict => {
  if (version === undefined)
    return {
      kind: "unsupported",
      version: "unknown",
      advice: `Codex did not say its version; this Neuve was built for ${RELEASE}.`,
    };
  if (broken.includes(version)) return { kind: "broken", version };
  return Bun.semver.order(version, RELEASE) < 0
    ? {
        kind: "unsupported",
        version,
        advice: `Codex ${version} is older than ${RELEASE}, the release this Neuve was built for; update Codex if a turn fails.`,
      }
    : { kind: "supported", version };
};
