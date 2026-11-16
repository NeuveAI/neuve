import "./fixtures/memory-secrets";
import {expect, test} from "bun:test";
import {mkdir, mkdtemp, rm} from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {tmpdir} from "node:os";
import {configure} from "../src/host-config";

test("sequential managed configurations never install worker-only flags in the host", async () => {
	const root = await mkdtemp(join(tmpdir(), "host-env-"));
	try {
		await mkdir(join(root, "h")); await mkdir(join(root, "l"));
		const required = {home: join(root, "h"), lanes: join(root, "l"), user: "owner", port: 0, worker: [process.execPath]};
		const name = "NEUVE_TEST_SEQUENTIAL_FLAG";
		expect(process.env[name]).toBeUndefined();
		configure({...required, environment: {[name]: "first", OPENAI_API_KEY: "synthetic-only"}});
		expect(process.env[name]).toBeUndefined();
		expect(JSON.parse(process.env.NEUVE_HOST_CONFIG!).environment).not.toHaveProperty("OPENAI_API_KEY");
		const current = configure({...required, environment: {}});
		expect(current.environment).toEqual({});
		expect(process.env[name]).toBeUndefined();
	} finally {await rm(root, {recursive: true, force: true});}
});

test("worker snapshots drop stale flags while native sealed-key precedence remains exact", async () => {
	const root = await mkdtemp(join(tmpdir(), "worker-env-"));
	try {
		await mkdir(join(root, "h")); await mkdir(join(root, "l"));
		const required = {home: join(root, "h"), lanes: join(root, "l"), user: "owner", port: 12345, environment: {KEEP: "snapshot", PATH: process.env.PATH || ""}, worker: [process.execPath]};
		const script = `
import {configure} from ${JSON.stringify(new URL("../src/host-config.ts", import.meta.url).href)};
import {applyWorkerEnvironment} from ${JSON.stringify(new URL("../src/worker-runtime.ts", import.meta.url).href)};
import {models,seal} from ${JSON.stringify(new URL("../src/keys.ts", import.meta.url).href)};
configure(${JSON.stringify(required)});
process.env.STALE_WORKER_FLAG = "prior";
process.env.ACE_OPENAI_API_KEY = "synthetic-override";
process.env.OPENAI_API_KEY = "synthetic-fallback";
applyWorkerEnvironment();
seal();
const defaults = models();
const model = defaults.getModels("openai")[0];
if (!model) throw new Error("Pinned SDK has no native OpenAI model");
const auth = await defaults.getAuth(model);
console.log(JSON.stringify({flag: process.env.KEEP, stale: process.env.STALE_WORKER_FLAG ?? null, rawCredential: process.env.ACE_OPENAI_API_KEY ?? null, usesOverride: JSON.stringify(auth).includes("synthetic-override"), publicCredential: process.env.NEUVE_HOST_CONFIG.includes("synthetic-override"), home: process.env.ACE_HOME}));
`;
		const result = Bun.spawnSync([process.execPath, "--no-env-file", "--preload", fileURLToPath(new URL("./fixtures/memory-secrets.ts", import.meta.url)), "--eval", script], {env: {PATH: process.env.PATH, TMPDIR: process.env.TMPDIR}, stdout: "pipe", stderr: "pipe"});
		expect(result.exitCode, result.stderr.toString()).toBe(0);
		expect(JSON.parse(result.stdout.toString())).toEqual({flag: "snapshot", stale: null, rawCredential: null, usesOverride: true, publicCredential: false, home: required.home});
	} finally {await rm(root, {recursive: true, force: true});}
});
