// The CLI's receipt must pass the actual host parser, not just a URL-format assertion.
import "./fixtures/memory-secrets";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aceReviewDestination } from "../../neuve-cli/src/workspace-review-links";
import { configure, bindConfiguredCatalog } from "../src/host-config";
import { configureRuntime, runtimeHooks } from "../src/runtime-hooks";
import { dispatchGateway } from "../src/gateway-extensions";
import * as catalog from "../src/catalog";

test("CLI coding-origin receipts pass host review-link and GitHub history receipt parsing", async () => {
	const root = await mkdtemp(join(tmpdir(), "review-receipts-"));
	const previous = runtimeHooks();
	try {
		for (const name of ["home", "lanes", "project"]) await mkdir(join(root, name));
		const project = join(root, "project");
		const git = (...args: string[]) => {
			const result = Bun.spawnSync(["git", "-C", project, ...args], { stdout: "pipe", stderr: "pipe" });
			if (result.exitCode) throw new Error(result.stderr.toString());
		};
		git("init", "-q");
		git("remote", "add", "origin", "https://github.com/fixture/project.git");
		const config = configure({ home: join(root, "home"), lanes: join(root, "lanes"), user: "owner", port: 0, environment: { PATH: process.env.PATH ?? "" }, worker: [process.execPath] });
		await bindConfiguredCatalog();
		const channel = catalog.create(project);
		const reference = "01K90000000000000000000000";
		const coding = "http://127.0.0.1:4141/";
		const back = `${coding}?channel=${channel.id}#channels`;
		const receipt = { reference, url: aceReviewDestination(coding, project, reference, back) };
		configureRuntime({ host: { config, models: () => [], reviewHistory: async () => [receipt] } });
		const owner = { user: "owner", local: true, peer: false };
		const unused = async (): Promise<never> => { throw new Error("History must not open a worker or native operation"); };
		const link = await dispatchGateway(owner, { op: "review-link", channel: channel.id }, "receipt", unused, unused);
		expect(link).toEqual(receipt);
		expect(new URL(receipt.url).origin).toBe("http://127.0.0.1:4141");
		expect(new URL(receipt.url).searchParams.get("returnTo")).toBe(back);
		const item = { provider: "github", repo: "fixture/project", kind: "pull-request", number: 1, url: "https://github.com/fixture/project/pull/1" } satisfies import("../src/extension-protocol").GitHubExternalRef;
		expect(await dispatchGateway(owner, { op: "reviews", project, item }, "receipt", unused, unused)).toEqual([receipt]);
	} finally {
		configureRuntime({ ...previous, host: previous.host });
		await rm(root, { recursive: true, force: true });
	}
});
