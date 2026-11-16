// Why: Neuve's own code is MIT and the release must say so, then name each exception exactly; and
// every package compiled into neuve, the Bun runtime included, must ship with its full licence
// text, not a title and a copyright line. These cases pin both at the generator, on real files:
// each stored text is the one fetched upstream (its recorded SHA-256) and carries its licence's
// whole body, no notice row calls a component by a licence its text isn't, and a compiled-in
// package or a Bun without its stored texts stops the build.
import { afterEach, expect, test } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  collectBun,
  collectNpm,
  NOT_LICENCES,
  REVIEWED_TEXTS,
  STORED_LICENSES,
} from "../../scripts/release/notices.ts";
import {
  compileMatch,
  fullLicences,
  licenceRowProblems,
  looksLikeNoLicence,
  TEMPLATES,
  wholeTextProblem,
} from "../../scripts/release/licence-text.ts";
import { DECIDED_SKIPS } from "../../scripts/release/fetch-bun-licenses.ts";
import { removeAllScratch, root, scratchDirectory } from "./release-fixture.ts";

afterEach(removeAllScratch, 60_000);

const sha256 = (bytes: Uint8Array | string) =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const MIT_TITLE_ONLY = "MIT License\n\nCopyright (c) 2026 Someone\n";

test("a licence counts only with its whole body: grant, conditions and disclaimer", async () => {
  const mit = await readFile(join(root, "LICENSE"), "utf8");
  expect(fullLicences(mit)).toEqual(["MIT"]);
  expect(fullLicences(MIT_TITLE_ONLY)).toEqual([]);
  expect(
    fullLicences(mit.replace(/THE SOFTWARE IS PROVIDED[\s\S]*$/, "")),
  ).toEqual([]);
  const apache = await readFile(
    join(root, "apps/neuve-web/packages/diffs/LICENSE.md"),
    "utf8",
  );
  expect(fullLicences(apache)).toContain("Apache-2.0");
  expect(fullLicences(apache.slice(0, 600))).not.toContain("Apache-2.0");
});

// Review 3's planted texts: each looks like a licence by its keywords and isn't one in full.
const TRUNCATED: Record<string, string> = {
  "MIT title only": "MIT License\n\nCopyright (c) 2026 X\n",
  "BSD-3 grant, clause 1 and a one-line disclaimer":
    "Copyright (c) X\nRedistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:\n1. Redistributions of source code must retain the above copyright notice.\nThis software is provided by X.\n",
  "BSD-2 without the binary clause or the disclaimer body":
    "Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:\n* Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.\nTHIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS\n",
  "CC0 one line": "CC0 1.0 Universal. Waiver.\n",
  "Perl Artistic two lines": "The Artistic License\nThe Copyright Holder.\n",
  "ISC cut after AS IS":
    'ISC License\nPermission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted.\nTHE SOFTWARE IS PROVIDED "AS IS"\n',
  "zlib disclaimer without the grant":
    "This software is provided 'as-is', without any express or implied warranty.\n2. Altered source versions must be plainly marked as such.\n",
  "Apache title and four headings":
    "Apache License\nTERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION\n2. Grant of Copyright License.\n7. Disclaimer of Warranty.\n",
  "LGPL headings":
    "GNU LESSER GENERAL PUBLIC LICENSE\nTERMS AND CONDITIONS FOR COPYING, DISTRIBUTION AND MODIFICATION\nNO WARRANTY\n",
  "MPL headings":
    "Mozilla Public License Version 2.0\n1. Definitions\n6. Disclaimer of Warranty\n",
};

test("a truncated licence matches no template: cut at the end, in the middle, or headings only", async () => {
  const mit = await readFile(join(root, "LICENSE"), "utf8");
  const apache = await readFile(
    join(root, "apps/neuve-web/packages/diffs/LICENSE.md"),
    "utf8",
  );
  const lgpl = await readFile(
    join(STORED_LICENSES, `bun@${Bun.version}`, "tinycc__tinycc/COPYING"),
    "utf8",
  );
  const cases: Record<string, string> = {
    ...TRUNCATED,
    "MIT grant only": mit.split("The above copyright")[0] ?? "",
    "MIT cut inside the disclaimer": mit.split("IMPLIED, INCLUDING")[0] ?? "",
    "MIT cut after AS IS": mit.split("WITHOUT WARRANTY")[0] ?? "",
    "MIT without its middle sentence": mit.replace(
      /The above copyright notice[\s\S]*?Software\.\n/,
      "",
    ),
    "Apache without section 5, headings kept": apache.replace(
      /(5\.\s+Submission of Contributions\.)[\s\S]*?(6\.\s+Trademarks\.)/,
      "$1\n\n   $2",
    ),
    "Apache cut after section 8":
      apache.split(/9\.\s+Accepting Warranty/)[0] ?? "",
    "LGPL cut before NO WARRANTY": lgpl.split("NO WARRANTY")[0] ?? "",
  };
  // Each planted text really lost a part (a replace that matched nothing would test nothing).
  for (const [name, text] of Object.entries(cases)) {
    expect(text.length, name).toBeGreaterThan(0);
    if (
      name.startsWith("Apache") ||
      name.startsWith("MIT ") ||
      name.startsWith("LGPL")
    )
      expect(text, name).not.toBe(
        name.startsWith("Apache")
          ? apache
          : name.startsWith("LGPL")
            ? lgpl
            : mit,
      );
    expect(fullLicences(text), name).toEqual([]);
  }
  // The whole texts, for contrast.
  expect(fullLicences(mit)).toEqual(["MIT"]);
  expect(fullLicences(apache)).toContain("Apache-2.0");
  expect(fullLicences(lgpl)).toContain("LGPL-2.1-only");
  // A licence with no template here matches nothing: the build then refuses it.
  expect(
    fullLicences(
      "Do What The F*ck You Want To Public License, Version 2. 0. You just DO WHAT THE F*CK YOU WANT TO.",
    ),
  ).toEqual([]);
});

