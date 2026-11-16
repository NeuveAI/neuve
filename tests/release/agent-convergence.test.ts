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
// F44: converge after a same-prefix late unlink or a cross-prefix unlink before install completes.
for (const shell of ["sh", "dash"].filter((shell) => Bun.which(shell)))
  for (const order of ["A-B", "B-A"])
    for (const action of ["uninstall", "rollback"])
      for (const schedule of [
        "same-prefix",
        "before-finish",
        "before-finish-enable-error",
      ])
        test(`F44 incomplete agent converges: ${shell}/${order}/${action}/${schedule}`, async () => {
          const f = await systemdFixture();
          try {
            const [first, last] = order.split("-"),
              command = join(f.home, first!, "bin/neuve"),
              other =
                schedule === "same-prefix"
                  ? command
                  : join(f.home, last!, "bin/neuve"),
              receipt = join(f.directory, "receipt"),
              driver = join(f.directory, "driver.ts");
            const timer = join(
              f.env.XDG_CONFIG_HOME!,
              "systemd/user/dev.neuve.worker.timer",
            );
            const wrapper = join(f.wrappers, "systemctl");
            if (schedule.startsWith("before-finish"))
              await writeFile(
                wrapper,
                (await readFile(wrapper, "utf8")).replace(
                  'case "$1" in',
                  `if [ "\${REVIEW_SWAP:-0}" = 1 ] && [ "$1" = daemon-reload ] && [ ! -f "$NEUVE_SYSTEMD_STATE/paused" ]; then
 : >"$NEUVE_SYSTEMD_STATE/paused"
 while [ ! -f "$NEUVE_SYSTEMD_STATE/resume" ]; do /bin/sleep 0.02; done
fi
case "$1" in`,
                ),
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
  await fs.writeFile(process.env.NEUVE_SYSTEMD_STATE+'/handoff','');
  const child=Bun.spawn([process.execPath,'--no-env-file',import.meta.path,'swap'],{env:{...process.env,REVIEW_SWAP:'1',NEUVE_FAIL_ENABLE:${JSON.stringify(schedule === "before-finish-enable-error" ? "1" : "0")}},stdout:'inherit',stderr:'inherit'});
  ${
    schedule.startsWith("before-finish")
      ? `while(!await fs.lstat(process.env.NEUVE_SYSTEMD_STATE+'/paused').catch(()=>null))await Bun.sleep(20);
  const result=await unlink(path);
  await fs.writeFile(process.env.NEUVE_SYSTEMD_STATE+'/resume','');
  await child.exited;
  return result;`
      : `if(await child.exited!==0)throw new Error('same-prefix install failed');`
  }
 }
 return unlink(path);
}}));
const core=await import(${JSON.stringify(join(import.meta.dir, "../../packages/records-core/src/index.ts"))});
const command=Bun.argv[2]==='swap'?${JSON.stringify(other)}:options.command;
mock.module(${JSON.stringify(join(import.meta.dir, "../../packages/records-core/src/index.ts"))},()=>({...core,Starter:{...core.Starter,currentCliCommand:()=>[command]}}));
Object.defineProperty(process,'platform',{value:'linux'});
const {runWorkerCli}=await import(${JSON.stringify(join(import.meta.dir, "../../apps/neuve-cli/src/worker-cli.ts"))});
if(Bun.argv[2]==='setup')process.env.NEUVE_INSTALL_AGENT_RECEIPT=${JSON.stringify(receipt)};
if(Bun.argv[2]==='main'&&${JSON.stringify(action)}==='rollback')process.env.NEUVE_ROLLBACK_AGENT_RECEIPT=${JSON.stringify(receipt)};
try{process.exitCode=await runWorkerCli([Bun.argv[2]==='main'?'uninstall-agent':'install-agent']);}
catch(error){console.error(String(error));process.exitCode=1;}

`,
            );
            const setup = await run(
              [process.execPath, "--no-env-file", driver, "setup"],
              f.env,
            );
            if (setup.code !== 0) throw new Error(JSON.stringify(setup));
            expect(
              await readFile(timer.replace(/timer$/, "service"), "utf8"),
            ).toBe(agentService(command));
            expect(await readFile(timer, "utf8")).toBe(agentTimer());
            expect(await lstat(join(f.state, "enabled")).then(() => true)).toBe(
              true,
            );
            expect(await lstat(join(f.state, "active")).then(() => true)).toBe(
              true,
            );
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
            expect(
              await exists(join(f.state, "handoff")),
              result.stdout + result.stderr,
            ).toBe(true);
            const paths = agentUnitPaths(f.home, f.env.XDG_CONFIG_HOME);
            const service = await readFile(paths.service, "utf8").catch(
              () => null,
            );
            const timerBytes = await readFile(paths.timer, "utf8").catch(
              () => null,
            );
            // Either direction may win, but a half agent must never survive.
            if (service === null) {
              expect(timerBytes, result.stdout + result.stderr).toBe(null);
              expect(await exists(join(f.state, "enabled"))).toBe(false);
              expect(await exists(join(f.state, "active"))).toBe(false);
              expect(
                await readFile(
                  join(f.state, "dev.neuve.worker.service"),
                  "utf8",
                ),
              ).toBe("");
              expect(
                await readFile(join(f.state, "dev.neuve.worker.timer"), "utf8"),
              ).toBe("");
            } else {
              expect(service).toBe(agentService(other));
              expect(timerBytes, result.stdout + result.stderr).toBe(
                agentTimer(),
              );
              expect(await exists(join(f.state, "enabled"))).toBe(true);
              expect(await exists(join(f.state, "active"))).toBe(true);
              expect(
                await readFile(
                  join(f.state, "dev.neuve.worker.service"),
                  "utf8",
                ),
              ).toBe(service);
              expect(
                await readFile(join(f.state, "dev.neuve.worker.timer"), "utf8"),
              ).toBe(agentTimer());
            }
          } finally {
            await f.close();
          }
        }, 30_000);
