/**
 * Deploys the landing page to neuve.ai: a Cloud Storage bucket behind a
 * Google HTTPS load balancer. It builds the site, then uploads dist/ with
 * gcloud, signed in as whoever runs it.
 *
 *   bun run deploy:gcp <bucket> --backend-bucket <name> [--dry-run]
 *   bun run deploy:gcp headers <backend-bucket>
 *
 * Every file gets its own Cache-Control and Content-Type as object metadata
 * (src/build/deploy.ts): /assets/* immutable for a year, the pages and
 * /install.sh for five minutes, everything else for an hour. The bucket's
 * website settings serve index.html at / and 404.html for a missing path.
 * Nothing is deleted from the bucket.
 *
 * The other headers can't be object metadata. The load balancer's backend
 * bucket must send them as custom response headers on every response:
 *
 *   Content-Security-Policy     carries the hash of the inline theme script, so
 *                               it changes when src/theme-init.ts changes
 *   X-Content-Type-Options      nosniff
 *   Referrer-Policy             strict-origin-when-cross-origin
 *   Permissions-Policy          camera=(), microphone=(), geolocation=(), payment=(), usb=()
 *   Cross-Origin-Opener-Policy  same-origin
 *   X-Frame-Options             DENY
 *
 * `headers <backend-bucket>` prints the gcloud command that sets them, with
 * the CSP for this build. Before uploading, a deploy reads the backend
 * bucket's headers and stops if any is missing or different, since a stale
 * CSP would block the theme script on the new page.
 */
import { join } from "node:path";
import { securityHeaders } from "../src/build/csp";
import { builtFiles, missingHeaders, uploads } from "../src/build/deploy";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
const USAGE = [
  "usage: bun run deploy:gcp <bucket> --backend-bucket <name> [--dry-run]",
  "       bun run deploy:gcp headers <backend-bucket>",
].join("\n");

/** Cloud Storage and Compute Engine resource names: lowercase, digits, - _ and . */
const NAME = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Quotes one argument for a POSIX shell, so a printed command can be pasted. */
const quote = (arg: string) =>
  /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;

function show(command: string[]) {
  console.log(`$ ${command.map(quote).join(" ")}`);
}

async function run(command: string[], capture = false): Promise<string> {
  show(command);
  const child = Bun.spawn(command, {
    cwd: root,
    stdin: "ignore",
    stdout: capture ? "pipe" : "inherit",
    stderr: "inherit",
  });
  const out = capture ? await new Response(child.stdout).text() : "";
  const code = await child.exited;
  if (code !== 0) fail(`${command[0]} ${command[1]} exited with ${code}`);
  return out;
}

async function pageHeaders(): Promise<Array<[string, string]>> {
  return securityHeaders(await Bun.file(join(dist, "index.html")).text());
}

function headersCommand(backend: string, headers: Array<[string, string]>) {
  return [
    "gcloud",
    "compute",
    "backend-buckets",
    "update",
    backend,
    ...headers.map(([n, v]) => `--custom-response-header=${n}: ${v}`),
  ];
}

async function deploy(bucket: string, backend: string, dryRun: boolean) {
  await run(["bun", "run", "build"]);
  const files = builtFiles(dist);
  const expected = await pageHeaders();

  const describe = [
    "gcloud",
    "compute",
    "backend-buckets",
    "describe",
    backend,
    "--format=json",
  ];
  if (dryRun) show(describe);
  else {
    const described = JSON.parse(await run(describe, true)) as {
      customResponseHeaders?: string[];
    };
    const missing = missingHeaders(
      expected,
      described.customResponseHeaders ?? [],
    );
    if (missing.length > 0) {
      console.error(
        `The backend bucket ${backend} doesn't send ${missing.map(([n]) => n).join(", ")} as this build needs. Set its headers, then deploy again:`,
      );
      console.error(
        `  ${headersCommand(backend, expected).map(quote).join(" ")}`,
      );
      process.exit(1);
    }
  }

  const step = dryRun
    ? async (command: string[]) => show(command)
    : (command: string[]) => run(command);
  await step([
    "gcloud",
    "storage",
    "buckets",
    "update",
    `gs://${bucket}`,
    "--web-main-page-suffix=index.html",
    "--web-error-page=404.html",
  ]);
  for (const u of uploads(files))
    await step([
      "gcloud",
      "storage",
      "cp",
      ...u.files.map((f) => join("dist", f)),
      `gs://${bucket}/${u.dir ? `${u.dir}/` : ""}`,
      `--cache-control=${u.cacheControl}`,
      `--content-type=${u.contentType}`,
    ]);
  console.log(
    dryRun
      ? `dry run: nothing was uploaded to gs://${bucket}`
      : `deployed ${files.length} files to gs://${bucket}`,
  );
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args[0] === "headers") {
    const backend = args[1];
    if (!backend || !NAME.test(backend) || args.length > 2) fail(USAGE);
    await run(["bun", "run", "build"]);
    builtFiles(dist);
    console.log(
      headersCommand(backend, await pageHeaders())
        .map(quote)
        .join(" "),
    );
  } else {
    const dryRun = args.includes("--dry-run");
    const at = args.indexOf("--backend-bucket");
    if (at < 0) fail(USAGE);
    const backend = args[at + 1];
    const rest = args.filter(
      (a, i) => a !== "--dry-run" && i !== at && i !== at + 1,
    );
    const bucket = rest[0]?.replace(/^gs:\/\//, "").replace(/\/$/, "");
    if (!bucket || !NAME.test(bucket) || rest.length !== 1) fail(USAGE);
    if (!backend || !NAME.test(backend)) fail(USAGE);
    await deploy(bucket, backend, dryRun);
  }
}