/**
 * Every template's SHA-256, kept by hand and apart from the fetch: the SPDX ones were each fetched
 * again on 14 November from spdx/license-list-data at the commit source.json records, read and
 * compared; the local ones are this repository's own variants (licence-templates/local/README.md).
 * A template that changes, or a fetch that stores an error page, fails here.
 */
const TEMPLATE_SHA256: Record<string, string> = {
  "0BSD": "5b5b3cf0d303e1bed3144433e570f46f92810f6d9cb31073fb089786ff5472ff",
  "Apache-2.0":
    "5567209d3a634ebd6ed122a7302563b9668ab141941149a4e30d9c7b887f41b9",
  "Artistic-1.0-Perl":
    "ac6546f748096d2926628ea53d2192d253d656fa55c457e31a5ec340d5ff8aa5",
  "Artistic-2.0":
    "72204944cbc62ae1dc98d04c9e4e3b1a06ebbabf9d4f65c3981fff8948b79775",
  "BSD-2-Clause":
    "922ac644c79e7c2aa31bacac531a5d4d5b9d183853a3dc44a253fd9267c3c890",
  "BSD-3-Clause":
    "c42368b683ceef1ad41b6f17999adf3b7534e3c47fbdd51449ed6690edb1fc5f",
  "BSD-4-Clause":
    "83f029b6cf7c9b3705b44cc6d1308c114b6857e3478fcc59d685855e5aa7c9fe",
  "BSL-1.0": "5218853c2dd51b793b84bce58bb669dcad92215fc6de3dd06be83946e94d9078",
  "BlueOak-1.0.0":
    "ed25ff0a3d7caace676bae18a2d06d6e61311b91b8f705548d91e2c1d5110ed8",
  "CC0-1.0": "11b0f2c2841f449603f36bf727342f194ffdda8cc98cb9b3416d7a1e1b31628e",
  "GPL-2.0-only":
    "c9f2d3e2a989b5e6caa601a189f33c1023a5a331683462b67c024bad793007de",
  "GPL-3.0-only":
    "bd632df8d9c69b3bb583bcc464abd8216f973b228528f0fa50ddb778a8a90b6f",
  IJG: "46cda96ea342a8cbd6fcf0ea7271278f8b45f907a81e52c2b45b6ea43c617a96",
  ISC: "c4d7eeea621fc85334340d8bc20f59a3042a7d3451211dc123055c07b9733fb1",
  "LGPL-2.0-only":
    "8459e5b47493ee97016d29fdd17b34e89bb222beebfb2b752863a999a3adf54c",
  "LGPL-2.1-only":
    "a12cc4ef130006ba5a540b4c6f1d403b3334e902afcc299fbf68191dd368eb5a",
  "LLVM-exception":
    "6c1e641f62c534da83b25e550348c522032098e1e92f7cb8c2d13be1ca8b58cc",
  "MIT-0": "c897e948891e3e587ba8e14acb51743a3ec69a671ce5a0f07f25ddf24f73de7a",
  MIT: "6283193f4c437103f80b74e52677fd00271ba762237a33432597a07da79d6dc1",
  "MPL-2.0": "f8d0669c1b4aee55ae7018b6200098d07621014cc571e5455072fc1b551395d7",
  NCSA: "0e021a87da89f75875f834eaeb784e37836ea283025652671054bf7c23235e14",
  OpenSSL: "1d82724ce5f7743111b0394305ba961e2e277bbe13b09897b72e782ec121242f",
  "Python-2.0":
    "e9bca0533ed70c07069797347e134da69d7eb3f5d4b0280aff9890688e6af730",
  "SSLeay-standalone":
    "07960e2ba773c5fca6010f021cc458dacd3fb9267a7ff4da5c1f8e8247e08ff8",
  "Unicode-3.0":
    "023b64221a50fa3ea90d2dbedb7dc5af07c2920ecb2ee465d7dbdb900a63b677",
  "Unicode-DFS-2016":
    "ef81c914ed6385117eb984d1c6fa89edef4fc05a7946c9c3b483ed49f725d55e",
  Unlicense: "e6a01517253c197874d66ab30ca3f596cfce601aafcc310ec2944585a4a254bd",
  W3C: "65929da7e927bf4cfcccc3a0540d894253439a71995919afab318c2a7b016d07",
  X11: "30fe15e95c81333bce7ccb6e6a27c9a4bbf67d80d2990d0f7c7268671f75da5e",
  Zlib: "517518a720051db892e77865041587abc99146359c9a0eb4de360bdab9e9255b",
  curl: "18898199289ff9526ef779a4cce3f79ab6e1cd3c646221dc7903b884cf1bbecb",
  "libpng-2.0":
    "c2b623fb762274adff4e30a618186ea6f25f3984a0450ab33ceedf99d4ee4a2d",
  "local/BSD-2-Clause-unchanged":
    "eb7c048fda165b85a4ed3b217242e7d18d89cf8f612006c6c411c3169cdda5fc",
  "local/BSD-3-Clause-named":
    "8e2965594746749bc12797ff2fe314048f84d77ff2d3238303ee68b618ef6d20",
};

