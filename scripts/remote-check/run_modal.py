"""Modal transport for check:remote. No secrets, volumes, or host environment forwarded."""
import asyncio
import json
import os
import re
import sys
import time
from pathlib import Path

import certifi
os.environ.setdefault("SSL_CERT_FILE", certifi.where())
import modal

BUN_IMAGE = "oven/bun:1.4.4-debian@sha256:93d5032fe06d163427822dc1598f420363759bb18155c9cc90eb1be05a64a19e"
CHECK_CPU = 4
NATIVE_THREAD_ENV = {"ROLLDOWN_WORKER_THREADS": str(CHECK_CPU), "RAYON_NUM_THREADS": str(CHECK_CPU)}


def counts(log, name):
    return sum(map(int, re.findall(r"^\s*(\d+) " + name + r"\s*$", log, re.M)))


def failed(part, error):
    return {**part, "location": "modal", "exitCode": 1, "error": str(error) or type(error).__name__,
            "pass": 0, "fail": 1, "skip": 0}


async def capture(stream, path):
    chunks = []
    with path.open("w") as log:
        async for chunk in stream:
            log.write(chunk)
            log.flush()
            chunks.append(chunk)
    return "".join(chunks)


async def main():
    archive, plan_file, output, builder, checker = map(Path, sys.argv[1:])
    plan = json.loads(plan_file.read_text())
    output.mkdir(parents=True, exist_ok=True)
    image = (modal.Image.from_registry(BUN_IMAGE, add_python="3.12")
        .apt_install("git", "openssl", "build-essential", "procps", "util-linux", "passwd")
        .run_commands("rmdir /usr/share/git-core/templates/branches")
        .add_local_file(archive, "/tmp/source.tar", copy=True)
        .run_commands("mkdir -p /workspace && tar -xf /tmp/source.tar -C /workspace && rm /tmp/source.tar")
        .workdir("/workspace")
        .env({**NATIVE_THREAD_ENV, "NEUVE_MODE": "check", "HOME": "/tmp/check-home", "TMPDIR": "/tmp/check-tmp", "BUN_RUNTIME_TRANSPILER_CACHE_PATH": "/tmp/check-cache/transpiler", "CI": "1"})
        # Tests need a Git checkout. Its metadata is created here, never uploaded from the Mac.
        .run_commands("mkdir -p /tmp/check-home /tmp/check-tmp /tmp/check-cache", "git init -q", "git add -f .",
                      "git -c user.name=check -c user.email=check@example.invalid commit -qm 'Tracked source snapshot'",
                      "bun --no-env-file install --frozen-lockfile")
        .add_local_file(builder, "/workspace/.remote-build-types.ts", copy=True)
        .run_commands("bun --no-env-file ./.remote-build-types.ts && rm .remote-build-types.ts",
                      "cd apps/neuve-web/packages/diffs && bun --no-env-file node_modules/typescript/bin/tsc -p tsconfig.build.json")
        .add_local_file(checker, "/workspace/.remote-check-ace.ts", copy=True)
        .run_commands("printf '/.remote-*.ts\\n' >> .git/info/exclude",
                      "test -z \"$(git status --porcelain)\"",
                      "useradd --uid 1100 --no-create-home checker",
                      "chown -R checker:checker /workspace /tmp/check-home /tmp/check-tmp /tmp/check-cache"))
    app = modal.App("neuve-repo-check")
    results = {}

    async def run(part):
        started = time.monotonic()
        sandbox = None
        try:
            sandbox = await modal.Sandbox.create.aio("sleep", "infinity", app=app,
                image=image, timeout=3600, cpu=CHECK_CPU, memory=8192, secrets=[],
                block_network=True, workdir="/workspace",
                env={**NATIVE_THREAD_ENV, "NEUVE_MODE": "check", "HOME": "/tmp/check-home", "TMPDIR": "/tmp/check-tmp", "BUN_RUNTIME_TRANSPILER_CACHE_PATH": "/tmp/check-cache/transpiler", "CI": "1"})
            setup = await sandbox.exec.aio("chmod", "1777", "/tmp")
            if await setup.wait.aio() != 0:
                raise RuntimeError("Could not prepare sandbox temporary directory")
            process = await sandbox.exec.aio("runuser", "-u", "checker", "--", "env",
                "HOME=/tmp/check-home", "TMPDIR=/tmp/check-tmp", "NEUVE_MODE=check", *part["command"],
                workdir="/workspace/" + part["cwd"], timeout=3300)
            stdout, stderr, code = await asyncio.wait_for(asyncio.gather(
                capture(process.stdout, output / (part["id"] + ".stdout.log")),
                capture(process.stderr, output / (part["id"] + ".stderr.log")), process.wait.aio()), timeout=3320)
            log = stdout + stderr
            result = {**part, "location": "modal", "exitCode": code,
                "sandbox": sandbox.object_id, "seconds": round(time.monotonic()-started, 2),
                "pass": counts(log, "pass"), "fail": counts(log, "fail"), "skip": counts(log, "skip")}
            if result["pass"] == 0 and result["fail"] == 0:
                result["pass"] = int(code == 0)
                result["fail"] = int(code != 0)
            (output / (part["id"] + ".log")).write_text(log)
        except Exception as error:
            result = failed(part, error)
        finally:
            if sandbox:
                try:
                    await asyncio.wait_for(sandbox.terminate.aio(), timeout=30)
                except Exception as error:
                    result = failed(part, error)
        results[part["id"]] = result
        (output / (part["id"] + ".json")).write_text(json.dumps(result, indent=2)+"\n")
        print(f'{part["id"]}: {"PASS" if result["exitCode"] == 0 else "FAIL"} '
              f'({result["pass"]} pass, {result["fail"]} fail, {result["skip"]} skip)', flush=True)

    try:
        with modal.enable_output():
            async with app.run():
                await image.build.aio(app)
                (output / "image.json").write_text(json.dumps({
                    "id": image.object_id, "base": BUN_IMAGE, "network": "blocked",
                    "secrets": [], "volumes": [], "gitMetadata": "generated from tracked source; no original history",
                    "user": "checker", "cpu": CHECK_CPU, "nativeThreadEnvironment": NATIVE_THREAD_ENV, "gitTemplates": "empty branches directory omitted to match the Mac"
                }, indent=2)+"\n")
                await asyncio.gather(*(run(part) for part in plan))
    except Exception as error:
        for part in plan:
            if part["id"] not in results:
                results[part["id"]] = failed(part, error)
        (output / "image.json").write_text(json.dumps({"base": BUN_IMAGE, "error": str(error)})+"\n")
    ordered = [results[part["id"]] for part in plan]
    (output / "remote.json").write_text(json.dumps(ordered, indent=2)+"\n")
    return int(any(r["exitCode"] != 0 for r in ordered))


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
