import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";

for (const platform of ["linux", "darwin"]) {
	for (const value of [undefined, "", "relative", "/absolute"]) {
		test(`${platform}: settings path and write with XDG_CONFIG_HOME=${JSON.stringify(value)}`, async () => {
			const root = mkdtempSync(join(tmpdir(), "host-config-path-"));
			const home = join(root, "home");
			const cwd = join(root, "cwd");
			const absolute = join(root, "config");
			mkdirSync(cwd);
			const child = Bun.spawn(
				[
					process.execPath,
					"--no-env-file",
					`--config=${devNull}`,
					"-e",
					`
          Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });
          const { config } = await import(${JSON.stringify(new URL("../src/config.ts", import.meta.url).href)});
          const { spyOn } = await import("bun:test");
          const tailnet = await import(${JSON.stringify(new URL("../src/tailnet.ts", import.meta.url).href)});
          spyOn(tailnet, "identity").mockReturnValue({});
          const { saveFolder } = await import(${JSON.stringify(new URL("../src/preferences.ts", import.meta.url).href)});
          const { readdirSync, readFileSync } = await import("node:fs");
          const { join } = await import("node:path");
          saveFolder("~/projects");
          console.log(JSON.stringify({ settings: config.settings, saved: JSON.parse(readFileSync(join(config.settings, "settings.json"), "utf8")), cwd: readdirSync(process.cwd()) }));
        `,
				],
				{
					cwd,
					env: {
						...process.env,
						HOME: home,
						ACE_HOME: join(root, "host"),
						ACE_CONFIG_HOME: undefined,
						XDG_CONFIG_HOME: value === "/absolute" ? absolute : value,
						BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(root, "transpiler"),
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			try {
				const [code, out, err] = await Promise.all([
					child.exited,
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
				]);
				expect({ code, err }).toEqual({ code: 0, err: "" });
				const settings =
					platform === "darwin"
						? join(home, "Library", "Application Support", "Ace")
						: join(
								value === "/absolute" ? absolute : join(home, ".config"),
								"ace",
							);
				expect(JSON.parse(out)).toEqual({
					settings,
					saved: { folder: "~/projects" },
					cwd: [],
				});
			} finally {
				if (child.exitCode === null) child.kill("SIGKILL");
				await child.exited;
				rmSync(root, { recursive: true, force: true });
			}
		});
	}
}
