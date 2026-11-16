import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { testTemporaryDirectory } from "./temporary.ts";

const { values } = parseArgs({
	options: { runs: { type: "string", default: "30" }, out: { type: "string" } },
});
const runs = Number(values.runs);
if (
	!Number.isInteger(runs) ||
	runs < 1 ||
	!values.out ||
	process.env.NEUVE_MODE !== "check" ||
	!process.env.HOME?.startsWith("/private/tmp/") ||
	!process.env.NEUVE_WORKSPACE_PROFILE
) {
	throw new Error(
		"Use --runs <positive count> --out <evidence directory>, NEUVE_MODE=check, the external TMPDIR, a disposable off-volume HOME and an isolated NEUVE_WORKSPACE_PROFILE",
	);
}
testTemporaryDirectory();
const out = resolve(values.out);
await mkdir(out, { recursive: true });
const names = [
	"PATH",
	"HOME",
	"TMPDIR",
	"NEUVE_MODE",
	"NEUVE_WORKSPACE_PROFILE",
	"NEUVE_CHECK_RECEIPTS",
	"NEUVE_INSTALL_PREFIX",
	"XDG_CONFIG_HOME",
	"XDG_CACHE_HOME",
	"BUN_INSTALL_CACHE_DIR",
	"BUN_RUNTIME_TRANSPILER_CACHE_PATH",
	"ACE_HOME",
	"ACE_CONFIG_HOME",
];
const environment = Object.fromEntries(
	names.map((name) => [name, process.env[name]]),
);
const results: Array<{
	run: number;
	exit: number;
	passed: boolean;
	ms: number;
}> = [];
for (let run = 1; run <= runs; run++) {
	const directory = join(out, String(run).padStart(2, "0"));
	await mkdir(directory, { recursive: true });
	const start = Date.now();
	const child = Bun.spawn(
		[
			process.execPath,
			"--no-env-file",
			"../../scripts/test-budget.ts",
			"--timeout",
			"60000",
			"tests/host.test.ts",
			"--test-name-pattern",
			"Records events reach the real worker",
		],
		{
			cwd: resolve(import.meta.dir, "../.."),
			env: {
				...environment,
				BUN_TMPDIR: process.env.BUN_TMPDIR,
				NEUVE_TEST_SUITE_TIMEOUT_MS: "180000",
				NEUVE_LISTING_DELIVERY_EVIDENCE: directory,
				NEUVE_REVIEW_FEED_EVIDENCE: directory,
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, exit] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	await writeFile(join(directory, "tests.log"), stdout + stderr);
	const passed =
		exit === 0 && /\b4 pass\b/.test(stderr) && /\b0 fail\b/.test(stderr);
	results.push({ run, exit, passed, ms: Date.now() - start });
	await writeFile(
		join(out, "summary.json"),
		JSON.stringify(
			{
				requested: runs,
				passed: results.filter((value) => value.passed).length,
				results,
			},
			null,
			2,
		),
	);
	console.log(
		`Listing delivery ${run}/${runs}: ${passed ? "pass" : "FAIL"} (${Date.now() - start} ms)`,
	);
	if (!passed) process.exit(1);
}
