import "./fixtures/memory-secrets";
import {expect, test} from "bun:test";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {configure, bindConfiguredCatalog} from "../src/host-config";
import {configureRuntime} from "../src/runtime-hooks";
import {dispatchGateway} from "../src/gateway-extensions";
import * as catalog from "../src/catalog";
import type {HostRequest} from "../src/protocol";

test("plain nonlocal native creation retains native authorization and result", async () => {
	const root = await mkdtemp(join(tmpdir(), "dispatch-"));
	try {
		for (const name of ["home", "lanes", "project"]) await mkdir(join(root, name));
		const project = join(root, "project");
		const git = (...args: string[]) => {
			const result = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-C", project, ...args]);
			if (result.exitCode) throw new Error(result.stderr.toString());
		};
		git("init", "-q", "-b", "main"); await writeFile(join(project, "a"), "a"); git("add", "a"); git("commit", "-qm", "fixture");
		const config = configure({home: join(root, "home"), lanes: join(root, "lanes"), user: "owner", port: 0, environment: {PATH: process.env.PATH || ""}, worker: [process.execPath]});
		await bindConfiguredCatalog();
		configureRuntime({host: {config, models: () => []}});
		const calls: HostRequest[] = [];
		const native = async (request: HostRequest) => {
			calls.push(request);
			if (request.op !== "create") throw new Error("unexpected native request");
			return catalog.create(project, request.model, request.name);
		};
		const connection = async (): Promise<never> => {throw new Error("no worker is needed for plain admission");};
		const owner = {user: "owner", local: false, peer: false};
		const created = await dispatchGateway(owner, {op: "create", project, name: "native"}, "test", connection, native);
		expect(calls).toEqual([{op: "create", project, name: "native"}]);
		expect(created).toMatchObject({owner: "owner", project});
		expect(catalog.read(catalog.find("native").id).lane).toBeUndefined();
		await expect(dispatchGateway({...owner, peer: true}, {op: "create", project}, "test", connection, async () => {throw new Error("native peer refusal");})).rejects.toThrow("native peer refusal");
		await expect(dispatchGateway(owner, {op: "create", project, lane: {name: "work", path: "/not-used"}}, "test", connection, native)).rejects.toThrow("authenticated local owner");
		const cloud = {nativeCloud: true};
		expect(await dispatchGateway(owner, {op: "create", project, cloud: true}, "test", connection, async () => cloud)).toBe(cloud);
		expect(calls).toHaveLength(1);
	} finally {await rm(root, {recursive: true, force: true});}
});
