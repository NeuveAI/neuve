import { test, expect } from "bun:test";
import {
  agentService,
  agentTimer,
  agentUnitPaths,
} from "../../packages/records-core/src/systemd.ts";
import { spawn } from "node:child_process";
import { readFile, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { systemdFixture } from "./systemd-fixture.ts";
const modulePath = join(
  import.meta.dir,
  "../../packages/records-core/src/systemd.ts",
);
const run = async (args: string[], env: NodeJS.ProcessEnv) => {
  const child = spawn(args[0]!, args.slice(1), {
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "",
    closed = false;
  child.stdout!.on("data", (b) => (stdout += b));
  child.stderr!.on("data", (b) => (stderr += b));
  const stop = () => {
    if (!closed && child.pid)
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
  };
  const timer = setTimeout(stop, 30000);
  try {
    return await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
    }>((resolve) =>
      child.once("close", (code) => {
        closed = true;
        resolve({ code, stdout, stderr });
      }),
    );
  } finally {
    clearTimeout(timer);
    stop();
  }
};
// F39 known limit: a late unlink after the winner finishes needs one ordinary repair.
for (const shell of ["sh", "dash"].filter((shell) => Bun.which(shell)))
  for (const order of ["A-B", "B-A"])
    for (const action of ["uninstall", "rollback"])
      test(`F39 known limit late unlink, recoverable: ${shell}/${order}/${action}`, async () => {
        const f = await systemdFixture();
        try {
          const [first, last] = order.split("-"),
            command = join(f.home, first!, "bin/neuve"),
            other = join(f.home, last!, "bin/neuve"),
            receipt = join(f.directory, "receipt"),
            driver = join(f.directory, "driver.ts");
          const timer = join(
            f.env.XDG_CONFIG_HOME!,
            "systemd/user/dev.neuve.worker.timer",
          );
          await writeFile(
            driver,
            `
import {mock} from 'bun:test';
import fs from 'node:fs/promises';
const main=Bun.argv[2]==='main',options={command:${JSON.stringify(command)},load:true};
const unlink=fs.unlink;
let armed=main;
mock.module('node:fs/promises',()=>({...fs,unlink:async(path)=>{
 if(armed&&String(path)===${JSON.stringify(timer)}){
  armed=false;
  const child=Bun.spawn([process.execPath,'--no-env-file',import.meta.path,'swap'],{env:process.env,stdout:'inherit',stderr:'inherit'});
  if(await child.exited!==0)throw new Error('B install failed');
 }
 return unlink(path);
}}));
const S=await import(${JSON.stringify(modulePath)});
try{
 if(Bun.argv[2]==='setup')console.log(await S.installAgent({...options,receipt:${JSON.stringify(receipt)}}));
 else if(Bun.argv[2]==='swap')console.log(await S.installAgent({command:${JSON.stringify(other)},load:true}));
 else console.log(${action === "uninstall" ? "await S.uninstallAgent(options)" : "await S.rollbackAgent({...options,receipt:" + JSON.stringify(receipt) + "})"});
}catch(error){console.error(String(error));process.exitCode=1;}
`,
          );
          const setup = await run(
            [process.execPath, "--no-env-file", driver, "setup"],
            f.env,
          );
          if (setup.code !== 0) throw new Error(JSON.stringify(setup));
          await f.clear();
          const result = await run(
            [
              shell,
              "-c",
              'exec "$NEUVE_SYSTEMD_BUN" --no-env-file "$REVIEW_DRIVER" main',
            ],
            { ...f.env, REVIEW_DRIVER: driver },
          );
          const exists = async (path: string) =>
            !!(await lstat(path).catch(() => null));
          expect(result.code, result.stdout + result.stderr).toBe(1);
          expect(
            await readFile(timer.replace(/timer$/, "service"), "utf8"),
          ).toBe(agentService(other));
          expect(await exists(timer)).toBe(false);
          expect(await exists(join(f.state, "enabled"))).toBe(true);
          expect(await exists(join(f.state, "active"))).toBe(true);
          const repair = await run(
            [process.execPath, "--no-env-file", driver, "swap"],
            f.env,
          );
          expect(repair.code, repair.stdout + repair.stderr).toBe(0);
          expect(await readFile(timer, "utf8")).toBe(agentTimer());
          expect(
            await readFile(timer.replace(/timer$/, "service"), "utf8"),
          ).toBe(agentService(other));
          expect(
            await readFile(join(f.state, "dev.neuve.worker.service"), "utf8"),
          ).toBe(agentService(other));
          expect(
            await readFile(join(f.state, "dev.neuve.worker.timer"), "utf8"),
          ).toBe(agentTimer());
          expect(await exists(join(f.state, "enabled"))).toBe(true);
          expect(await exists(join(f.state, "active"))).toBe(true);
        } finally {
          await f.close();
        }
      }, 30_000);

// F39 known limit: a late stop/disable preserves files but leaves the winner inactive/disabled.
for (const shell of ["sh", "dash"].filter((shell) => Bun.which(shell)))
  for (const action of ["rollback-stop", "rollback-disable"])
    test(`F39 known limit late manager mutation, recoverable: ${shell}/${action}`, async () => {
      const order = "A-B";
      const f = await systemdFixture();
      try {
        const [first, last] = order.split("-");
        const command = join(f.home, first!, "bin/neuve"),
          other = join(f.home, last!, "bin/neuve");
        const receipt = join(f.directory, "receipt"),
          driver = join(f.directory, "driver.ts");
        await writeFile(
          driver,
          `
import * as S from ${JSON.stringify(modulePath)};
const command=${JSON.stringify(command)},other=${JSON.stringify(other)},options={command,load:true};
try{
 if(Bun.argv[2]==='setup')console.log(await S.installAgent({...options,receipt:${JSON.stringify(receipt)}}));
 else if(Bun.argv[2]==='repair')console.log(await S.installAgent({command:other,load:true}));
 else if(Bun.argv[2]==='swap'){console.log(await S.uninstallAgent(options));console.log(await S.installAgent({command:other,load:true}));}
 else console.log(${action === "uninstall" ? "await S.uninstallAgent(options)" : "await S.rollbackAgent({...options,receipt:" + JSON.stringify(receipt) + "})"});
}catch(error){console.error(String(error));process.exitCode=1;}
`,
        );
        const setup = await run(
          [process.execPath, "--no-env-file", driver, "setup"],
          f.env,
        );
        if (setup.code !== 0) throw new Error(JSON.stringify(setup));
        const wrapper = join(f.wrappers, "systemctl");
        let stub = await readFile(wrapper, "utf8");
        const boundary = action === "rollback-stop" ? "stop" : "disable";
        const handoff = `if [ "\${REVIEW_ARMED:-0}" = 1 ] && [ ! -f "$NEUVE_SYSTEMD_STATE/swapped" ]; then
   : >"$NEUVE_SYSTEMD_STATE/swapped"
   REVIEW_ARMED=0 "$NEUVE_SYSTEMD_BUN" --no-env-file "$REVIEW_DRIVER" swap >"$NEUVE_SYSTEMD_STATE/handoff-output" || exit 96
  fi`;
        stub = stub.replace(
          "  " + boundary + ")",
          "  " + boundary + ") " + handoff + "\n",
        );
        await writeFile(wrapper, stub);
        await f.clear();
        const result = await run(
          [
            shell,
            "-c",
            'exec "$NEUVE_SYSTEMD_BUN" --no-env-file "$REVIEW_DRIVER" main',
          ],
          { ...f.env, REVIEW_ARMED: "1", REVIEW_DRIVER: driver },
        );
        const paths = join(f.env.XDG_CONFIG_HOME!, "systemd/user");
        const exists = async (p: string) =>
          !!(await lstat(p).catch(() => null));
        const service = join(paths, "dev.neuve.worker.service"),
          timer = join(paths, "dev.neuve.worker.timer");
        expect(result.code).toBe(1);
        expect(await exists(join(f.state, "swapped"))).toBe(true);
        expect(await readFile(service, "utf8")).toBe(agentService(other));
        expect(await readFile(timer, "utf8")).toBe(agentTimer());
        expect(await exists(join(f.state, "enabled"))).toBe(
          action === "rollback-stop",
        );
        expect(await exists(join(f.state, "active"))).toBe(
          action === "rollback-disable",
        );
        const repair = await run(
          [process.execPath, "--no-env-file", driver, "repair"],
          f.env,
        );
        expect(repair.code, repair.stdout + repair.stderr).toBe(0);
        expect(await readFile(service, "utf8")).toBe(agentService(other));
        expect(await readFile(timer, "utf8")).toBe(agentTimer());
        expect(
          await readFile(join(f.state, "dev.neuve.worker.service"), "utf8"),
        ).toBe(agentService(other));
        expect(
          await readFile(join(f.state, "dev.neuve.worker.timer"), "utf8"),
        ).toBe(agentTimer());
        expect(await exists(join(f.state, "enabled"))).toBe(true);
        expect(await exists(join(f.state, "active"))).toBe(true);
      } finally {
        await f.close();
      }
    }, 30_000);
