import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const [name, output] of [
  ["non-JSON", "fixture Tailscale is not started"],
  [
    "valid JSON",
    JSON.stringify({
      BackendState: "Running",
      MagicDNSSuffix: "fixture.invalid",
      Self: { UserID: 1 },
      User: { "1": { LoginName: "fixture@example.invalid" } },
    }),
  ],
] as const) {
  test(`workspace help succeeds with ${name} Tailscale output`, async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-help-tailnet-"));
    try {
      const executable = join(root, "tailscale");
      await writeFile(
        executable,
        `#!/bin/sh\nprintf '%s' "$TAILNET_FIXTURE_OUTPUT"\n`,
      );
      await chmod(executable, 0o755);
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          join(import.meta.dirname, "../src/cli.ts"),
          "workspace",
          "--help",
        ],
        {
          env: {
            PATH: `${root}:${process.env.PATH ?? ""}`,
            TMPDIR: root,
            BUN_TMPDIR: root,
            ACE_HOME: join(root, "home"),
            ACE_CONFIG_HOME: join(root, "settings"),
            ACE_USER: "fixture",
            TAILNET_FIXTURE_OUTPUT: output,
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          timeout: 20_000,
        },
      );
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
        expect(stdout).toContain("Usage: neuve workspace");
        expect(stdout).toContain("--loopback");
        expect(stdout).not.toContain(output);
      } finally {
        if (child.exitCode === null) child.kill();
        await child.exited;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
}
