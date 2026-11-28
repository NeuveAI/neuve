import "./fixtures/memory-secrets";
import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdtemp,
	mkdir,
	realpath,
	rm,
	writeFile,
	readFile,
} from "node:fs/promises";
import { join } from "node:path";
import { testTemporaryDirectory as tmpdir } from "./fixtures/temporary.ts";
import { configure } from "../src/host-config";
import { computeSettings } from "../src/compute";
import { parseHostEnvelope, parseHostFrame } from "../src/parse";
import { parseDescriptor, remote } from "../src/review-github";
import * as projects from "../src/projects";
import * as preferences from "../src/preferences";
import { channelProject, checkoutId, projectId } from "../src/protocol";
import { acquirePull } from "../src/review";
import { setLanePreferences, settings } from "../src/settings";
import raw from "./fixtures/github-pr-711.json";

const paths: string[] = [];
const env = Object.fromEntries(
	Object.entries(process.env).filter(
		(entry): entry is [string, string] => entry[1] !== undefined,
	),
);
function git(cwd: string, ...args: string[]) {
	const value = Bun.spawnSync(
		[
			"git",
			"-c",
			"user.name=Neuve test",
			"-c",
			"user.email=test@neuve.invalid",
			"-C",
			cwd,
			...args,
		],
		{ env, stdout: "pipe", stderr: "pipe" },
	);
	if (value.exitCode !== 0) throw new Error(value.stderr.toString());
	return value.stdout.toString().trim();
}
async function place() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "app-host-")));
	paths.push(root);
	const home = join(root, "state"),
		lanes = join(root, "lanes"),
		project = join(root, "checkout");
	await Promise.all([mkdir(home), mkdir(lanes), mkdir(project)]);
	configure({
		home,
		lanes,
		volume: root,
		projects: root,
		user: "owner",
		port: 0,
		environment: { ...env, ACE_CONFIG_HOME: join(home, "settings") },
		worker: [process.execPath],
	});
	return { root, home, lanes, project };
}
afterEach(async () => {
	for (const path of paths.splice(0))
		await rm(path, { recursive: true, force: true });
});