test("each template is the hand-checked text, and the fetch records the same hashes", async () => {
  const stored = [
    ...(await readdir(TEMPLATES)),
    ...(await readdir(join(TEMPLATES, "local"))).map((name) => `local/${name}`),
  ]
    .filter((name) => name.endsWith(".template.txt"))
    .map((name) => name.slice(0, -".template.txt".length));
  expect(stored.sort()).toEqual(Object.keys(TEMPLATE_SHA256).sort());
  for (const [id, hash] of Object.entries(TEMPLATE_SHA256)) {
    const text = await readFile(join(TEMPLATES, `${id}.template.txt`));
    expect(sha256(text), id).toBe(hash);
    expect(looksLikeNoLicence(text.toString()), id).toBe(false);
  }
  const source = JSON.parse(
    await readFile(join(TEMPLATES, "source.json"), "utf8"),
  ) as { sha256: Record<string, string> };
  for (const [id, hash] of Object.entries(source.sha256))
    expect(TEMPLATE_SHA256[id], id).toBe(hash);
});

test("an error page or an empty answer is never a licence or a template", () => {
  for (const page of [
    "404: Not Found",
    "404: Not Found\n",
    "<!DOCTYPE html><html><head><title>Page not found</title></head><body>404</body></html>",
    "<?xml version='1.0'?><Error><Code>NoSuchKey</Code></Error>",
    `503 Service Unavailable\n${"Please try again later. ".repeat(20)}`,
    "",
  ]) {
    expect(looksLikeNoLicence(page), page).toBe(true);
    expect(fullLicences(page), page).toEqual([]);
  }
});

test("the SPDX templates are the ones fetched at the recorded commit", async () => {
  const source = JSON.parse(
    await readFile(join(TEMPLATES, "source.json"), "utf8"),
  ) as {
    commit: string;
    sha256: Record<string, string>;
  };
  expect(source.commit).toMatch(/^[0-9a-f]{40}$/);
  for (const [id, hash] of Object.entries(source.sha256))
    expect(
      sha256(await readFile(join(TEMPLATES, `${id}.template.txt`))),
      id,
    ).toBe(hash);
});

test("the index names Neuve's code as MIT, then each exception, and no row calls a text by a licence it isn't", async () => {
  const index = await readFile(join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
  expect(index).toContain(
    "Neuve's own code is under the MIT license in [LICENSE](LICENSE): the repository's root `LICENSE`, which a release archive carries beside this file in `share/neuve/notices/`.",
  );
  for (const exception of [
    "`apps/neuve-web/packages/diffs/`, which stays under Apache-2.0, Neuve's changes included",
    "JavaScriptCore and WebKit under LGPL-2",
  ])
    expect(index).toContain(exception);
  const read = async (target: string) =>
    (await Bun.file(join(root, target)).exists())
      ? readFile(join(root, target), "utf8")
      : undefined;
  expect(await licenceRowProblems(index, read)).toEqual([]);
  // The check bites: a non-MIT text called MIT.
  const erlang =
    index.split("\n").find((line) => line.startsWith("| Erlang grammar")) ?? "";
  expect(erlang).toContain("| Apache-2.0 |");
  expect(
    await licenceRowProblems(erlang.replace("| Apache-2.0 |", "| MIT |"), read),
  ).toEqual(["says MIT but a licence file it links isn't MIT: Erlang grammar"]);
  // A row that links only a NOTICE, a licence file that isn't there, an MIT text beside the real
  // licence, or names MIT in other words: each is caught (review 3's row probes).
  const asMit = erlang.replace("| Apache-2.0 |", "| MIT |");
  const planted = {
    noticeOnly: asMit.replace(
      /\]\(([^)]*)LICENSE\)/,
      "](apps/neuve-web/packages/diffs/NOTICE.md)",
    ),
    missing: asMit.replace(/\]\(([^)]*)LICENSE\)/, "](nope/LICENSE)"),
    beside: asMit.replace(/ \|$/, " [also](LICENSE) |"),
    mitStyle: erlang.replace("| Apache-2.0 |", "| MIT-style |"),
    expat: erlang.replace("| Apache-2.0 |", "| Expat (MIT) |"),
    diffs: (
      index
        .split("\n")
        .find((line) => line.startsWith("| Modified `@pierre/diffs`")) ?? ""
    ).replace("| Apache-2.0 |", "| MIT |"),
    clojure: (
      index.split("\n").find((line) => line.startsWith("| Clojure grammar")) ??
      ""
    ).replace("| CC0-1.0 |", "| MIT |"),
  };
  for (const [name, row] of Object.entries(planted))
    expect((await licenceRowProblems(row, read)).length, name).toBeGreaterThan(
      0,
    );
  expect(await licenceRowProblems(planted.missing, read)).toContain(
    "links nope/LICENSE, which doesn't exist: Erlang grammar",
  );
});

