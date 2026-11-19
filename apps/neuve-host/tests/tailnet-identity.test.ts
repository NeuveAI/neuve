import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Why: catalog.ts reads identity() at module load, so output from `tailscale status --json`
// that isn't JSON (Tailscale just after a restart exits 0 with plain text) crashed every command
// that loads it, help included. Unreadable output must read as no Tailscale.
const modulePath = new URL("../src/tailnet.ts", import.meta.url).href;

for (const [name, output] of [
	["non-JSON", "Tailscale is not started"],
	["truncated JSON", '{"BackendState":'],
	["null", "null"],
	["number", "42"],
	["boolean", "true"],
	["string", '"fixture"'],
	["array", "[]"],
	["missing self", '{"BackendState":"Running","User":{}}'],
] as const) {
	test(`identity returns nothing for ${name} output`, async () => {
		expect(await identity(output)).toEqual({});
	});
}

const running = {
	BackendState: "Running",
	MagicDNSSuffix: "fixture.invalid",
	Self: { UserID: 1 },
	User: { "1": { LoginName: "fixture@example.invalid" } },
};

for (const [name, status, expected] of [
	["a running identity", running, { login: "fixture@example.invalid", tailnet: "fixture.invalid" }],
	["null User", { ...running, Self: { UserID: 0 }, User: null }, { tailnet: "fixture.invalid" }],
	["missing User", { ...running, User: undefined }, { tailnet: "fixture.invalid" }],
	["missing MagicDNSSuffix", { ...running, MagicDNSSuffix: undefined }, { login: "fixture@example.invalid" }],
	["a non-Running backend", { ...running, BackendState: "Stopped" }, {}],
	["a numeric MagicDNSSuffix", { ...running, MagicDNSSuffix: 42 }, { login: "fixture@example.invalid", tailnet: 42 }],
] as const) {
	test(`identity preserves the base result for ${name}`, async () => {
		expect(await identity(JSON.stringify(status))).toEqual(expected);
	});
}

async function identity(output: string): Promise<unknown> {
	const root = await mkdtemp(join(tmpdir(), "tailnet-identity-"));
	try {
		const executable = join(root, "tailscale");
		await writeFile(executable, `#!/bin/sh\nprintf '%s' "$TAILNET_FIXTURE_OUTPUT"\n`);
		await chmod(executable, 0o755);
		const child = Bun.spawn([process.execPath, "--no-env-file", "--eval",
			`const { identity } = await import(${JSON.stringify(modulePath)}); console.log(JSON.stringify(identity()));`,
		], {
			env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ""}`, TAILNET_FIXTURE_OUTPUT: output },
			stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000,
		});
		try {
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
			]);
			expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
			return JSON.parse(stdout);
		} finally {
			if (child.exitCode === null) child.kill();
			await child.exited;
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
