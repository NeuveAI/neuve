import "./fixtures/memory-secrets";
import {expect, test} from "bun:test";
import {readFileSync} from "node:fs";
import {HostRequestSchema, NativeHostRequestSchema, parseHostEnvelope, parseWorkerEnvelope} from "../src/parse";
import {parseHostFrame} from "../src/host-frame";
import {RequestSchema} from "../../../packages/channel/src/parse";
import {externalRef, githubRef} from "../src/external-ref";

// The closed protocol and actual schema must converge when upstream adds another operation.
test("every original native host and channel operation has an ingress parser", () => {
	const host = readFileSync(new URL("../src/protocol.ts", import.meta.url), "utf8").split("export type HostRequest =")[1]!.split("export type HostEnvelope")[0]!;
	const operations = [...host.matchAll(/op: "([^"]+)"/g)].map((match) => match[1]);
	expect(new Set(NativeHostRequestSchema.options.map((option) => option.shape.op.value))).toEqual(new Set(operations));
	const channel = readFileSync(new URL("../../../packages/channel/src/protocol.ts", import.meta.url), "utf8").split("export type Request =")[1]!.split("export type Envelope")[0]!;
	expect(new Set(RequestSchema.options.map((option) => ("in" in option ? option.in : option).shape.op.value))).toEqual(new Set([...channel.matchAll(/op: "([^"]+)"/g)].map((match) => match[1])));
});

test("complete browser windows and original team, directory, provider, move and worker frames pass", () => {
	const value = {channel: {id: "abcd", name: "coding"}, focused: false, tabs: ["blank", "chat", "diff", "terminal", "live"].map((type) => ({id: type, name: type, type, active: type === "chat"}))};
	const requests = [
		{op: "window", value}, {op: "window", value: null}, {op: "windows"},
		{op: "tab-result", call: "c", result: {ok: true, value}},
		{op: "tab-result", call: "c", result: {ok: false, error: "closed"}},
		{op: "team-invite"}, {op: "team-roster"}, {op: "team-ask", host: "host"}, {op: "team-answer", ask: "a", approve: false},
		{op: "directory-set", url: null}, {op: "directory-set", url: "http://owned.invalid", secret: "synthetic"}, {op: "directory-serve", serve: false},
		{op: "key-set", provider: "openai", value: "synthetic"}, {op: "key-check", provider: "anthropic"}, {op: "key-forget", name: "ACE_SECRET"},
		{op: "project-access", project: "p"}, {op: "project-share", project: "p", person: "*", shared: true},
		{op: "move-targets", channel: "c"}, {op: "move", channel: "c", target: "local"}, {op: "compute-start", channel: "c"},
	];
	for (const request of requests) expect(parseHostEnvelope(JSON.stringify({id: 7, ...request}), "owner")).toEqual({id: 7, ...request});
	for (const op of ["worker", "freeze", "export"]) expect(parseWorkerEnvelope(JSON.stringify({id: 2, op}))).toEqual({id: 2, op});
	expect(parseWorkerEnvelope(JSON.stringify({id: 1, op: "watch", captions: true, progress: true, stops: true, queue: true, actions: true, typing: true, agent: true}))).toMatchObject({op: "watch", stops: true});
	expect(parseHostFrame(JSON.stringify({id: 1, event: {kind: "metadata", chat: 1, name: "old", summary: "", revision: 0}}))).toMatchObject({event: {name: "old"}});
	expect(parseHostFrame(JSON.stringify({channels: [{id: "c", host: "h", name: "old", owner: "o", project: "/p", created: 1, state: "dormant"}]}))).toMatchObject({channels: [{name: "old"}]});
	for (const invalid of [{op: "window", value: {...value, tabs: [{id: "bad", name: "bad", type: "invented", active: true}]}}, {op: "key-check", provider: "unknown"}, {op: "tab-result", call: "c", result: {ok: true}}]) expect(HostRequestSchema.safeParse(invalid).success).toBe(false);
});

test("opaque refs round-trip with precise host validation while legacy document values retain their encoding", () => {
	const legacy = {provider: "github", repo: "githubnext/ace", kind: "pull-request", number: 711, url: "https://github.com/githubnext/ace/pull/711"} as const;
	expect(githubRef(legacy)).toEqual(legacy);
	expect(githubRef(externalRef(legacy))).toEqual(legacy);
	expect(() => githubRef({...legacy, url: "https://github.com/githubnext/ace/pull/712"})).toThrow();
	expect(() => githubRef({provider: "github", id: "unversioned"})).toThrow("Unknown GitHub reference encoding");
});
