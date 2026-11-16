import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Why: catalog.ts reads identity() at module load, so output from `tailscale status --json`
// that isn't JSON (Tailscale just after a restart exits 0 with plain text) crashed every command
// that loads it, help included. Unreadable output must read as no Tailscale.
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** identity() in a fresh process whose only `tailscale` prints `output` and exits 0. */
const identityWith = async (output: string) => {
	const root = await mkdtemp(join(tmpdir(), "neuve-tailnet-"));
	roots.push(root);
	const stub = join(root, "tailscale");
	await writeFile(stub, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(output)}\nexit 0\n`);
	await chmod(stub, 0o755);
	const module = resolve(import.meta.dir, "../src/tailnet.ts");
	const child = Bun.spawn(
		[process.execPath, "-e", `const { identity } = await import(${JSON.stringify(module)}); console.log(JSON.stringify(identity()));`],
		{ env: { ...process.env, PATH: `${root}:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe" },
	);
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(code, stderr).toBe(0);
	return JSON.parse(stdout) as { login?: string; tailnet?: string };
};

test("plain text from tailscale status reads as no Tailscale", async () => {
	expect(await identityWith("The Tailscale CLI failed to start: Failed to load preferences.")).toEqual({});
	// A status without this machine is no identity either.
	expect(await identityWith(JSON.stringify({ BackendState: "Running" }))).toEqual({});
	// A running tailnet still gives the login and the tailnet.
	expect(
		await identityWith(
			JSON.stringify({
				BackendState: "Running",
				MagicDNSSuffix: "example.ts.net",
				Self: { HostName: "mac", DNSName: "mac.example.ts.net.", UserID: 7, TailscaleIPs: ["100.64.0.1"] },
				User: { "7": { LoginName: "sam@example.test" } },
			}),
		),
	).toEqual({ login: "sam@example.test", tailnet: "example.ts.net" });
});
