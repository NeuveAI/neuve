import { expect, test } from "bun:test";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  agentService,
  agentTimer,
  agentUnitPaths,
} from "../../packages/records-core/src/systemd.ts";
import { systemdFixture } from "./systemd-fixture.ts";

const root = resolve(import.meta.dir, "../..");
const modulePath =
  process.env.NEUVE_CONCURRENCY_MODULE ??
  join(root, "packages/records-core/src/systemd.ts");
const exists = async (path: string) => !!(await lstat(path).catch(() => null));
const run = async (args: string[], env: NodeJS.ProcessEnv) => {
  const child = Bun.spawn(args, {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
};
const boundaries = [
  "claim",
  "show",
  "stop",
  "disable",
  "service-remove",
  "timer-remove",
  "service-restore",
  "timer-restore",
  "reload",
  "uninstall",
  "same-prefix",
  "same-service",
  "same-timer",
  "last-uninstall",
];
// A manager boundary may complete an entire competing operation before returning.
// These are the review-15 sequences, with prefix roles reversed on the second pass.
for (const shell of ["sh", "dash"].filter((shell) => Bun.which(shell)))
  for (const order of ["A-B", "B-A"])
    for (const boundary of boundaries)
      test(`agent handoff ends complete: ${shell}/${order}/${boundary}`, async () => {
        const f = await systemdFixture();
        try {
          const [first, last] = order.split("-");
          const command = join(f.home, first!, "bin/neuve");
          const other = boundary.startsWith("same-")
            ? command
            : join(f.home, last!, "bin/neuve");
          const paths = agentUnitPaths(f.home, f.env.XDG_CONFIG_HOME);
          const receipt = join(f.directory, "receipt");
          const driver = join(f.directory, "handoff.ts");
          await writeFile(
            driver,
            `
import {mock} from "bun:test";
import fs from "node:fs/promises";
const command=${JSON.stringify(command)}, other=${JSON.stringify(other)}, boundary=${JSON.stringify(boundary)};
const main = Bun.argv[2] === "main";
let armed=main;
const trigger=async()=>{
  if(!armed)return; armed=false;
  const child=Bun.spawn(["systemctl","--user","test-handoff"],{env:{...process.env, NEUVE_HANDOFF_ARMED:"0"},stdout:"inherit",stderr:"inherit"});
  if(await child.exited!==0)throw new Error("Handoff failed");
};
const unlink=fs.unlink, rename=fs.rename, open=fs.open;
mock.module("node:fs/promises",()=>({...fs,
 unlink:async(path)=>{await unlink(path); if(boundary.endsWith("-remove")&&String(path)===${JSON.stringify(paths.directory)}+"/dev.neuve.worker."+boundary.split("-")[0])await trigger();},
 rename:async(source,destination)=>{await rename(source,destination);if(boundary.endsWith("-restore")&&String(destination)===${JSON.stringify(paths.directory)}+"/dev.neuve.worker."+boundary.split("-")[0])await trigger();},
 open:async(path,...args)=>{
  const handle=await open(path,...args);
  if(boundary.startsWith("same-")&&String(path).includes("/.neuve-worker-")){
   let text="";
   const write=handle.writeFile.bind(handle), sync=handle.sync.bind(handle);
   handle.writeFile=async(bytes,...args)=>{text=String(bytes);await write(bytes,...args);};
   handle.sync=async()=>{await sync();if(boundary==="same-prefix" || boundary==="same-service"&&text.includes("ExecStart=") || boundary==="same-timer"&&text.includes("[Timer]"))await trigger();};
  }
  return handle;
 }
}));
const S=await import(${JSON.stringify(modulePath)});
const options={command,load:true};
if(!main){
 if(boundary==="last-uninstall") console.log(await S.uninstallAgent(options));
 else {
  if(!boundary.startsWith("same-"))await S.uninstallAgent({...options,load:false});
  console.log(await S.installAgent({command:other,load:true}));
 }
} else {
 try {
  console.log(boundary==="claim"||boundary.startsWith("same-")||boundary==="last-uninstall" ? await S.installAgent(options) : boundary==="uninstall" ? await S.uninstallAgent(options) : await S.rollbackAgent({...options,receipt:${JSON.stringify(receipt)}}));
 }catch(error){console.error(String(error));process.exitCode=1;}
}
`,
          );
          const setup = join(f.directory, "setup.ts");
          await writeFile(
            setup,
            `import * as S from ${JSON.stringify(modulePath)};
import {readFile,writeFile} from "node:fs/promises";
const receipt=${JSON.stringify(receipt)};
console.log(await S.installAgent({command:${JSON.stringify(command)},load:true,receipt}));
const state=JSON.parse(await readFile(receipt,"utf8"));
if(${JSON.stringify(boundary)}==="service-restore")state.previousService=Buffer.from(S.agentService(${JSON.stringify(command)})+"# previous\\n").toString("base64");
if(${JSON.stringify(boundary)}==="timer-restore"){state.previousService=state.service;state.previousTimer=Buffer.from(S.agentTimer()+"# previous\\n").toString("base64");}
await writeFile(receipt,JSON.stringify(state));`,
          );
          if (boundary !== "claim" && !boundary.startsWith("same-")) {
            const result = await run(
              [process.execPath, "--no-env-file", setup],
              f.env,
            );
            expect(result, result.stdout + result.stderr).toMatchObject({
              code: 0,
            });
          }
          const wrapper = join(f.wrappers, "systemctl");
          let stub = await readFile(wrapper, "utf8");
          const handoff = `if [ "\${NEUVE_HANDOFF_ARMED:-0}" = 1 ] && [ ! -f "$NEUVE_SYSTEMD_STATE/swapped" ]; then
 : >"$NEUVE_SYSTEMD_STATE/swapped"
 NEUVE_HANDOFF_ARMED=0 "$NEUVE_SYSTEMD_BUN" --no-env-file "$NEUVE_HANDOFF_DRIVER" swap >"$NEUVE_SYSTEMD_STATE/handoff-output" || exit 96
fi`;
          stub = stub.replace(
            'case "$1" in',
            `case "$1" in
 test-handoff) ${handoff.replace('"\${NEUVE_HANDOFF_ARMED:-0}" = 1', "1 = 1")} ;;`,
          );
          if (boundary === "claim" || boundary === "last-uninstall")
            stub = stub.replace(
              "  is-enabled) [",
              `  is-enabled) ${handoff}; [`,
            );
          if (boundary === "show" || boundary === "reload")
            stub = stub.replace(
              "  show) exec",
              `  show)
 if [ "$4" = dev.neuve.worker.service ]${boundary === "reload" ? ' && [ ! -f "$XDG_CONFIG_HOME/systemd/user/dev.neuve.worker.service" ] && [ ! -f "$XDG_CONFIG_HOME/systemd/user/dev.neuve.worker.timer" ]' : ""}; then
  "$NEUVE_SYSTEMD_BUN" --no-env-file "$NEUVE_SYSTEMD_SHOW" "$@" >"$NEUVE_SYSTEMD_STATE/captured-\${NEUVE_HANDOFF_ARMED:-0}"
  ${handoff}
  cat "$NEUVE_SYSTEMD_STATE/captured-\${NEUVE_HANDOFF_ARMED:-0}"; exit 0
 fi
 exec`,
            );
          if (boundary === "stop")
            stub = stub.replace(
              '  stop) rm -f "$NEUVE_SYSTEMD_STATE/active" ;;',
              `  stop) rm -f "$NEUVE_SYSTEMD_STATE/active"; ${handoff} ;;`,
            );
          if (boundary === "disable" || boundary === "uninstall")
            stub = stub.replace(
              '    if [ "${2:-}" = --now ]; then rm -f "$NEUVE_SYSTEMD_STATE/active"; fi ;;',
              `    if [ "\${2:-}" = --now ]; then rm -f "$NEUVE_SYSTEMD_STATE/active"; fi; ${handoff} ;;`,
            );
          await writeFile(wrapper, stub);
          const result = await run(
            [
              shell,
              "-c",
              'exec "$NEUVE_SYSTEMD_BUN" --no-env-file "$NEUVE_HANDOFF_DRIVER" main',
            ],
            {
              ...f.env,
              NEUVE_HANDOFF_DRIVER: driver,
              NEUVE_HANDOFF_ARMED: "1",
            },
          );
          expect(
            await exists(join(f.state, "swapped")),
            result.stdout + result.stderr,
          ).toBe(true);
          if (boundary === "last-uninstall") {
            for (const path of [
              paths.service,
              paths.timer,
              join(f.state, "enabled"),
              join(f.state, "active"),
            ])
              expect(await exists(path)).toBe(false);
            return;
          }
          expect(
            (await readdir(paths.directory)).filter((name) =>
              name.startsWith(".neuve-worker-"),
            ),
          ).toEqual([]);
          expect(await readFile(paths.service, "utf8")).toBe(
            agentService(other),
          );
          expect(await readFile(paths.timer, "utf8")).toBe(agentTimer());
          expect(
            await readFile(join(f.state, "dev.neuve.worker.service"), "utf8"),
          ).toBe(agentService(other));
          expect(
            await readFile(join(f.state, "dev.neuve.worker.timer"), "utf8"),
          ).toBe(agentTimer());
          expect(await exists(join(f.state, "enabled"))).toBe(true);
          expect(await exists(join(f.state, "active"))).toBe(true);
          if (other !== command)
            expect(result.stdout + result.stderr).toContain(
              join(f.home, last!),
            );
          expect(result.stderr).not.toContain("ENOENT");
        } finally {
          await f.close();
        }
      }, 30_000);

// The other allowed terminal state is a completed uninstall, with no registration.
for (const shell of ["sh", "dash"].filter((shell) => Bun.which(shell)))
  test(`last uninstall leaves no agent: ${shell}`, async () => {
    const f = await systemdFixture();
    try {
      const command = join(f.home, "A/bin/neuve"),
        paths = agentUnitPaths(f.home, f.env.XDG_CONFIG_HOME);
      const driver = join(f.directory, "remove.ts");
      await mkdir(join(f.home, "A"), { recursive: true });
      await writeFile(
        driver,
        `import * as S from ${JSON.stringify(modulePath)};
const options={command:${JSON.stringify(command)},load:true};
console.log(await S.installAgent(options)); console.log(await S.uninstallAgent(options));`,
      );
      const result = await run(
        [
          shell,
          "-c",
          'exec "$NEUVE_SYSTEMD_BUN" --no-env-file "$NEUVE_HANDOFF_DRIVER"',
        ],
        { ...f.env, NEUVE_HANDOFF_DRIVER: driver },
      );
      expect(result, result.stdout + result.stderr).toMatchObject({ code: 0 });
      for (const path of [
        paths.service,
        paths.timer,
        join(f.state, "enabled"),
        join(f.state, "active"),
      ])
        expect(await exists(path)).toBe(false);
    } finally {
      await f.close();
    }
  }, 30_000);