test("each stored npm text is the one fetched upstream and carries its whole licence", async () => {
  for (const [name, licence] of [
    ["@earendil-works/chord@1.0.0", "MIT"],
    ["@earendil-works/pi-ai@1.0.0", "MIT"],
    ["@earendil-works/pi-durable@1.0.0", "MIT"],
    ["@sigstore/verify@4.1.2", "Apache-2.0"],
    ["standardwebhooks@1.1.1", "MIT"],
  ] as const) {
    const source = JSON.parse(
      await readFile(join(STORED_LICENSES, name, "source.json"), "utf8"),
    );
    const text = await readFile(join(STORED_LICENSES, name, "LICENSE"));
    expect(sha256(text), name).toBe(source.sha256);
    expect(source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(source.url).toBe(
      `https://raw.githubusercontent.com/${source.repository.slice("https://github.com/".length)}/${source.commit}/${source.path}`,
    );
    expect(`${source.package}@${source.version}`).toBe(name);
    expect(fullLicences(text.toString()), name).toContain(licence);
  }
});

test("each stored Bun text is the one fetched upstream, and Bun's licence names nothing left out", async () => {
  const folder = join(STORED_LICENSES, `bun@${Bun.version}`);
  const manifest = JSON.parse(
    await readFile(join(folder, "manifest.json"), "utf8"),
  ) as {
    licenseSha256: string;
    entries: Array<string>;
    skipped: Array<{ project: string; kind: string; reason: string }>;
  };
  const bunLicense = await readFile(join(folder, "oven-sh__bun/LICENSE.md"));
  expect(sha256(bunLicense)).toBe(manifest.licenseSha256);
  const covered = new Set<string>();
  const withoutFullText: Array<string> = [];
  for (const slug of manifest.entries) {
    const source = JSON.parse(
      await readFile(join(folder, slug, "source.json"), "utf8"),
    ) as {
      project: string;
      commit?: string;
      version?: string;
      files: Array<{ name: string; sha256: string }>;
    };
    expect(source.commit ?? source.version, slug).toBeTruthy();
    covered.add(source.project.toLowerCase());
    let full = false;
    for (const file of source.files) {
      const bytes = await readFile(join(folder, slug, file.name));
      expect(sha256(bytes), `${slug}/${file.name}`).toBe(file.sha256);
      if (fullLicences(bytes.toString()).length > 0) full = true;
    }
    if (!full) withoutFullText.push(slug);
  }
  expect(withoutFullText).toEqual([]);
  // Only a decided reason covers a project: never an error that a refresh wrote down.
  for (const item of manifest.skipped) {
    const decided = DECIDED_SKIPS[item.project];
    expect(String(decided?.kind), item.project).toBe(item.kind);
    expect(decided?.reason, item.project).toBe(item.reason);
    covered.add(item.project.replace(/^npm /, "").toLowerCase());
  }
  // Every project Bun's licence links is stored or named as skipped, with its reason.
  const linked = [
    ...bunLicense
      .toString()
      .matchAll(/https:\/\/github\.com\/([^/#)\s]+)\/([^/#)\s>]+)/g),
  ].map((match) => `${match[1]}/${match[2]?.replace(/\.git$/, "")}`);
  const npm = [
    ...bunLicense
      .toString()
      .matchAll(/https:\/\/(?:www\.)?npmjs\.com\/package\/([^/#)\s]+)/g),
  ].map((match) => match[1] ?? "");
  const crates = [
    ...bunLicense
      .toString()
      .matchAll(/https:\/\/crates\.io\/crates\/([^/#)\s]+)/g),
  ].map((match) => match[1] ?? "");
  for (const project of [...linked, ...npm, ...crates])
    expect(covered.has(project.toLowerCase()), project).toBe(true);
});

const fakeBundle = async (stored: string) => {
  const directory = await scratchDirectory("neuve-notices-");
  const pkg = join(directory, "node_modules/@scope/nolicense");
  await mkdir(pkg, { recursive: true });
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "@scope/nolicense",
      version: "1.2.3",
      license: "MIT",
    }),
  );
  await writeFile(join(pkg, "index.js"), "export {};\n");
  const metafile = join(directory, "meta.json");
  await writeFile(
    metafile,
    JSON.stringify({
      inputs: { "node_modules/@scope/nolicense/index.js": {} },
    }),
  );
  return {
    root: directory,
    metafile,
    notices: join(directory, "notices"),
    stored,
  };
};

test("a compiled-in package with no license file and no stored text stops the build", async () => {
  const empty = await scratchDirectory("neuve-stored-");
  await expect(collectNpm(await fakeBundle(empty))).rejects.toThrow(
    "@scope/nolicense@1.2.3 is compiled into neuve but ships no license file",
  );
  const kept = join(empty, "@scope/nolicense@1.2.3");
  await mkdir(kept, { recursive: true });
  await writeFile(join(kept, "LICENSE"), MIT_TITLE_ONLY);
  await writeFile(
    join(kept, "source.json"),
    JSON.stringify({
      url: "https://example.test/LICENSE",
      sha256: sha256("changed since"),
    }),
  );
  await expect(collectNpm(await fakeBundle(empty))).rejects.toThrow(
    "differs from the upstream text its source.json records",
  );
  // The recorded hash, but only a title and a copyright line: still not a licence.
  await writeFile(
    join(kept, "source.json"),
    JSON.stringify({
      url: "https://example.test/LICENSE",
      sha256: sha256(MIT_TITLE_ONLY),
    }),
  );
  await expect(collectNpm(await fakeBundle(empty))).rejects.toThrow(
    "or isn't a whole licence",
  );
  const whole = (await readFile(join(root, "LICENSE"), "utf8")).replace(
    "Neuve AI",
    "Someone",
  );
  await writeFile(join(kept, "LICENSE"), whole);
  await writeFile(
    join(kept, "source.json"),
    JSON.stringify({
      url: "https://example.test/LICENSE",
      sha256: sha256(whole),
    }),
  );
  const bundle = await fakeBundle(empty);
  const { packages } = await collectNpm(bundle);
  expect(packages).toEqual([
    {
      name: "@scope/nolicense",
      version: "1.2.3",
      license: "MIT",
      files: ["bundled/npm/@scope/nolicense@1.2.3/LICENSE"],
    },
  ]);
  expect(
    await readFile(
      join(bundle.notices, "bundled/npm/@scope/nolicense@1.2.3/source.json"),
      "utf8",
    ),
  ).toContain("example.test");
});

test("a Bun without stored texts, or with one changed, stops the build", async () => {
  const notices = join(await scratchDirectory("neuve-bun-notices-"), "notices");
  await expect(collectBun({ bunVersion: "9.9.9", notices })).rejects.toThrow(
    "No license texts for Bun 9.9.9, whose runtime is compiled into neuve",
  );
  // A small copy of the real store: Bun's own licence and BoringSSL's, with the manifest cut to them.
  const copy = await scratchDirectory("neuve-bun-stored-");
  const real = join(STORED_LICENSES, `bun@${Bun.version}`);
  const kept = join(copy, `bun@${Bun.version}`);
  await mkdir(kept, { recursive: true });
  for (const slug of ["oven-sh__bun", "google__boringssl"])
    Bun.spawnSync(["cp", "-R", join(real, slug), join(kept, slug)], {
      stderr: "pipe",
    });
  const manifest = JSON.parse(
    await readFile(join(real, "manifest.json"), "utf8"),
  );
  await writeFile(
    join(kept, "manifest.json"),
    JSON.stringify({
      ...manifest,
      entries: ["google__boringssl", "oven-sh__bun"],
      // Their MPL-2.0 texts aren't in this copy.
      mpl: [],
    }),
  );
  const { entries } = await collectBun({
    bunVersion: Bun.version,
    notices,
    stored: copy,
  });
  expect(entries.map((entry) => entry.slug)).toEqual([
    "google__boringssl",
    "oven-sh__bun",
  ]);
  const boring = join(copy, `bun@${Bun.version}`, "google__boringssl/LICENSE");
  await writeFile(boring, `${await readFile(boring, "utf8")}\nchanged\n`);
  await expect(
    collectBun({ bunVersion: Bun.version, notices, stored: copy }),
  ).rejects.toThrow("google__boringssl/LICENSE for Bun");
});

/** A copy of the stored Bun folder cut to `slugs`, with `change` applied to its manifest. */
const smallStore = async (
  slugs: ReadonlyArray<string>,
  change: (manifest: Record<string, unknown>) => Record<string, unknown> = (
    manifest,
  ) => manifest,
) => {
  const copy = await scratchDirectory("neuve-bun-small-");
  const real = join(STORED_LICENSES, `bun@${Bun.version}`);
  const kept = join(copy, `bun@${Bun.version}`);
  await mkdir(kept, { recursive: true });
  for (const slug of slugs)
    if (await Bun.file(join(real, slug, "source.json")).exists())
      Bun.spawnSync(["cp", "-R", join(real, slug), join(kept, slug)], {
        stderr: "pipe",
      });
  const manifest = JSON.parse(
    await readFile(join(real, "manifest.json"), "utf8"),
  );
  await writeFile(
    join(kept, "manifest.json"),
    JSON.stringify(
      change({
        ...manifest,
        entries: [...slugs],
        // The MPL-2.0 crates whose text is kept in this copy.
        mpl: (manifest.mpl as Array<{ text: string }>).filter((item) =>
          slugs.includes(item.text),
        ),
      }),
    ),
  );
  return { copy, kept };
};

test("the build refuses a stored text that is only part of a licence, even with its recorded hash", async () => {
  // collectBun: a project whose only file is Apache's title and headings.
  const { copy, kept } = await smallStore(["oven-sh__bun", "planted__apache"]);
  const headings = TRUNCATED["Apache title and four headings"] ?? "";
  await mkdir(join(kept, "planted__apache"), { recursive: true });
  await writeFile(join(kept, "planted__apache/LICENSE"), headings);
  await writeFile(
    join(kept, "planted__apache/source.json"),
    JSON.stringify({
      project: "planted/apache",
      commit: "0".repeat(40),
      files: [
        {
          name: "LICENSE",
          url: "https://example.test",
          sha256: sha256(headings),
        },
      ],
    }),
  );
  const notices = join(await scratchDirectory("neuve-bun-notices-"), "notices");
  await expect(
    collectBun({ bunVersion: Bun.version, notices, stored: copy }),
  ).rejects.toThrow(
    `planted__apache/LICENSE for Bun ${Bun.version} isn't a whole licence`,
  );
  // collectNpm: a grant-only BSD text kept for a package that ships none.
  const stored = await scratchDirectory("neuve-stored-");
  const kept2 = join(stored, "@scope/nolicense@1.2.3");
  await mkdir(kept2, { recursive: true });
  const bsd =
    TRUNCATED["BSD-3 grant, clause 1 and a one-line disclaimer"] ?? "";
  await writeFile(join(kept2, "LICENSE"), bsd);
  await writeFile(
    join(kept2, "source.json"),
    JSON.stringify({ url: "https://example.test", sha256: sha256(bsd) }),
  );
  await expect(collectNpm(await fakeBundle(stored))).rejects.toThrow(
    "or isn't a whole licence",
  );
});

test("the build refuses a store that skips a project for what is really a failed fetch", async () => {
  const { copy } = await smallStore(["oven-sh__bun"], (manifest) => ({
    ...manifest,
    skipped: [
      {
        project: "A11yance/aria-query",
        kind: "no-text-upstream",
        reason:
          "Error: git ls-remote https://github.com/A11yance/aria-query HEAD: fatal: unable to access 403",
      },
    ],
  }));
  const notices = join(await scratchDirectory("neuve-bun-notices-"), "notices");
  await expect(
    collectBun({ bunVersion: Bun.version, notices, stored: copy }),
  ).rejects.toThrow(
    "skips A11yance/aria-query for a reason that isn't one of the decided ones",
  );
});

/** A copy of the stored store cut to `slug`, with `file` cut to `cut` and its recorded hash updated. */
const cutStore = async (
  slug: string,
  file: string,
  cut: (text: string) => string,
) => {
  const { copy, kept } = await smallStore(["oven-sh__bun", slug]);
  const path = join(kept, slug, file);
  const text = cut(await readFile(path, "utf8"));
  await writeFile(path, text);
  const source = JSON.parse(
    await readFile(join(kept, slug, "source.json"), "utf8"),
  ) as { files: Array<{ name: string; sha256: string }> };
  for (const entry of source.files)
    if (entry.name === file) entry.sha256 = sha256(text);
  await writeFile(join(kept, slug, "source.json"), JSON.stringify(source));
  return copy;
};

test("a file with several licences is refused when any one of them is cut, the last one included", async () => {
  const notices = () =>
    scratchDirectory("neuve-bun-notices-").then((path) =>
      join(path, "notices"),
    );
  const cuts: ReadonlyArray<
    readonly [string, string, (text: string) => string, string]
  > = [
    // highway: Apache-2.0, BSD-3-Clause, then CC0-1.0, cut inside the CC0 text.
    [
      "google__highway",
      "LICENSE",
      (text) => text.slice(0, text.lastIndexOf("Statement of Purpose")),
      "not the reviewed Apache-2.0, BSD-3-Clause+BSD-3-Clause-named, CC0-1.0",
    ],
    // libcxxabi: Apache-2.0 with the LLVM exceptions, NCSA, then MIT, cut inside the MIT.
    [
      "llvm__llvm-project",
      "libcxxabi__LICENSE.TXT",
      (text) => text.slice(0, text.lastIndexOf("THE SOFTWARE IS PROVIDED")),
      "not the reviewed Apache-2.0, LLVM-exception, NCSA, MIT",
    ],
    // brotli: its MIT cut before the disclaimer, then the whole MIT.
    [
      "google__brotli",
      "LICENSE",
      (text) => `${text.split("THE SOFTWARE IS PROVIDED")[0]}\n\n${text}`,
      "words before the licences aren't part of one",
    ],
    // uucode: its whole MIT kept, the reviewed note after it cut.
    [
      "jacobsandlund__uucode",
      "LICENSE.md",
      (text) => text.slice(0, text.lastIndexOf("* [LICENSE_unicode]")),
      "its text outside the licences isn't the reviewed text",
    ],
    // A copy cut late, then the whole licence: the cut copy's free gaps can't reach into the next.
    [
      "google__brotli",
      "LICENSE",
      (text) => `${text.slice(0, text.indexOf("BE LIABLE"))}\n\n${text}`,
      "words before the licences aren't part of one",
    ],
    [
      "google__brotli",
      "LICENSE",
      (text) => `${text.slice(0, text.indexOf("OTHER DEALINGS"))}\n\n${text}`,
      "words before the licences aren't part of one",
    ],
    [
      "facebook__zstd",
      "LICENSE",
      (text) => `${text.slice(0, text.indexOf("DISCLAIMED"))}\n\n${text}`,
      "words before the licences aren't part of one",
    ],
    // A whole MIT, 17 words of a BSD-3 grant, then the whole MIT again.
    [
      "google__brotli",
      "LICENSE",
      (text) =>
        `${text}\nRedistribution and use in source and binary forms, with or without modification, are permitted provided that the\n\n${text}`,
      "it holds 2 licences (MIT, MIT)",
    ],
    // string_decoder with its second MIT section dropped on its boundary.
    [
      "npm__string_decoder",
      "LICENSE",
      (text) =>
        text.slice(0, text.indexOf("This license applies to parts of Node.js")),
      "its whole licences are MIT, not the reviewed MIT, MIT",
    ],
  ];
  for (const [slug, file, cut, reason] of cuts) {
    const copy = await cutStore(slug, file, cut);
    const refused = await collectBun({
      bunVersion: Bun.version,
      notices: await notices(),
      stored: copy,
    }).then(
      () => "accepted",
      (error: Error) => error.message,
    );
    expect(refused, `${slug}/${file}`).toContain(
      `${slug}/${file} for Bun ${Bun.version} isn't a whole licence: `,
    );
    expect(refused, `${slug}/${file}`).toContain(reason);
  }
  // A file holding two licences that no reviewed entry names stops the build.
  const { copy, kept } = await smallStore(["oven-sh__bun", "planted__dual"]);
  const store = join(STORED_LICENSES, `bun@${Bun.version}`);
  const dual = `${await readFile(join(store, "google__brotli/LICENSE"), "utf8")}\n${await readFile(join(store, "google__diff-match-patch/LICENSE"), "utf8")}`;
  await mkdir(join(kept, "planted__dual"), { recursive: true });
  await writeFile(join(kept, "planted__dual/LICENSE"), dual);
  await writeFile(
    join(kept, "planted__dual/source.json"),
    JSON.stringify({
      project: "planted/dual",
      files: [
        { name: "LICENSE", url: "https://example.test", sha256: sha256(dual) },
      ],
    }),
  );
  expect(fullLicences(dual)).toEqual(["Apache-2.0", "MIT"]);
  await expect(
    collectBun({
      bunVersion: Bun.version,
      notices: await notices(),
      stored: copy,
    }),
  ).rejects.toThrow(
    "planted__dual/LICENSE for Bun 1.4.4 isn't a whole licence: it holds 2 licences (MIT, Apache-2.0), and a file with more than one passes only with a reviewed entry",
  );
});

test("each reviewed entry is needed, and holds for the stored text", async () => {
  const store = join(STORED_LICENSES, `bun@${Bun.version}`);
  for (const [key, entry] of Object.entries(REVIEWED_TEXTS)) {
    const text = await readFile(join(store, key), "utf8");
    expect(wholeTextProblem(text, entry), key).toBeUndefined();
    expect(wholeTextProblem(text), key).toBeDefined();
    expect(NOT_LICENCES[key], key).toBeUndefined();
  }
});

test("words after the last licence, or a licence's own words outside one, are refused", async () => {
  const mit = await readFile(
    join(STORED_LICENSES, "standardwebhooks@1.1.1/LICENSE"),
    "utf8",
  );
  expect(wholeTextProblem(mit)).toBeUndefined();
  expect(wholeTextProblem(`${mit}\nSee also the notes.`)).toContain(
    "words after the licences aren't part of one",
  );
  // A short run, but a licence's own words: a second copy cut to its first sentence.
  expect(
    wholeTextProblem(
      `Permission is hereby granted, free of charge, to any person obtaining a copy\n\n${mit}`,
    ),
  ).toContain("are part of a licence's text, so one is cut");
});

test("SPDX patterns compile with their negated classes, and a malformed one is refused", () => {
  const negated = compileMatch("[^x]+");
  expect(negated.test("abc")).toBe(true);
  expect(negated.test("axc")).toBe(false);
  expect(compileMatch("[ab]c").test("bc")).toBe(true);
  for (const pattern of ["a{2", "a[bc", "(a"])
    expect(() => compileMatch(pattern), pattern).toThrow("is malformed");
});

test("every stored file is a whole licence on its own, even beside one that is", async () => {
  const notices = () =>
    scratchDirectory("neuve-bun-notices-").then((path) =>
      join(path, "notices"),
    );
  const cuts: ReadonlyArray<
    readonly [string, string, (text: string) => string]
  > = [
    // WebKit's LGPL-2.1 cut before NO WARRANTY, next to its whole COPYING.LIB.
    [
      "oven-sh__webkit",
      "Source__WebCore__LICENSE-LGPL-2.1",
      (text) => text.slice(0, text.indexOf("NO WARRANTY")),
    ],
    // lsquic's Chromium licence without its disclaimer, next to its whole MIT LICENSE.
    [
      "litespeedtech__lsquic",
      "LICENSE.chrome",
      (text) => text.slice(0, text.indexOf("THIS SOFTWARE IS PROVIDED")),
    ],
    // The UC Regents excerpt cut before its disclaimer, next to libarchive's whole COPYING.
    [
      "libarchive__libarchive",
      "libarchive__archive_write_add_filter_compress.c.L26-L57",
      (text) => text.slice(0, text.indexOf("THIS SOFTWARE IS PROVIDED")),
    ],
    // An error page stored as a second file.
    ["litespeedtech__lsquic", "LICENSE.chrome", () => "404: Not Found"],
  ];
  for (const [slug, file, cut] of cuts) {
    const copy = await cutStore(slug, file, cut);
    await expect(
      collectBun({
        bunVersion: Bun.version,
        notices: await notices(),
        stored: copy,
      }),
      `${slug}/${file}`,
    ).rejects.toThrow(
      `${slug}/${file} for Bun ${Bun.version} isn't a whole licence`,
    );
  }
  // Uncut, the same three folders pass.
  const { copy } = await smallStore([
    "oven-sh__bun",
    "oven-sh__webkit",
    "litespeedtech__lsquic",
    "libarchive__libarchive",
  ]);
  await collectBun({
    bunVersion: Bun.version,
    notices: await notices(),
    stored: copy,
  });
  // collectNpm: a whole LICENSE with an error page beside it.
  const stored = await scratchDirectory("neuve-stored-");
  const kept = join(stored, "@scope/nolicense@1.2.3");
  await mkdir(kept, { recursive: true });
  const mit = await readFile(
    join(STORED_LICENSES, "standardwebhooks@1.1.1/LICENSE"),
    "utf8",
  );
  await writeFile(join(kept, "LICENSE"), mit);
  await writeFile(join(kept, "NOTICE"), "404: Not Found");
  await writeFile(
    join(kept, "source.json"),
    JSON.stringify({ url: "https://example.test", sha256: sha256(mit) }),
  );
  await expect(collectNpm(await fakeBundle(stored))).rejects.toThrow(
    "@scope/nolicense@1.2.3/NOTICE differs from the upstream text its source.json records, or isn't a whole licence",
  );
});

test("a BSD-3 text whose third clause is deleted or turned around is no BSD-3 licence", async () => {
  const excerpt = await readFile(
    join(
      STORED_LICENSES,
      `bun@${Bun.version}`,
      "libarchive__libarchive/libarchive__archive_write_add_filter_compress.c.L26-L57",
    ),
    "utf8",
  );
  expect(fullLicences(excerpt)).toContain("BSD-3-Clause");
  const clause =
    /Neither the name of the University nor the names of its contributors\n \* {4}may /;
  expect(excerpt).toMatch(clause);
  // The "Neither ... nor ... may" words gone: clause 3 now grants endorsement it withheld.
  expect(fullLicences(excerpt.replace(clause, ""))).toEqual([]);
  // Clause 3 reversed.
  expect(
    fullLicences(excerpt.replace(clause, "The name of the University may ")),
  ).toEqual([]);
});

test("the build refuses a skip whose reason is a network error, however it is worded", async () => {
  for (const reason of [
    "Could not resolve host: github.com",
    "connect ECONNREFUSED 127.0.0.1:443",
    `${DECIDED_SKIPS["evanw"]?.reason} (Could not resolve host)`,
  ]) {
    const { copy } = await smallStore(["oven-sh__bun"], (manifest) => ({
      ...manifest,
      skipped: [{ project: "evanw", kind: "profile-link", reason }],
    }));
    const notices = join(
      await scratchDirectory("neuve-bun-notices-"),
      "notices",
    );
    await expect(
      collectBun({ bunVersion: Bun.version, notices, stored: copy }),
      reason,
    ).rejects.toThrow("for a reason that isn't one of the decided ones");
  }
});

test("Bun's MPL-2.0 crates are each named with a version, a commit and an MPL-2.0 text", async () => {
  const { copy } = await smallStore([
    "oven-sh__bun",
    "crate__cssparser",
    "crate__cssparser-macros",
    "crate__dtoa-short",
  ]);
  const notices = join(await scratchDirectory("neuve-bun-notices-"), "notices");
  const { mpl } = await collectBun({
    bunVersion: Bun.version,
    notices,
    stored: copy,
  });
  expect(mpl.map((item) => `${item.crate} ${item.version}`)).toEqual([
    "cssparser 0.36.0",
    "cssparser-macros 0.6.1",
    "dtoa-short 0.3.5",
    "selectors 0.33.0",
  ]);
  for (const item of mpl) {
    expect(item.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(item.files.length, item.crate).toBeGreaterThan(0);
  }
  // A crate pointing at a folder with no MPL-2.0 text stops the build.
  const { copy: wrong } = await smallStore(
    [
      "oven-sh__bun",
      "crate__cssparser",
      "crate__cssparser-macros",
      "crate__dtoa-short",
      "crate__oxc-toml",
    ],
    (manifest) => ({
      ...manifest,
      mpl: (manifest.mpl as Array<Record<string, string>>).map((item) =>
        item.crate === "selectors"
          ? { ...item, text: "crate__oxc-toml" }
          : item,
      ),
    }),
  );
  await expect(
    collectBun({ bunVersion: Bun.version, notices, stored: wrong }),
  ).rejects.toThrow(
    "names selectors as MPL-2.0, but crate__oxc-toml holds no MPL-2.0 text",
  );
});

/**
 * Runs a copy of the refresh tool over a copy of the stored manifest, against a local server for
 * raw files and a `git` that can't reach anything, so no case leaves this Mac.
 */
const refresh = async (only: string, licenseMd?: string) => {
  const folder = await scratchDirectory("neuve-refresh-");
  await writeFile(
    join(folder, "fetch.ts"),
    await readFile(join(root, "scripts/release/fetch-bun-licenses.ts")),
  );
  const store = join(folder, "licenses", `bun@${Bun.version}`);
  await mkdir(store, { recursive: true });
  const real = join(STORED_LICENSES, `bun@${Bun.version}`);
  const manifest = await readFile(join(real, "manifest.json"), "utf8");
  await writeFile(join(store, "manifest.json"), manifest);
  const bunFiles = join(real, "oven-sh__bun");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/LICENSE.md") && path.startsWith("/oven-sh/bun/"))
        return new Response(
          licenseMd ?? (await readFile(join(bunFiles, "LICENSE.md"))),
        );
      const vendored = /^\/oven-sh\/bun\/[0-9a-f]+\/(.+)$/.exec(path)?.[1];
      if (
        vendored &&
        (await Bun.file(
          join(bunFiles, vendored.replaceAll("/", "__")),
        ).exists())
      )
        return new Response(
          await readFile(join(bunFiles, vendored.replaceAll("/", "__"))),
        );
      if (path.endsWith("bun.lock")) return new Response("", { status: 404 });
      return new Response("unavailable", { status: 503 });
    },
  });
  const bin = join(folder, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "git"),
    "#!/bin/sh\necho 'fatal: unable to access the network' >&2\nexit 128\n",
    { mode: 0o755 },
  );
  try {
    const child = Bun.spawn(
      [process.execPath, join(folder, "fetch.ts"), "--only", only],
      {
        env: {
          ...process.env,
          PATH: `${bin}:/usr/bin:/bin`,
          NEUVE_LICENCE_RAW: `http://127.0.0.1:${server.port}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return {
      code,
      output: stdout + stderr,
      manifestAfter: await readFile(join(store, "manifest.json"), "utf8"),
      manifest,
    };
  } finally {
    await server.stop(true);
  }
};

test("a refresh fails on a fetch that fails, and on a package with no pinned version, and writes nothing", async () => {
  const failed = await refresh("A11yance/aria-query");
  expect(failed.code, failed.output).not.toBe(0);
  expect(failed.output).toContain("fatal: unable to access the network");
  expect(failed.manifestAfter).toBe(failed.manifest);
  const unpinned = await refresh(
    "npm left-unpinned",
    "| [`left-unpinned`](https://npmjs.com/package/left-unpinned) | MIT |\n",
  );
  expect(unpinned.code, unpinned.output).not.toBe(0);
  expect(unpinned.output).toContain(
    "No pinned version for the npm package left-unpinned",
  );
  expect(unpinned.manifestAfter).toBe(unpinned.manifest);
  // A GitHub project with no pin and no recorded decision isn't fetched at its default branch.
  const head = await refresh(
    "someone/unpinned",
    "| [unpinned](https://github.com/someone/unpinned) | MIT |\n",
  );
  expect(head.code, head.output).not.toBe(0);
  expect(head.output).toContain(
    "someone/unpinned has no pinned commit and no decision to take its default branch",
  );
  expect(head.output).not.toContain("unable to access the network");
  expect(head.manifestAfter).toBe(head.manifest);
});