describe("Ace application host boundaries", () => {
	test("real GitHub CLI PR711 response preserves repository identities and immutable OIDs", () => {
		const value = parseDescriptor(
			raw,
			"githubnext/ace",
			"2026-10-30T12:00:00.000Z",
		);
		expect({
			repo: value.repo,
			number: value.number,
			baseRepo: value.baseRepo,
			headRepo: value.headRepo,
			base: value.baseOid,
			head: value.headOid,
			files: value.files,
		}).toEqual({
			repo: "githubnext/ace",
			number: 711,
			baseRepo: "githubnext/ace",
			headRepo: "githubnext/ace",
			base: "d03deaeaafd896049e5e66c3a1a3d47f7fe9ac91",
			head: "0f4093b0382f4b0af14efbf0965c93de310a5eaf",
			files: 12,
		});
		expect(() =>
			parseDescriptor(
				{ ...raw, head: { ...raw.head, repo: null } },
				"githubnext/ace",
			),
		).toThrow("head repository is unavailable");
		expect(() =>
			parseDescriptor(
				{ ...raw, head: { ...raw.head, sha: "main" } },
				"githubnext/ace",
			),
		).toThrow();
	});
	test("strict requests retain GitHub origin and reject forged native associations and invalid limits", () => {
		const request = parseHostEnvelope(
			JSON.stringify({
				id: 7,
				op: "create",
				project: "/project",
				items: [
					{
						provider: "github",
						repo: "githubnext/ace",
						kind: "pull-request",
						number: 711,
						url: "https://github.com/githubnext/ace/pull/711",
					},
				],
			}),
			"owner",
		);
		expect(request).toEqual({
			id: 7,
			op: "create",
			project: "/project",
			items: [
				{
					provider: "github",
					repo: "githubnext/ace",
					kind: "pull-request",
					number: 711,
					url: "https://github.com/githubnext/ace/pull/711",
				},
			],
		});
		expect(() =>
			parseHostEnvelope(
				JSON.stringify({
					id: 8,
					op: "github-list",
					repo: "githubnext/ace",
					kind: "prs",
					state: "open",
					search: "",
					limit: 1001,
				}),
				"owner",
			),
		).toThrow();
		expect(() =>
			parseHostEnvelope(
				JSON.stringify({
					id: 9,
					op: "create",
					project: "/project",
					items: [
						{
							provider: "github",
							repo: "githubnext/ace",
							kind: "pull-request",
							number: 711,
							url: "https://example.com/pull/711",
						},
					],
				}),
				"owner",
			),
		).toThrow();
		expect(parseHostEnvelope(JSON.stringify({ id: 10, op: "team-deploy" }), "owner")).toEqual({id: 10, op: "team-deploy"});
	});
	test("history selectors preserve channel and item shapes and refuse mixed or missing selectors", () => {
		const item: import("@neuve/records-schema").GitHubExternalRef = { provider: "github", repo: "githubnext/ace", kind: "issue", number: 1, url: "https://github.com/githubnext/ace/issues/1" };
		expect(parseHostEnvelope(JSON.stringify({ id: 1, op: "reviews", channel: "channel", chat: 2 }), "owner")).toEqual({ id: 1, op: "reviews", channel: "channel", chat: 2 });
		expect(parseHostEnvelope(JSON.stringify({ id: 2, op: "reviews", project: "/project", item }), "owner")).toEqual({ id: 2, op: "reviews", project: "/project", item });
		for (const value of [{op:"reviews"},{op:"reviews",project:"/project"},{op:"reviews",item},{op:"reviews",channel:"channel",project:"/project",item},{op:"reviews",project:"/project",item,chat:2},{op:"reviews",project:"/project",item:{...item,url:"https://example.com/issues/1"}}]) {
			expect(()=>parseHostEnvelope(JSON.stringify({id:3,...value}),"owner")).toThrow();
		}
	});
	test("new folders initialize with a real commit and existing ignore files remain untouched", async () => {
		const at = await place();
		await projects.open(at.project);
		git(at.project, "init", "-q", "-b", "main");
		git(at.project, "config", "user.name", "Neuve test");
		git(at.project, "config", "user.email", "test@neuve.invalid");
		await writeFile(join(at.project, "README.md"), "actual project\n");
		const initialized = await projects.init(at.project);
		expect(initialized.path).toBe(at.project);
		expect(initialized.git).toBeUndefined();
		expect(git(at.project, "show", "HEAD:README.md")).toBe("actual project");
		git(
			at.project,
			"remote",
			"add",
			"origin",
			"https://github.com/githubnext/ace.git",
		);
		expect(await (await import("../src/review-projects")).repository(at.project)).toBe("githubnext/ace");
		const found = await projects.setup("githubnext/ace", at.project);
		expect({ repo: found.repo, found: found.found }).toEqual({
			repo: "githubnext/ace",
			found: true,
		});
		const child = join(at.root, "linked");
		git(at.project, "worktree", "add", "-q", "-b", "child", child);
		expect((await projects.open(child)).path).toBe(at.project);
		const ignored = join(at.root, "ignored");
		await mkdir(ignored);
		await writeFile(join(ignored, ".gitignore"), "private\n");
		await projects.open(ignored);
		await expect(projects.init(ignored)).rejects.toThrow(
			"already has a .gitignore",
		);
		expect(await readFile(join(ignored, ".gitignore"), "utf8")).toBe(
			"private\n",
		);
	});
	test("Neuve project boundary refuses internal storage before write admission", async () => {
		const at = await place();
		const own = await import("../src/review-projects");
		expect(() => own.validatePath("/private/tmp")).toThrow("configured storage volume");
		expect(() => own.validatePath(at.home)).toThrow("host's state");
		own.validatePath(at.project);
	});
	test("PR source acquisition uses exact objects without replacing checkout HEAD", async () => {
		const at = await place();
		git(at.project, "init", "-q", "-b", "main");
		await writeFile(join(at.project, "a"), "base\n");
		git(at.project, "add", "a");
		git(at.project, "commit", "-qm", "base");
		const base = git(at.project, "rev-parse", "HEAD");
		await writeFile(join(at.project, "a"), "head\n");
		git(at.project, "commit", "-qam", "head");
		const head = git(at.project, "rev-parse", "HEAD");
		git(at.project, "reset", "--hard", base);
		git(
			at.project,
			"remote",
			"add",
			"origin",
			"https://github.com/githubnext/ace.git",
		);
		const source = {
			...parseDescriptor(raw, "githubnext/ace"),
			baseOid: base,
			headOid: head,
		};
		expect(await acquirePull(at.project, source)).toEqual({ base, head });
		expect(git(at.project, "rev-parse", "HEAD")).toBe(base);
		await expect(
			acquirePull(at.project, {
				...source,
				baseRepo: "another/repository",
				headRepo: "another/fork",
			}),
		).rejects.toThrow("does not match");
	});
	test("preferences persist model, project folder, compute and work lane settings together", async () => {
		const at = await place();
		preferences.savePreference({provider: "openai", modelId: "actual-model"});
		preferences.saveFolder(at.root);
		preferences.saveCompute({enabled: true, url: "https://owned-fixture.invalid"});
		const custom = join(at.root, "custom-lanes");
		await mkdir(custom);
		const update = {op: "preferences", lanesFolder: custom, branchPrefix: "ace.Team-1"};
		const request = parseHostEnvelope(JSON.stringify({id: 1, ...update}), "owner");
		expect(request).toEqual({id: 1, ...update});
		if (request.op !== "preferences") throw new Error("Expected a preferences request");
		await setLanePreferences(request);
		expect(await settings()).toMatchObject({lanesFolder: custom, branchPrefix: "ace.Team-1"});
		expect(preferences.preference()).toEqual({provider: "openai", modelId: "actual-model"});
		expect(preferences.folder()).toBe(at.root);
		expect(computeSettings()).toEqual({enabled: true, url: "https://owned-fixture.invalid"});
		await setLanePreferences({lanesFolder: "", branchPrefix: ""});
		expect(await settings()).toMatchObject({lanesFolder: at.lanes, branchPrefix: ""});
	});
	test("canonical project IDs join checkouts and frame parsing retains repository metadata", () => {
		expect(
			remote("remote.origin.url git@github.com:Example/Project.git\n"),
		).toBe("example/project");
		expect(projectId("host", "/first", "Example/Project")).toBe(
			"github:example/project",
		);
		expect(checkoutId("host", "/first")).toBe('["host","/first"]');
		expect(
			channelProject({
				host: "host",
				project: "/lane",
				root: "/main",
				repo: "Example/Project",
			}),
		).toBe("github:example/project");
		expect(
			parseHostFrame(
				JSON.stringify({
					projects: [
						{
							path: "/main",
							name: "project",
							repo: "example/project",
							git: false,
							empty: true,
							ignored: true,
						},
					],
				}),
			),
		).toEqual({
			projects: [
				{
					path: "/main",
					name: "project",
					repo: "example/project",
					git: false,
					empty: true,
					ignored: true,
				},
			],
		});
	});
});
