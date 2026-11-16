import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { looksLikeNoLicence, TEMPLATES } from "./licence-text.ts";

/**
 * Fetches SPDX's licence templates into `licence-templates/` from spdx/license-list-data at one
 * commit, and records what it fetched in `source.json`. A maintenance tool, run by hand. It refuses
 * anything that isn't a template: an answer other than HTTP 200, a body that reads like an error
 * page, or one too short to be a licence. The release tests check every stored template against a
 * table of hashes kept by hand in tests/release/notices.test.ts, not against this record.
 */

const TAG = "v3.28.0";
const COMMIT = "c4a7237ec8f4654e867546f9f409749300f1bf4c";
/** The templates the stored licence texts need (LLVM's exception sits beside the licences). */
const IDS = [
  "0BSD",
  "Apache-2.0",
  "Artistic-1.0-Perl",
  "Artistic-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BSD-4-Clause",
  "BSL-1.0",
  "CC0-1.0",
  "curl",
  "GPL-2.0-only",
  "GPL-3.0-only",
  "IJG",
  "ISC",
  "LGPL-2.0-only",
  "LGPL-2.1-only",
  "libpng-2.0",
  "MIT",
  "MIT-0",
  "MPL-2.0",
  "NCSA",
  "OpenSSL",
  "Python-2.0",
  "SSLeay-standalone",
  "Unicode-3.0",
  "Unicode-DFS-2016",
  "Unlicense",
  "W3C",
  "X11",
  "Zlib",
  "LLVM-exception",
];

const fetchTemplate = async (path: string) => {
  const url = `https://raw.githubusercontent.com/spdx/license-list-data/${COMMIT}/${path}`;
  const response = await fetch(url);
  if (response.status !== 200)
    throw new Error(`${url} answered HTTP ${response.status}.`);
  const text = await response.text();
  if (looksLikeNoLicence(text))
    throw new Error(
      `${url} isn't a licence template: ${JSON.stringify(text.slice(0, 80))}`,
    );
  return { url, text };
};

if (import.meta.main) {
  const sha256: Record<string, string> = {};
  for (const id of IDS) {
    const { text } = await fetchTemplate(`template/${id}.template.txt`);
    await writeFile(join(TEMPLATES, `${id}.template.txt`), text);
    sha256[id] = createHash("sha256").update(text).digest("hex");
    console.log(id, text.length);
  }
  const source = JSON.parse(
    await readFile(join(TEMPLATES, "source.json"), "utf8"),
  ) as Record<string, unknown>;
  await writeFile(
    join(TEMPLATES, "source.json"),
    `${JSON.stringify({ ...source, tag: TAG, commit: COMMIT, sha256 }, null, 2)}\n`,
  );
}
