// Why (NEU-148): the readings' cost cuts go live only if quality holds, and this gate is what says
// it holds. A catch level read wrongly (a refuted claim, one the verdict does not rest on, or a
// finder's finding counted as the readings') passes a variant that lost its catches; a plant that
// turns undecided or waiting in the candidate must count as not caught, or a candidate with no
// catches passes; a plant section in an agent lane with no standing request is the one failure that
// matters most, so it is counted on its own line; a valid row the schemas refuse loses a whole run;
// a table that reads runs by index prints numbers under the wrong labels. The real rows below are the
// readers lane's own writer's (`collect.ts` at `codex/neu148-readers-int` 89dc511b, through its
// `readings-probe.test.ts`, run log dumped by the round 5 review); the hand-built rows copy their
// shapes for cases the dump does not hold. No live model.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Plant,
  SetVariant,
} from "../src/harness-compare/full-test/finders-gate.ts";
import {
  useFloorsOf,
  useRecordedLane,
} from "../src/harness-compare/full-test/lanes-eval.ts";
import {
  compareProbeRuns,
  FORM_NOT_RECORDED,
  GAP_KIND_NOT_RECORDED,
  IDENTITY_FAILED,
  identityOfRows,
  laneRuleLine,
  laneWithoutCodeGaps,
  MANIFEST_LACKS_LINES,
  NO_MANIFEST_GIVEN,
  REUSED_TIME,
  NAMING_NOT_MEASURABLE,
  NO_FAMILY_MARK,
  packageLaneRule,
  probeCounts,
  probeFolder,
  readProbeRows,
  scorePlantReadings,
  scoreProbeRun,
  type SectionRow,
  unknownGapKind,
  UnreadableProbe,
  useLaneRuleFile,
} from "../src/harness-compare/full-test/readings-gate.ts";
import { table } from "../src/harness-compare/full-test/readings-gate-cli.ts";

/** `collect.jsonl`: the readers lane's own writer's rows (`readings-probe.test.ts` at 40196b18, its run log dumped). */
const REAL_COLLECT = [
  '{"at":"2026-11-12T10:09:30.729Z","type":"reading.call","kind":"assess","group":"rg_2a2333ce57eb2840","part":"read","sections":null,"rank":750002,"characters":null,"source":null,"run":"not-started","key":null,"outputTokens":null,"reasoningTokens":null,"classes":null,"outside":null,"decision":"02cb5d767546be6e1b8b99557e7b9453809ada202b52331b0c3aa1acba2d8ac8"}',
  '{"at":"2026-11-12T10:09:30.729Z","type":"reading.call","kind":"lane-review","group":"rg_2a2333ce57eb2840","part":"read","sections":null,"rank":750002,"characters":null,"source":null,"run":"interrupted","key":null,"outputTokens":null,"reasoningTokens":null,"classes":null,"outside":null,"problems":null,"decision":"02cb5d767546be6e1b8b99557e7b9453809ada202b52331b0c3aa1acba2d8ac8"}',
  '{"at":"2026-11-12T10:09:30.729Z","type":"reading.call","kind":"assess","group":"rg_bc3d183ee2506457","part":"read","sections":4,"rank":870004,"characters":333,"source":"agent","run":"ran","key":"b388863bd5834d8574c939282f989cc13d87c4d0dbe5ab89a36c6459fef1057a","outputTokens":240,"reasoningTokens":60,"classes":2,"outside":2,"problems":{"first":{"missing-row":1,"unknown-cite":1},"given":{"missing-row":1},"repaired":{"missing-row":1}},"decision":"02cb5d767546be6e1b8b99557e7b9453809ada202b52331b0c3aa1acba2d8ac8"}',
  '{"at":"2026-11-12T10:09:30.729Z","type":"reading.call","kind":"assess","group":"rg_bc3d183ee2506457","part":"reread","sections":null,"rank":870004,"characters":null,"source":null,"run":"failed","key":null,"outputTokens":null,"reasoningTokens":null,"classes":null,"outside":null,"problems":null,"failure":"invalid_request","decision":"02cb5d767546be6e1b8b99557e7b9453809ada202b52331b0c3aa1acba2d8ac8"}',
  '{"at":"2026-11-12T10:09:30.729Z","type":"reading.call","kind":"lane-review","group":"rg_bc3d183ee2506457","part":"read","sections":4,"rank":870004,"characters":707,"source":"agent","run":"ran","key":"83092e7821e9b491356068f1833e467cff156271a3f91f9324cf472128ea8c2c","outputTokens":180,"reasoningTokens":null,"classes":null,"outside":2,"problems":{"first":{},"given":{},"repaired":{}},"decision":"02cb5d767546be6e1b8b99557e7b9453809ada202b52331b0c3aa1acba2d8ac8"}',
  '{"at":"2026-11-12T10:09:30.729Z","type":"reading.call","kind":"verify-claim","group":"rg_bc3d183ee2506457","part":"claim","sections":1,"rank":870004,"characters":72,"source":"agent","run":"ran","key":"26d13a2d885c802cefb0593c33fb946f59ddf780a2b0b5b9a021186a31ba43c4","outputTokens":null,"reasoningTokens":null,"classes":null,"outside":null,"problems":null,"decision":"02cb5d767546be6e1b8b99557e7b9453809ada202b52331b0c3aa1acba2d8ac8"}',
  '{"at":"2026-11-12T10:09:30.729Z","type":"reading.section","decision":"02cb5d767546be6e1b8b99557e7b9453809ada202b52331b0c3aa1acba2d8ac8","section":"7c381039ec5332cfcadb5cd79e040f1a01c6a79bb883c8af0068ce19c209d7ea","path":"docs/guide.md","owned":["docs/guide.md:new:7","docs/guide.md:old:7"],"group":"rg_2a2333ce57eb2840","state":"waiting","lane":null,"floorInputs":null,"verdict":null,"cause":"not-reached","reading":"assess","comments":{"shown":0,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T10:09:30.729Z","type":"reading.section","decision":"02cb5d767546be6e1b8b99557e7b9453809ada202b52331b0c3aa1acba2d8ac8","section":"e4fb515e47429add33522e8b6eea42097f72e7fe32ce51f01d04c2455a7cd1e1","path":"notes.txt","owned":["notes.txt:new:4","notes.txt:old:4"],"group":"rg_2a2333ce57eb2840","state":"waiting","lane":null,"floorInputs":null,"verdict":null,"cause":"not-reached","reading":"assess","comments":{"shown":0,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T10:09:30.729Z","type":"reading.section","decision":"02cb5d767546be6e1b8b99557e7b9453809ada202b52331b0c3aa1acba2d8ac8","section":"96e9bfc2c6cfb080d3f0aae5b1dee25405d2148249e35083df5191d11c82610e","path":"src/old.ts","owned":["src/old.ts:old:4-6"],"group":"rg_bc3d183ee2506457","state":"settled","lane":{"judged":"human-suggested","surfaced":"human-suggested","floors":[],"applied":"human-suggested"},"floorInputs":{"facts":{"removesDeclaration":false,"removesPublicName":false,"effects":["removed"]},"options":{"removal":false}},"verdict":"approve","cause":null,"reading":null,"comments":{"shown":1,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T10:09:30.730Z","type":"reading.section","decision":"02cb5d767546be6e1b8b99557e7b9453809ada202b52331b0c3aa1acba2d8ac8","section":"746bc524002c7e7744146c97f777457293c3e8679296335f41f9e63e6fdb2275","path":"src/parse.test.ts","owned":["src/parse.test.ts:new:4-6"],"group":"rg_bc3d183ee2506457","state":"settled","lane":{"judged":null,"surfaced":null,"floors":[],"applied":"human-required"},"floorInputs":{"facts":{"removesDeclaration":false,"removesPublicName":false,"effects":[]},"options":{"removal":false}},"verdict":"approve","cause":"failed","reading":"assess","comments":{"shown":0,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T10:09:30.730Z","type":"reading.section","decision":"02cb5d767546be6e1b8b99557e7b9453809ada202b52331b0c3aa1acba2d8ac8","section":"a6e849e7e8b15c0bd575ca033ff20092a2a9ab4a5578ea0f1c359bed1659cbcd","path":"src/parse.ts","owned":["src/parse.ts:new:4","src/parse.ts:old:4"],"group":"rg_bc3d183ee2506457","state":"settled","lane":{"judged":"human-suggested","surfaced":"human-suggested","floors":[],"applied":"human-suggested"},"floorInputs":{"facts":{"removesDeclaration":false,"removesPublicName":false,"effects":[]},"options":{"removal":false}},"verdict":"request-changes","cause":null,"reading":null,"comments":{"shown":1,"belowCut":0,"refuted":0,"unranked":0},"claims":[{"key":"7b0dd660a0346dd6c32ebfc0d629c62e919fd9e3c4a17cdea19ae0db1def4b16","path":"src/parse.ts","side":"new","startLine":4,"endLine":4,"source":"lane-review","verify":"confirmed","restsOn":true}],"claimFates":{"confirmed":1,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T10:09:30.730Z","type":"reading.section","decision":"02cb5d767546be6e1b8b99557e7b9453809ada202b52331b0c3aa1acba2d8ac8","section":"693f6d2fc843f4406251a8065fd6580b5a0d287c923b19a0dc341c4aa250205f","path":"src/parse.ts","owned":["src/parse.ts:new:10-13"],"group":"rg_bc3d183ee2506457","state":"settled","lane":{"judged":"human-suggested","surfaced":"human-suggested","floors":[],"applied":"human-required"},"floorInputs":{"facts":{"removesDeclaration":false,"removesPublicName":false,"effects":[]},"options":{"removal":false}},"verdict":null,"cause":"unsure","reading":"lane-review","comments":{"shown":0,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T10:09:30.730Z","type":"reading.section","decision":"02cb5d767546be6e1b8b99557e7b9453809ada202b52331b0c3aa1acba2d8ac8","section":"4d21fe5c26e99447825d610725a7847557a37515f582681f3a00a0962d86dcf7","path":"assets/logo.png","owned":[],"group":null,"state":"settled","lane":{"judged":null,"surfaced":null,"floors":[],"applied":"human-required"},"floorInputs":{"facts":{"removesDeclaration":false,"removesPublicName":false,"effects":[]},"options":{"removal":false}},"verdict":null,"cause":"unreadable","reading":"assess","comments":{"shown":0,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T10:09:30.730Z","type":"reading.section","decision":"02cb5d767546be6e1b8b99557e7b9453809ada202b52331b0c3aa1acba2d8ac8","section":"f03fc32bf6394dfd37d9265c758e330fc90fed446d3aeaba7aab0e6eb01f2d3e","path":"bun.lock","owned":["bun.lock:new:1","bun.lock:old:1"],"group":null,"state":"settled","lane":{"judged":null,"surfaced":null,"floors":[],"applied":"human-suggested"},"floorInputs":{"facts":{"removesDeclaration":false,"removesPublicName":false,"effects":[]},"options":{"removal":false}},"verdict":null,"cause":"excluded","reading":null,"comments":{"shown":0,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T10:09:30.730Z","type":"reading.section","decision":"02cb5d767546be6e1b8b99557e7b9453809ada202b52331b0c3aa1acba2d8ac8","section":"842f0b1a362068e1b34070c143b865778f63d36db3c0919df915f100ac9dd41c","path":"data/big.txt","owned":["data/big.txt:new:1-1800"],"group":null,"state":"settled","lane":{"judged":null,"surfaced":null,"floors":[],"applied":"human-required"},"floorInputs":{"facts":{"removesDeclaration":false,"removesPublicName":false,"effects":[]},"options":{"removal":false}},"verdict":null,"cause":"too-large","reading":"assess","comments":{"shown":0,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T10:09:30.730Z","type":"reading.section","decision":"02cb5d767546be6e1b8b99557e7b9453809ada202b52331b0c3aa1acba2d8ac8","section":"4ae246936a8560cc7cb613dc16111af5cf2cf77ac5a469ce04d7e1ba6c02a112","path":"scripts/run.sh","owned":[],"group":null,"state":"settled","lane":{"judged":null,"surfaced":null,"floors":[],"applied":"human-required"},"floorInputs":{"facts":{"removesDeclaration":false,"removesPublicName":false,"effects":[]},"options":{"removal":false}},"verdict":null,"cause":"unreadable","reading":"assess","comments":{"shown":0,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T10:09:30.730Z","type":"reading.section","decision":"02cb5d767546be6e1b8b99557e7b9453809ada202b52331b0c3aa1acba2d8ac8","section":"6f3ef8ceba1597ad9d5959726de2a5b9e92679e2e61fd71c2e792f3df8dc8ca2","path":"src/gen/api.ts","owned":["src/gen/api.ts:new:1","src/gen/api.ts:old:1"],"group":null,"state":"settled","lane":{"judged":null,"surfaced":null,"floors":[],"applied":"human-suggested"},"floorInputs":{"facts":{"removesDeclaration":false,"removesPublicName":false,"effects":[]},"options":{"removal":false}},"verdict":null,"cause":"excluded","reading":null,"comments":{"shown":0,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T10:09:30.730Z","type":"reading.batch","decision":"02cb5d767546be6e1b8b99557e7b9453809ada202b52331b0c3aa1acba2d8ac8","mapGroup":"m1","settled":true,"ready":true,"reason":null,"sections":{"settled":4,"waiting":{},"unread":{}},"units":4,"problems":0}',
  '{"at":"2026-11-12T10:09:30.730Z","type":"reading.batch","decision":"02cb5d767546be6e1b8b99557e7b9453809ada202b52331b0c3aa1acba2d8ac8","mapGroup":"m2","settled":false,"ready":false,"reason":"waiting","sections":{"settled":3,"waiting":{"not-reached":2},"unread":{"unreadable":2,"too-large":1}},"units":0,"problems":0}',
  '{"at":"2026-11-12T10:09:30.730Z","type":"reading.batch","decision":"02cb5d767546be6e1b8b99557e7b9453809ada202b52331b0c3aa1acba2d8ac8","mapGroup":"generated","settled":true,"ready":true,"reason":null,"sections":{"settled":2,"waiting":{},"unread":{"excluded":2}},"units":2,"problems":0}',
  '{"at":"2026-11-12T10:09:30.730Z","type":"reading.unit","decision":"02cb5d767546be6e1b8b99557e7b9453809ada202b52331b0c3aa1acba2d8ac8","mapGroup":"m1","path":"src/old.ts","lane":"human-suggested","sections":["96e9bfc2c6cfb080d3f0aae5b1dee25405d2148249e35083df5191d11c82610e"],"verdict":"approve","disposition":"approve","suggestion":false,"undecided":{},"comments":{"shown":3,"belowCut":0}}',
  '{"at":"2026-11-12T10:09:30.730Z","type":"reading.unit","decision":"02cb5d767546be6e1b8b99557e7b9453809ada202b52331b0c3aa1acba2d8ac8","mapGroup":"m1","path":"src/parse.test.ts","lane":"human-required","sections":["746bc524002c7e7744146c97f777457293c3e8679296335f41f9e63e6fdb2275"],"verdict":"approve","disposition":null,"suggestion":true,"undecided":{"failed":1},"comments":{"shown":0,"belowCut":0}}',
  '{"at":"2026-11-12T10:09:30.730Z","type":"reading.unit","decision":"02cb5d767546be6e1b8b99557e7b9453809ada202b52331b0c3aa1acba2d8ac8","mapGroup":"m1","path":"src/parse.ts","lane":"human-suggested","sections":["a6e849e7e8b15c0bd575ca033ff20092a2a9ab4a5578ea0f1c359bed1659cbcd"],"verdict":"request-changes","disposition":"request-changes","suggestion":false,"undecided":{},"comments":{"shown":1,"belowCut":0}}',
  '{"at":"2026-11-12T10:09:30.730Z","type":"reading.unit","decision":"02cb5d767546be6e1b8b99557e7b9453809ada202b52331b0c3aa1acba2d8ac8","mapGroup":"m1","path":"src/parse.ts","lane":"human-required","sections":["693f6d2fc843f4406251a8065fd6580b5a0d287c923b19a0dc341c4aa250205f"],"verdict":null,"disposition":null,"suggestion":false,"undecided":{"unsure":1},"comments":{"shown":0,"belowCut":0}}',
  '{"at":"2026-11-12T10:09:30.730Z","type":"reading.unit","decision":"02cb5d767546be6e1b8b99557e7b9453809ada202b52331b0c3aa1acba2d8ac8","mapGroup":"generated","path":"bun.lock","lane":"human-suggested","sections":["f03fc32bf6394dfd37d9265c758e330fc90fed446d3aeaba7aab0e6eb01f2d3e"],"verdict":null,"disposition":null,"suggestion":false,"undecided":{},"comments":{"shown":0,"belowCut":0}}',
  '{"at":"2026-11-12T10:09:30.730Z","type":"reading.unit","decision":"02cb5d767546be6e1b8b99557e7b9453809ada202b52331b0c3aa1acba2d8ac8","mapGroup":"generated","path":"src/gen/api.ts","lane":"human-suggested","sections":["6f3ef8ceba1597ad9d5959726de2a5b9e92679e2e61fd71c2e792f3df8dc8ca2"],"verdict":null,"disposition":null,"suggestion":false,"undecided":{},"comments":{"shown":0,"belowCut":0}}',
  '{"at":"2026-11-12T10:09:30.730Z","type":"readings.decision","key":"02cb5d767546be6e1b8b99557e7b9453809ada202b52331b0c3aa1acba2d8ac8","plan":"59993114bcecb23cca17eaf6a1193777052ec04d56a290bcf35e7455a8ec9cb7","sections":11,"settled":9,"units":6,"batches":{"total":3,"ready":2},"findings":{"placed":1,"unplaced":0,"unread":0}}',
].join("\n");
/** `collect-finders.jsonl`: the readers lane's own writer's rows (`readings-probe.test.ts` at 40196b18, its run log dumped). */
const REAL_FINDERS = [
  '{"at":"2026-11-12T10:09:30.877Z","type":"reading.section","decision":"3854be78c6b7c53fa705d550a6fa03833b5c73101dc7ec4b45aa792fe78f2848","section":"7c381039ec5332cfcadb5cd79e040f1a01c6a79bb883c8af0068ce19c209d7ea","path":"docs/guide.md","owned":["docs/guide.md:new:7","docs/guide.md:old:7"],"group":"rg_2a2333ce57eb2840","state":"settled","lane":{"judged":null,"surfaced":null,"floors":[],"applied":"human-required"},"floorInputs":{"facts":{"removesDeclaration":false,"removesPublicName":false,"effects":[]},"options":{"removal":false}},"verdict":"request-changes","cause":"failed","reading":"assess","comments":{"shown":0,"belowCut":0,"refuted":0,"unranked":0},"claims":[{"key":"correctness.1","path":"docs/guide.md","side":"new","startLine":7,"endLine":7,"source":"finder","verify":"confirmed","restsOn":true}],"claimFates":{"confirmed":1,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T10:09:30.877Z","type":"reading.section","decision":"3854be78c6b7c53fa705d550a6fa03833b5c73101dc7ec4b45aa792fe78f2848","section":"e4fb515e47429add33522e8b6eea42097f72e7fe32ce51f01d04c2455a7cd1e1","path":"notes.txt","owned":["notes.txt:new:4","notes.txt:old:4"],"group":"rg_2a2333ce57eb2840","state":"settled","lane":{"judged":null,"surfaced":null,"floors":[],"applied":"human-required"},"floorInputs":{"facts":{"removesDeclaration":false,"removesPublicName":false,"effects":[]},"options":{"removal":false}},"verdict":null,"cause":"failed","reading":"assess","comments":{"shown":0,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T10:09:30.877Z","type":"reading.section","decision":"3854be78c6b7c53fa705d550a6fa03833b5c73101dc7ec4b45aa792fe78f2848","section":"96e9bfc2c6cfb080d3f0aae5b1dee25405d2148249e35083df5191d11c82610e","path":"src/old.ts","owned":["src/old.ts:old:4-6"],"group":"rg_bc3d183ee2506457","state":"settled","lane":{"judged":null,"surfaced":null,"floors":[],"applied":"human-required"},"floorInputs":{"facts":{"removesDeclaration":false,"removesPublicName":false,"effects":[]},"options":{"removal":false}},"verdict":null,"cause":"failed","reading":"assess","comments":{"shown":0,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T10:09:30.877Z","type":"reading.section","decision":"3854be78c6b7c53fa705d550a6fa03833b5c73101dc7ec4b45aa792fe78f2848","section":"746bc524002c7e7744146c97f777457293c3e8679296335f41f9e63e6fdb2275","path":"src/parse.test.ts","owned":["src/parse.test.ts:new:4-6"],"group":"rg_bc3d183ee2506457","state":"settled","lane":{"judged":null,"surfaced":null,"floors":[],"applied":"human-required"},"floorInputs":{"facts":{"removesDeclaration":false,"removesPublicName":false,"effects":[]},"options":{"removal":false}},"verdict":null,"cause":"failed","reading":"assess","comments":{"shown":0,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T10:09:30.877Z","type":"reading.section","decision":"3854be78c6b7c53fa705d550a6fa03833b5c73101dc7ec4b45aa792fe78f2848","section":"a6e849e7e8b15c0bd575ca033ff20092a2a9ab4a5578ea0f1c359bed1659cbcd","path":"src/parse.ts","owned":["src/parse.ts:new:4","src/parse.ts:old:4"],"group":"rg_bc3d183ee2506457","state":"settled","lane":{"judged":null,"surfaced":null,"floors":[],"applied":"human-required"},"floorInputs":{"facts":{"removesDeclaration":false,"removesPublicName":false,"effects":[]},"options":{"removal":false}},"verdict":null,"cause":"failed","reading":"assess","comments":{"shown":0,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T10:09:30.877Z","type":"reading.section","decision":"3854be78c6b7c53fa705d550a6fa03833b5c73101dc7ec4b45aa792fe78f2848","section":"693f6d2fc843f4406251a8065fd6580b5a0d287c923b19a0dc341c4aa250205f","path":"src/parse.ts","owned":["src/parse.ts:new:10-13"],"group":"rg_bc3d183ee2506457","state":"settled","lane":{"judged":null,"surfaced":null,"floors":[],"applied":"human-required"},"floorInputs":{"facts":{"removesDeclaration":false,"removesPublicName":false,"effects":[]},"options":{"removal":false}},"verdict":null,"cause":"failed","reading":"assess","comments":{"shown":0,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T10:09:30.877Z","type":"reading.section","decision":"3854be78c6b7c53fa705d550a6fa03833b5c73101dc7ec4b45aa792fe78f2848","section":"4d21fe5c26e99447825d610725a7847557a37515f582681f3a00a0962d86dcf7","path":"assets/logo.png","owned":[],"group":null,"state":"settled","lane":{"judged":null,"surfaced":null,"floors":[],"applied":"human-required"},"floorInputs":{"facts":{"removesDeclaration":false,"removesPublicName":false,"effects":[]},"options":{"removal":false}},"verdict":null,"cause":"unreadable","reading":"assess","comments":{"shown":0,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T10:09:30.877Z","type":"reading.section","decision":"3854be78c6b7c53fa705d550a6fa03833b5c73101dc7ec4b45aa792fe78f2848","section":"f03fc32bf6394dfd37d9265c758e330fc90fed446d3aeaba7aab0e6eb01f2d3e","path":"bun.lock","owned":["bun.lock:new:1","bun.lock:old:1"],"group":null,"state":"settled","lane":{"judged":null,"surfaced":null,"floors":[],"applied":"human-suggested"},"floorInputs":{"facts":{"removesDeclaration":false,"removesPublicName":false,"effects":[]},"options":{"removal":false}},"verdict":null,"cause":"excluded","reading":null,"comments":{"shown":0,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T10:09:30.877Z","type":"reading.section","decision":"3854be78c6b7c53fa705d550a6fa03833b5c73101dc7ec4b45aa792fe78f2848","section":"842f0b1a362068e1b34070c143b865778f63d36db3c0919df915f100ac9dd41c","path":"data/big.txt","owned":["data/big.txt:new:1-1800"],"group":null,"state":"settled","lane":{"judged":null,"surfaced":null,"floors":[],"applied":"human-required"},"floorInputs":{"facts":{"removesDeclaration":false,"removesPublicName":false,"effects":[]},"options":{"removal":false}},"verdict":null,"cause":"too-large","reading":"assess","comments":{"shown":0,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T10:09:30.877Z","type":"reading.section","decision":"3854be78c6b7c53fa705d550a6fa03833b5c73101dc7ec4b45aa792fe78f2848","section":"4ae246936a8560cc7cb613dc16111af5cf2cf77ac5a469ce04d7e1ba6c02a112","path":"scripts/run.sh","owned":[],"group":null,"state":"settled","lane":{"judged":null,"surfaced":null,"floors":[],"applied":"human-required"},"floorInputs":{"facts":{"removesDeclaration":false,"removesPublicName":false,"effects":[]},"options":{"removal":false}},"verdict":null,"cause":"unreadable","reading":"assess","comments":{"shown":0,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T10:09:30.877Z","type":"reading.section","decision":"3854be78c6b7c53fa705d550a6fa03833b5c73101dc7ec4b45aa792fe78f2848","section":"6f3ef8ceba1597ad9d5959726de2a5b9e92679e2e61fd71c2e792f3df8dc8ca2","path":"src/gen/api.ts","owned":["src/gen/api.ts:new:1","src/gen/api.ts:old:1"],"group":null,"state":"settled","lane":{"judged":null,"surfaced":null,"floors":[],"applied":"human-suggested"},"floorInputs":{"facts":{"removesDeclaration":false,"removesPublicName":false,"effects":[]},"options":{"removal":false}},"verdict":null,"cause":"excluded","reading":null,"comments":{"shown":0,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T10:09:30.877Z","type":"reading.batch","decision":"3854be78c6b7c53fa705d550a6fa03833b5c73101dc7ec4b45aa792fe78f2848","mapGroup":"g1","settled":true,"ready":true,"reason":null,"sections":{"settled":9,"waiting":{},"unread":{"unreadable":2,"too-large":1}},"units":8,"problems":0}',
  '{"at":"2026-11-12T10:09:30.877Z","type":"reading.batch","decision":"3854be78c6b7c53fa705d550a6fa03833b5c73101dc7ec4b45aa792fe78f2848","mapGroup":"generated","settled":true,"ready":true,"reason":null,"sections":{"settled":2,"waiting":{},"unread":{"excluded":2}},"units":2,"problems":0}',
  '{"at":"2026-11-12T10:09:30.877Z","type":"reading.unit","decision":"3854be78c6b7c53fa705d550a6fa03833b5c73101dc7ec4b45aa792fe78f2848","mapGroup":"g1","path":"assets/logo.png","lane":"human-required","sections":["4d21fe5c26e99447825d610725a7847557a37515f582681f3a00a0962d86dcf7"],"verdict":null,"disposition":null,"suggestion":false,"undecided":{"unreadable":1},"comments":{"shown":0,"belowCut":0}}',
  '{"at":"2026-11-12T10:09:30.877Z","type":"reading.unit","decision":"3854be78c6b7c53fa705d550a6fa03833b5c73101dc7ec4b45aa792fe78f2848","mapGroup":"g1","path":"data/big.txt","lane":"human-required","sections":["842f0b1a362068e1b34070c143b865778f63d36db3c0919df915f100ac9dd41c"],"verdict":null,"disposition":null,"suggestion":false,"undecided":{"too-large":1},"comments":{"shown":0,"belowCut":0}}',
  '{"at":"2026-11-12T10:09:30.877Z","type":"reading.unit","decision":"3854be78c6b7c53fa705d550a6fa03833b5c73101dc7ec4b45aa792fe78f2848","mapGroup":"g1","path":"docs/guide.md","lane":"human-required","sections":["7c381039ec5332cfcadb5cd79e040f1a01c6a79bb883c8af0068ce19c209d7ea"],"verdict":"request-changes","disposition":"request-changes","suggestion":true,"undecided":{"failed":1},"comments":{"shown":1,"belowCut":0}}',
  '{"at":"2026-11-12T10:09:30.877Z","type":"reading.unit","decision":"3854be78c6b7c53fa705d550a6fa03833b5c73101dc7ec4b45aa792fe78f2848","mapGroup":"g1","path":"notes.txt","lane":"human-required","sections":["e4fb515e47429add33522e8b6eea42097f72e7fe32ce51f01d04c2455a7cd1e1"],"verdict":null,"disposition":null,"suggestion":false,"undecided":{"failed":1},"comments":{"shown":0,"belowCut":0}}',
  '{"at":"2026-11-12T10:09:30.877Z","type":"reading.unit","decision":"3854be78c6b7c53fa705d550a6fa03833b5c73101dc7ec4b45aa792fe78f2848","mapGroup":"g1","path":"scripts/run.sh","lane":"human-required","sections":["4ae246936a8560cc7cb613dc16111af5cf2cf77ac5a469ce04d7e1ba6c02a112"],"verdict":null,"disposition":null,"suggestion":false,"undecided":{"unreadable":1},"comments":{"shown":0,"belowCut":0}}',
  '{"at":"2026-11-12T10:09:30.877Z","type":"reading.unit","decision":"3854be78c6b7c53fa705d550a6fa03833b5c73101dc7ec4b45aa792fe78f2848","mapGroup":"g1","path":"src/old.ts","lane":"human-required","sections":["96e9bfc2c6cfb080d3f0aae5b1dee25405d2148249e35083df5191d11c82610e"],"verdict":null,"disposition":null,"suggestion":false,"undecided":{"failed":1},"comments":{"shown":1,"belowCut":0}}',
  '{"at":"2026-11-12T10:09:30.878Z","type":"reading.unit","decision":"3854be78c6b7c53fa705d550a6fa03833b5c73101dc7ec4b45aa792fe78f2848","mapGroup":"g1","path":"src/parse.test.ts","lane":"human-required","sections":["746bc524002c7e7744146c97f777457293c3e8679296335f41f9e63e6fdb2275"],"verdict":null,"disposition":null,"suggestion":false,"undecided":{"failed":1},"comments":{"shown":0,"belowCut":0}}',
  '{"at":"2026-11-12T10:09:30.878Z","type":"reading.unit","decision":"3854be78c6b7c53fa705d550a6fa03833b5c73101dc7ec4b45aa792fe78f2848","mapGroup":"g1","path":"src/parse.ts","lane":"human-required","sections":["a6e849e7e8b15c0bd575ca033ff20092a2a9ab4a5578ea0f1c359bed1659cbcd","693f6d2fc843f4406251a8065fd6580b5a0d287c923b19a0dc341c4aa250205f"],"verdict":null,"disposition":null,"suggestion":false,"undecided":{"failed":2},"comments":{"shown":0,"belowCut":0}}',
  '{"at":"2026-11-12T10:09:30.878Z","type":"reading.unit","decision":"3854be78c6b7c53fa705d550a6fa03833b5c73101dc7ec4b45aa792fe78f2848","mapGroup":"generated","path":"bun.lock","lane":"human-suggested","sections":["f03fc32bf6394dfd37d9265c758e330fc90fed446d3aeaba7aab0e6eb01f2d3e"],"verdict":null,"disposition":null,"suggestion":false,"undecided":{},"comments":{"shown":0,"belowCut":0}}',
  '{"at":"2026-11-12T10:09:30.878Z","type":"reading.unit","decision":"3854be78c6b7c53fa705d550a6fa03833b5c73101dc7ec4b45aa792fe78f2848","mapGroup":"generated","path":"src/gen/api.ts","lane":"human-suggested","sections":["6f3ef8ceba1597ad9d5959726de2a5b9e92679e2e61fd71c2e792f3df8dc8ca2"],"verdict":null,"disposition":null,"suggestion":false,"undecided":{},"comments":{"shown":0,"belowCut":0}}',
  '{"at":"2026-11-12T10:09:30.878Z","type":"readings.decision","key":"3854be78c6b7c53fa705d550a6fa03833b5c73101dc7ec4b45aa792fe78f2848","plan":"15f3f186c35d78ee0fafdc1c355a2c8767d2504dd0e673ac6f77b852abf71b43","sections":11,"settled":11,"units":10,"batches":{"total":2,"ready":2},"findings":{"placed":1,"unplaced":0,"unread":2}}',
].join("\n");

/** `collect.jsonl` at b46ecb81 (`readings-probe.test.ts`, its run log dumped by the round 5d review, `probe3/`): call rows with input tokens, section rows with `entry`. */
const REAL_B46 = [
  '{"at":"2026-11-12T10:43:11.292Z","type":"reading.call","kind":"assess","group":"rg_2a2333ce57eb2840","part":"read","sections":null,"rank":750002,"characters":null,"source":null,"run":"not-started","key":null,"inputTokens":null,"cachedInputTokens":null,"outputTokens":null,"reasoningTokens":null,"classes":null,"outside":null,"decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70"}',
  '{"at":"2026-11-12T10:43:11.292Z","type":"reading.call","kind":"lane-review","group":"rg_2a2333ce57eb2840","part":"read","sections":null,"rank":750002,"characters":null,"source":null,"run":"interrupted","key":null,"inputTokens":null,"cachedInputTokens":null,"outputTokens":null,"reasoningTokens":null,"classes":null,"outside":null,"problems":null,"decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70"}',
  '{"at":"2026-11-12T10:43:11.292Z","type":"reading.call","kind":"assess","group":"rg_bc3d183ee2506457","part":"read","sections":4,"rank":870004,"characters":389,"source":"agent","run":"ran","key":"b388863bd5834d8574c939282f989cc13d87c4d0dbe5ab89a36c6459fef1057a","inputTokens":1200,"cachedInputTokens":300,"outputTokens":240,"reasoningTokens":60,"classes":2,"outside":2,"problems":{"first":{"missing-row":1,"unknown-cite":1},"given":{"missing-row":1},"repaired":{"missing-row":1}},"decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70"}',
  '{"at":"2026-11-12T10:43:11.292Z","type":"reading.call","kind":"assess","group":"rg_bc3d183ee2506457","part":"reread","sections":null,"rank":870004,"characters":null,"source":null,"run":"failed","key":null,"inputTokens":null,"cachedInputTokens":null,"outputTokens":null,"reasoningTokens":null,"classes":null,"outside":null,"problems":null,"failure":"invalid_request","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70"}',
  '{"at":"2026-11-12T10:43:11.292Z","type":"reading.call","kind":"lane-review","group":"rg_bc3d183ee2506457","part":"read","sections":4,"rank":870004,"characters":707,"source":"agent","run":"ran","key":"83092e7821e9b491356068f1833e467cff156271a3f91f9324cf472128ea8c2c","inputTokens":900,"cachedInputTokens":0,"outputTokens":180,"reasoningTokens":null,"classes":null,"outside":2,"problems":{"first":{},"given":{},"repaired":{}},"decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70"}',
  '{"at":"2026-11-12T10:43:11.292Z","type":"reading.call","kind":"verify-claim","group":"rg_bc3d183ee2506457","part":"claim","sections":1,"rank":870004,"characters":72,"source":"agent","run":"ran","key":"26d13a2d885c802cefb0593c33fb946f59ddf780a2b0b5b9a021186a31ba43c4","inputTokens":null,"cachedInputTokens":null,"outputTokens":null,"reasoningTokens":null,"classes":null,"outside":null,"problems":null,"decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70"}',
  '{"at":"2026-11-12T10:43:11.292Z","type":"reading.section","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","section":"7c381039ec5332cfcadb5cd79e040f1a01c6a79bb883c8af0068ce19c209d7ea","path":"docs/guide.md","owned":["docs/guide.md:new:7","docs/guide.md:old:7"],"group":"rg_2a2333ce57eb2840","state":"waiting","lane":null,"entry":null,"excluded":null,"floorInputs":null,"verdict":null,"cause":"not-reached","reading":"assess","comments":{"shown":0,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T10:43:11.292Z","type":"reading.section","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","section":"e4fb515e47429add33522e8b6eea42097f72e7fe32ce51f01d04c2455a7cd1e1","path":"notes.txt","owned":["notes.txt:new:4","notes.txt:old:4"],"group":"rg_2a2333ce57eb2840","state":"waiting","lane":null,"entry":null,"excluded":null,"floorInputs":null,"verdict":null,"cause":"not-reached","reading":"assess","comments":{"shown":0,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T10:43:11.292Z","type":"reading.section","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","section":"96e9bfc2c6cfb080d3f0aae5b1dee25405d2148249e35083df5191d11c82610e","path":"src/old.ts","owned":["src/old.ts:old:4-6"],"group":"rg_bc3d183ee2506457","state":"settled","lane":{"judged":"human-suggested","surfaced":"human-suggested","floors":[],"applied":"human-suggested"},"entry":{"assess":{"complexity":{"level":"low","factors":[]},"easeOfValidation":{"level":"easy","requirements":[{"cites":["src/old.ts:old:4-4"],"coverage":"missing","requirement":""}]},"lean":null,"gaps":[{"axis":"ease-of-validation"}]},"lane":{"floors":[]}},"excluded":null,"floorInputs":{"facts":{"removesDeclaration":false,"removesPublicName":false,"effects":["removed"]},"options":{"removal":false}},"verdict":"approve","cause":null,"reading":null,"comments":{"shown":1,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T10:43:11.292Z","type":"reading.section","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","section":"746bc524002c7e7744146c97f777457293c3e8679296335f41f9e63e6fdb2275","path":"src/parse.test.ts","owned":["src/parse.test.ts:new:4-6"],"group":"rg_bc3d183ee2506457","state":"settled","lane":{"judged":null,"surfaced":null,"floors":[],"applied":"human-required"},"entry":{"assess":null,"lane":{"floors":[]},"undecided":{"cause":"failed"}},"excluded":null,"floorInputs":{"facts":{"removesDeclaration":false,"removesPublicName":false,"effects":[]},"options":{"removal":false}},"verdict":"approve","cause":"failed","reading":"assess","comments":{"shown":0,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T10:43:11.292Z","type":"reading.section","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","section":"a6e849e7e8b15c0bd575ca033ff20092a2a9ab4a5578ea0f1c359bed1659cbcd","path":"src/parse.ts","owned":["src/parse.ts:new:4","src/parse.ts:old:4"],"group":"rg_bc3d183ee2506457","state":"settled","lane":{"judged":"human-suggested","surfaced":"human-suggested","floors":[],"applied":"human-suggested"},"entry":{"assess":{"complexity":{"level":"high","factors":[]},"easeOfValidation":{"level":"easy","requirements":[]},"lean":{"lane":"agentic","reason":""},"gaps":[{"axis":"ease-of-validation"}]},"lane":{"floors":[]}},"excluded":null,"floorInputs":{"facts":{"removesDeclaration":false,"removesPublicName":false,"effects":[]},"options":{"removal":false}},"verdict":"request-changes","cause":null,"reading":null,"comments":{"shown":1,"belowCut":0,"refuted":0,"unranked":0},"claims":[{"key":"7b0dd660a0346dd6c32ebfc0d629c62e919fd9e3c4a17cdea19ae0db1def4b16","path":"src/parse.ts","side":"new","startLine":4,"endLine":4,"source":"lane-review","verify":"confirmed","restsOn":true}],"claimFates":{"confirmed":1,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T10:43:11.292Z","type":"reading.section","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","section":"693f6d2fc843f4406251a8065fd6580b5a0d287c923b19a0dc341c4aa250205f","path":"src/parse.ts","owned":["src/parse.ts:new:10-13"],"group":"rg_bc3d183ee2506457","state":"settled","lane":{"judged":"human-suggested","surfaced":"human-suggested","floors":[],"applied":"human-required"},"entry":{"assess":{"complexity":{"level":"high","factors":[]},"easeOfValidation":{"level":"easy","requirements":[]},"lean":{"lane":"agentic","reason":""},"gaps":[{"axis":"ease-of-validation"}]},"lane":{"floors":[]},"undecided":{"cause":"unsure"}},"excluded":null,"floorInputs":{"facts":{"removesDeclaration":false,"removesPublicName":false,"effects":[]},"options":{"removal":false}},"verdict":null,"cause":"unsure","reading":"lane-review","comments":{"shown":0,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T10:43:11.292Z","type":"reading.section","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","section":"4d21fe5c26e99447825d610725a7847557a37515f582681f3a00a0962d86dcf7","path":"assets/logo.png","owned":[],"group":null,"state":"settled","lane":{"judged":null,"surfaced":null,"floors":[],"applied":"human-required"},"entry":{"assess":null,"lane":{"floors":[]},"undecided":{"cause":"unreadable"}},"excluded":null,"floorInputs":{"facts":{"removesDeclaration":false,"removesPublicName":false,"effects":[]},"options":{"removal":false}},"verdict":null,"cause":"unreadable","reading":"assess","comments":{"shown":0,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T10:43:11.292Z","type":"reading.section","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","section":"f03fc32bf6394dfd37d9265c758e330fc90fed446d3aeaba7aab0e6eb01f2d3e","path":"bun.lock","owned":["bun.lock:new:1","bun.lock:old:1"],"group":null,"state":"settled","lane":{"judged":null,"surfaced":null,"floors":[],"applied":"human-suggested"},"entry":{"assess":null,"lane":{"floors":[]},"excluded":{"reason":"lockfile"}},"excluded":{"reason":"lockfile"},"floorInputs":{"facts":{"removesDeclaration":false,"removesPublicName":false,"effects":[]},"options":{"removal":false}},"verdict":null,"cause":"excluded","reading":null,"comments":{"shown":0,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T10:43:11.292Z","type":"reading.section","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","section":"842f0b1a362068e1b34070c143b865778f63d36db3c0919df915f100ac9dd41c","path":"data/big.txt","owned":["data/big.txt:new:1-1800"],"group":null,"state":"settled","lane":{"judged":null,"surfaced":null,"floors":[],"applied":"human-required"},"entry":{"assess":null,"lane":{"floors":[]},"undecided":{"cause":"too-large"}},"excluded":null,"floorInputs":{"facts":{"removesDeclaration":false,"removesPublicName":false,"effects":[]},"options":{"removal":false}},"verdict":null,"cause":"too-large","reading":"assess","comments":{"shown":0,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T10:43:11.292Z","type":"reading.section","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","section":"4ae246936a8560cc7cb613dc16111af5cf2cf77ac5a469ce04d7e1ba6c02a112","path":"scripts/run.sh","owned":[],"group":null,"state":"settled","lane":{"judged":null,"surfaced":null,"floors":[],"applied":"human-required"},"entry":{"assess":null,"lane":{"floors":[]},"undecided":{"cause":"unreadable"}},"excluded":null,"floorInputs":{"facts":{"removesDeclaration":false,"removesPublicName":false,"effects":[]},"options":{"removal":false}},"verdict":null,"cause":"unreadable","reading":"assess","comments":{"shown":0,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T10:43:11.292Z","type":"reading.section","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","section":"6f3ef8ceba1597ad9d5959726de2a5b9e92679e2e61fd71c2e792f3df8dc8ca2","path":"src/gen/api.ts","owned":["src/gen/api.ts:new:1","src/gen/api.ts:old:1"],"group":null,"state":"settled","lane":{"judged":null,"surfaced":null,"floors":[],"applied":"human-suggested"},"entry":{"assess":null,"lane":{"floors":[]},"excluded":{"reason":"declared-generated"}},"excluded":{"reason":"declared-generated"},"floorInputs":{"facts":{"removesDeclaration":false,"removesPublicName":false,"effects":[]},"options":{"removal":false}},"verdict":null,"cause":"excluded","reading":null,"comments":{"shown":0,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T10:43:11.292Z","type":"reading.batch","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","mapGroup":"m1","settled":true,"ready":true,"reason":null,"sections":{"settled":4,"waiting":{},"unread":{}},"units":4,"problems":0,"settledAt":"2026-11-12T10:43:11.276Z"}',
  '{"at":"2026-11-12T10:43:11.292Z","type":"reading.batch","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","mapGroup":"m2","settled":false,"ready":false,"reason":"waiting","sections":{"settled":3,"waiting":{"not-reached":2},"unread":{"unreadable":2,"too-large":1}},"units":0,"problems":0,"settledAt":null}',
  '{"at":"2026-11-12T10:43:11.292Z","type":"reading.batch","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","mapGroup":"generated","settled":true,"ready":true,"reason":null,"sections":{"settled":2,"waiting":{},"unread":{"excluded":2}},"units":2,"problems":0,"settledAt":null}',
  '{"at":"2026-11-12T10:43:11.293Z","type":"reading.unit","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","mapGroup":"m1","path":"src/old.ts","lane":"human-suggested","sections":["96e9bfc2c6cfb080d3f0aae5b1dee25405d2148249e35083df5191d11c82610e"],"verdict":"approve","disposition":"approve","suggestion":false,"undecided":{},"comments":{"shown":3,"belowCut":0}}',
  '{"at":"2026-11-12T10:43:11.293Z","type":"reading.unit","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","mapGroup":"m1","path":"src/parse.test.ts","lane":"human-required","sections":["746bc524002c7e7744146c97f777457293c3e8679296335f41f9e63e6fdb2275"],"verdict":"approve","disposition":null,"suggestion":true,"undecided":{"failed":1},"comments":{"shown":0,"belowCut":0}}',
  '{"at":"2026-11-12T10:43:11.293Z","type":"reading.unit","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","mapGroup":"m1","path":"src/parse.ts","lane":"human-suggested","sections":["a6e849e7e8b15c0bd575ca033ff20092a2a9ab4a5578ea0f1c359bed1659cbcd"],"verdict":"request-changes","disposition":"request-changes","suggestion":false,"undecided":{},"comments":{"shown":1,"belowCut":0}}',
  '{"at":"2026-11-12T10:43:11.293Z","type":"reading.unit","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","mapGroup":"m1","path":"src/parse.ts","lane":"human-required","sections":["693f6d2fc843f4406251a8065fd6580b5a0d287c923b19a0dc341c4aa250205f"],"verdict":null,"disposition":null,"suggestion":false,"undecided":{"unsure":1},"comments":{"shown":0,"belowCut":0}}',
  '{"at":"2026-11-12T10:43:11.293Z","type":"reading.unit","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","mapGroup":"generated","path":"bun.lock","lane":"human-suggested","sections":["f03fc32bf6394dfd37d9265c758e330fc90fed446d3aeaba7aab0e6eb01f2d3e"],"verdict":null,"disposition":null,"suggestion":false,"undecided":{},"comments":{"shown":0,"belowCut":0}}',
  '{"at":"2026-11-12T10:43:11.293Z","type":"reading.unit","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","mapGroup":"generated","path":"src/gen/api.ts","lane":"human-suggested","sections":["6f3ef8ceba1597ad9d5959726de2a5b9e92679e2e61fd71c2e792f3df8dc8ca2"],"verdict":null,"disposition":null,"suggestion":false,"undecided":{},"comments":{"shown":0,"belowCut":0}}',
  '{"at":"2026-11-12T10:43:11.293Z","type":"readings.decision","key":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","plan":"59993114bcecb23cca17eaf6a1193777052ec04d56a290bcf35e7455a8ec9cb7","sections":11,"settled":9,"units":6,"batches":{"total":3,"ready":2},"findings":{"placed":1,"unplaced":0,"unread":0}}',
].join("\n");

/** `collect.jsonl` at ccd75a4c (`readings-probe.test.ts`, its run log dumped by the round 5e review, `probe4/`): cache writes on calls, `reused` on batches. */
const REAL_CCD = [
  '{"at":"2026-11-12T11:03:21.369Z","type":"reading.call","kind":"assess","group":"rg_2a2333ce57eb2840","part":"read","sections":null,"rank":750002,"characters":null,"source":null,"run":"not-started","key":null,"inputTokens":null,"cachedInputTokens":null,"cacheWriteTokens":null,"outputTokens":null,"reasoningTokens":null,"classes":null,"outside":null,"decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70"}',
  '{"at":"2026-11-12T11:03:21.369Z","type":"reading.call","kind":"lane-review","group":"rg_2a2333ce57eb2840","part":"read","sections":null,"rank":750002,"characters":null,"source":null,"run":"interrupted","key":null,"inputTokens":null,"cachedInputTokens":null,"cacheWriteTokens":null,"outputTokens":null,"reasoningTokens":null,"classes":null,"outside":null,"problems":null,"decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70"}',
  '{"at":"2026-11-12T11:03:21.369Z","type":"reading.call","kind":"assess","group":"rg_bc3d183ee2506457","part":"read","sections":4,"rank":870004,"characters":389,"source":"agent","run":"ran","key":"b388863bd5834d8574c939282f989cc13d87c4d0dbe5ab89a36c6459fef1057a","inputTokens":1200,"cachedInputTokens":300,"cacheWriteTokens":5200,"outputTokens":240,"reasoningTokens":60,"classes":2,"outside":2,"problems":{"first":{"missing-row":1,"unknown-cite":1},"given":{"missing-row":1},"repaired":{"missing-row":1}},"decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70"}',
  '{"at":"2026-11-12T11:03:21.369Z","type":"reading.call","kind":"assess","group":"rg_bc3d183ee2506457","part":"reread","sections":null,"rank":870004,"characters":null,"source":null,"run":"failed","key":null,"inputTokens":null,"cachedInputTokens":null,"cacheWriteTokens":null,"outputTokens":null,"reasoningTokens":null,"classes":null,"outside":null,"problems":null,"failure":"invalid_request","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70"}',
  '{"at":"2026-11-12T11:03:21.369Z","type":"reading.call","kind":"lane-review","group":"rg_bc3d183ee2506457","part":"read","sections":4,"rank":870004,"characters":707,"source":"agent","run":"ran","key":"83092e7821e9b491356068f1833e467cff156271a3f91f9324cf472128ea8c2c","inputTokens":900,"cachedInputTokens":0,"cacheWriteTokens":0,"outputTokens":180,"reasoningTokens":null,"classes":null,"outside":2,"problems":{"first":{},"given":{},"repaired":{}},"decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70"}',
  '{"at":"2026-11-12T11:03:21.369Z","type":"reading.call","kind":"verify-claim","group":"rg_bc3d183ee2506457","part":"claim","sections":1,"rank":870004,"characters":72,"source":"agent","run":"reused","key":"26d13a2d885c802cefb0593c33fb946f59ddf780a2b0b5b9a021186a31ba43c4","inputTokens":null,"cachedInputTokens":null,"cacheWriteTokens":null,"outputTokens":null,"reasoningTokens":null,"classes":null,"outside":null,"problems":null,"decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70"}',
  '{"at":"2026-11-12T11:03:21.369Z","type":"reading.section","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","section":"7c381039ec5332cfcadb5cd79e040f1a01c6a79bb883c8af0068ce19c209d7ea","path":"docs/guide.md","owned":["docs/guide.md:new:7","docs/guide.md:old:7"],"group":"rg_2a2333ce57eb2840","state":"waiting","lane":null,"entry":null,"excluded":null,"floorInputs":null,"verdict":null,"cause":"not-reached","reading":"assess","comments":{"shown":0,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T11:03:21.369Z","type":"reading.section","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","section":"e4fb515e47429add33522e8b6eea42097f72e7fe32ce51f01d04c2455a7cd1e1","path":"notes.txt","owned":["notes.txt:new:4","notes.txt:old:4"],"group":"rg_2a2333ce57eb2840","state":"waiting","lane":null,"entry":null,"excluded":null,"floorInputs":null,"verdict":null,"cause":"not-reached","reading":"assess","comments":{"shown":0,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T11:03:21.369Z","type":"reading.section","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","section":"96e9bfc2c6cfb080d3f0aae5b1dee25405d2148249e35083df5191d11c82610e","path":"src/old.ts","owned":["src/old.ts:old:4-6"],"group":"rg_bc3d183ee2506457","state":"settled","lane":{"judged":"human-suggested","surfaced":"human-suggested","floors":[],"applied":"human-suggested"},"entry":{"assess":{"complexity":{"level":"low","factors":[]},"easeOfValidation":{"level":"easy","requirements":[{"cites":["src/old.ts:old:4-4"],"coverage":"missing","requirement":""}]},"lean":null,"gaps":[{"axis":"ease-of-validation"}]},"lane":{"floors":[]}},"excluded":null,"floorInputs":{"facts":{"removesDeclaration":false,"removesPublicName":false,"effects":["removed"]},"options":{"removal":false}},"verdict":"approve","cause":null,"reading":null,"comments":{"shown":1,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T11:03:21.369Z","type":"reading.section","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","section":"746bc524002c7e7744146c97f777457293c3e8679296335f41f9e63e6fdb2275","path":"src/parse.test.ts","owned":["src/parse.test.ts:new:4-6"],"group":"rg_bc3d183ee2506457","state":"settled","lane":{"judged":null,"surfaced":null,"floors":[],"applied":"human-required"},"entry":{"assess":null,"lane":{"floors":[]},"undecided":{"cause":"failed"}},"excluded":null,"floorInputs":{"facts":{"removesDeclaration":false,"removesPublicName":false,"effects":[]},"options":{"removal":false}},"verdict":"approve","cause":"failed","reading":"assess","comments":{"shown":0,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T11:03:21.369Z","type":"reading.section","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","section":"a6e849e7e8b15c0bd575ca033ff20092a2a9ab4a5578ea0f1c359bed1659cbcd","path":"src/parse.ts","owned":["src/parse.ts:new:4","src/parse.ts:old:4"],"group":"rg_bc3d183ee2506457","state":"settled","lane":{"judged":"human-suggested","surfaced":"human-suggested","floors":[],"applied":"human-suggested"},"entry":{"assess":{"complexity":{"level":"high","factors":[]},"easeOfValidation":{"level":"easy","requirements":[]},"lean":{"lane":"agentic","reason":""},"gaps":[{"axis":"ease-of-validation"}]},"lane":{"floors":[]}},"excluded":null,"floorInputs":{"facts":{"removesDeclaration":false,"removesPublicName":false,"effects":[]},"options":{"removal":false}},"verdict":"request-changes","cause":null,"reading":null,"comments":{"shown":1,"belowCut":0,"refuted":0,"unranked":0},"claims":[{"key":"7b0dd660a0346dd6c32ebfc0d629c62e919fd9e3c4a17cdea19ae0db1def4b16","path":"src/parse.ts","side":"new","startLine":4,"endLine":4,"source":"lane-review","verify":"confirmed","restsOn":true}],"claimFates":{"confirmed":1,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T11:03:21.369Z","type":"reading.section","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","section":"693f6d2fc843f4406251a8065fd6580b5a0d287c923b19a0dc341c4aa250205f","path":"src/parse.ts","owned":["src/parse.ts:new:10-13"],"group":"rg_bc3d183ee2506457","state":"settled","lane":{"judged":"human-suggested","surfaced":"human-suggested","floors":[],"applied":"human-required"},"entry":{"assess":{"complexity":{"level":"high","factors":[]},"easeOfValidation":{"level":"easy","requirements":[]},"lean":{"lane":"agentic","reason":""},"gaps":[{"axis":"ease-of-validation"}]},"lane":{"floors":[]},"undecided":{"cause":"unsure"}},"excluded":null,"floorInputs":{"facts":{"removesDeclaration":false,"removesPublicName":false,"effects":[]},"options":{"removal":false}},"verdict":null,"cause":"unsure","reading":"lane-review","comments":{"shown":0,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T11:03:21.369Z","type":"reading.section","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","section":"4d21fe5c26e99447825d610725a7847557a37515f582681f3a00a0962d86dcf7","path":"assets/logo.png","owned":[],"group":null,"state":"settled","lane":{"judged":null,"surfaced":null,"floors":[],"applied":"human-required"},"entry":{"assess":null,"lane":{"floors":[]},"undecided":{"cause":"unreadable"}},"excluded":null,"floorInputs":{"facts":{"removesDeclaration":false,"removesPublicName":false,"effects":[]},"options":{"removal":false}},"verdict":null,"cause":"unreadable","reading":"assess","comments":{"shown":0,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T11:03:21.369Z","type":"reading.section","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","section":"f03fc32bf6394dfd37d9265c758e330fc90fed446d3aeaba7aab0e6eb01f2d3e","path":"bun.lock","owned":["bun.lock:new:1","bun.lock:old:1"],"group":null,"state":"settled","lane":{"judged":null,"surfaced":null,"floors":[],"applied":"human-suggested"},"entry":{"assess":null,"lane":{"floors":[]},"excluded":{"reason":"lockfile"}},"excluded":{"reason":"lockfile"},"floorInputs":{"facts":{"removesDeclaration":false,"removesPublicName":false,"effects":[]},"options":{"removal":false}},"verdict":null,"cause":"excluded","reading":null,"comments":{"shown":0,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T11:03:21.369Z","type":"reading.section","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","section":"842f0b1a362068e1b34070c143b865778f63d36db3c0919df915f100ac9dd41c","path":"data/big.txt","owned":["data/big.txt:new:1-1800"],"group":null,"state":"settled","lane":{"judged":null,"surfaced":null,"floors":[],"applied":"human-required"},"entry":{"assess":null,"lane":{"floors":[]},"undecided":{"cause":"too-large"}},"excluded":null,"floorInputs":{"facts":{"removesDeclaration":false,"removesPublicName":false,"effects":[]},"options":{"removal":false}},"verdict":null,"cause":"too-large","reading":"assess","comments":{"shown":0,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T11:03:21.370Z","type":"reading.section","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","section":"4ae246936a8560cc7cb613dc16111af5cf2cf77ac5a469ce04d7e1ba6c02a112","path":"scripts/run.sh","owned":[],"group":null,"state":"settled","lane":{"judged":null,"surfaced":null,"floors":[],"applied":"human-required"},"entry":{"assess":null,"lane":{"floors":[]},"undecided":{"cause":"unreadable"}},"excluded":null,"floorInputs":{"facts":{"removesDeclaration":false,"removesPublicName":false,"effects":[]},"options":{"removal":false}},"verdict":null,"cause":"unreadable","reading":"assess","comments":{"shown":0,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T11:03:21.370Z","type":"reading.section","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","section":"6f3ef8ceba1597ad9d5959726de2a5b9e92679e2e61fd71c2e792f3df8dc8ca2","path":"src/gen/api.ts","owned":["src/gen/api.ts:new:1","src/gen/api.ts:old:1"],"group":null,"state":"settled","lane":{"judged":null,"surfaced":null,"floors":[],"applied":"human-suggested"},"entry":{"assess":null,"lane":{"floors":[]},"excluded":{"reason":"declared-generated"}},"excluded":{"reason":"declared-generated"},"floorInputs":{"facts":{"removesDeclaration":false,"removesPublicName":false,"effects":[]},"options":{"removal":false}},"verdict":null,"cause":"excluded","reading":null,"comments":{"shown":0,"belowCut":0,"refuted":0,"unranked":0},"claims":[],"claimFates":{"confirmed":0,"refuted":0,"unconfirmed":0}}',
  '{"at":"2026-11-12T11:03:21.370Z","type":"reading.batch","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","mapGroup":"m1","settled":true,"ready":true,"reason":null,"sections":{"settled":4,"waiting":{},"unread":{}},"units":4,"problems":0,"settledAt":"2026-11-12T11:03:21.350Z","reused":1}',
  '{"at":"2026-11-12T11:03:21.370Z","type":"reading.batch","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","mapGroup":"m2","settled":false,"ready":false,"reason":"waiting","sections":{"settled":3,"waiting":{"not-reached":2},"unread":{"unreadable":2,"too-large":1}},"units":0,"problems":0,"settledAt":null,"reused":0}',
  '{"at":"2026-11-12T11:03:21.370Z","type":"reading.batch","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","mapGroup":"generated","settled":true,"ready":true,"reason":null,"sections":{"settled":2,"waiting":{},"unread":{"excluded":2}},"units":2,"problems":0,"settledAt":null,"reused":0}',
  '{"at":"2026-11-12T11:03:21.370Z","type":"reading.unit","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","mapGroup":"m1","path":"src/old.ts","lane":"human-suggested","sections":["96e9bfc2c6cfb080d3f0aae5b1dee25405d2148249e35083df5191d11c82610e"],"verdict":"approve","disposition":"approve","suggestion":false,"undecided":{},"comments":{"shown":3,"belowCut":0}}',
  '{"at":"2026-11-12T11:03:21.370Z","type":"reading.unit","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","mapGroup":"m1","path":"src/parse.test.ts","lane":"human-required","sections":["746bc524002c7e7744146c97f777457293c3e8679296335f41f9e63e6fdb2275"],"verdict":"approve","disposition":null,"suggestion":true,"undecided":{"failed":1},"comments":{"shown":0,"belowCut":0}}',
  '{"at":"2026-11-12T11:03:21.370Z","type":"reading.unit","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","mapGroup":"m1","path":"src/parse.ts","lane":"human-suggested","sections":["a6e849e7e8b15c0bd575ca033ff20092a2a9ab4a5578ea0f1c359bed1659cbcd"],"verdict":"request-changes","disposition":"request-changes","suggestion":false,"undecided":{},"comments":{"shown":1,"belowCut":0}}',
  '{"at":"2026-11-12T11:03:21.370Z","type":"reading.unit","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","mapGroup":"m1","path":"src/parse.ts","lane":"human-required","sections":["693f6d2fc843f4406251a8065fd6580b5a0d287c923b19a0dc341c4aa250205f"],"verdict":null,"disposition":null,"suggestion":false,"undecided":{"unsure":1},"comments":{"shown":0,"belowCut":0}}',
  '{"at":"2026-11-12T11:03:21.370Z","type":"reading.unit","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","mapGroup":"generated","path":"bun.lock","lane":"human-suggested","sections":["f03fc32bf6394dfd37d9265c758e330fc90fed446d3aeaba7aab0e6eb01f2d3e"],"verdict":null,"disposition":null,"suggestion":false,"undecided":{},"comments":{"shown":0,"belowCut":0}}',
  '{"at":"2026-11-12T11:03:21.370Z","type":"reading.unit","decision":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","mapGroup":"generated","path":"src/gen/api.ts","lane":"human-suggested","sections":["6f3ef8ceba1597ad9d5959726de2a5b9e92679e2e61fd71c2e792f3df8dc8ca2"],"verdict":null,"disposition":null,"suggestion":false,"undecided":{},"comments":{"shown":0,"belowCut":0}}',
  '{"at":"2026-11-12T11:03:21.370Z","type":"readings.decision","key":"e2256a69a30fc951e105df8ffbf670113957fc169b6fc1dc93dac6c135218f70","plan":"59993114bcecb23cca17eaf6a1193777052ec04d56a290bcf35e7455a8ec9cb7","sections":11,"settled":9,"units":6,"batches":{"total":3,"ready":2},"findings":{"placed":1,"unplaced":0,"unread":0}}',
].join("\n");
/** The same run's range manifest hunks (`collect.show.json`), the fields `addedLines` reads. */
const REAL_CCD_HUNKS = [
  {
    kind: "text",
    path: "src/parse.ts",
    newPath: "src/parse.ts",
    newStart: 3,
    text: "@@ -3,3 +3,3 @@\n function helper(x: number) {\n-  return x + 1;\n+  return x + 2;\n }\n",
  },
  {
    kind: "text",
    path: "src/parse.ts",
    newPath: "src/parse.ts",
    newStart: 9,
    text: "@@ -9,1 +9,5 @@\n }\n+\n+export function count(text: string) {\n+  return parse(text).length;\n+}\n",
  },
  {
    kind: "text",
    path: "src/old.ts",
    newPath: "src/old.ts",
    newStart: 3,
    text: "@@ -3,4 +3,1 @@\n }\n-export function drop() {\n-  return 2;\n-}\n",
  },
  {
    kind: "text",
    path: "src/parse.test.ts",
    newPath: "src/parse.test.ts",
    newStart: 3,
    text: '@@ -3,1 +3,4 @@\n });\n+it("counts", () => {\n+  expect(count("a,b")).toBe(2);\n+});\n',
  },
  {
    kind: "text",
    path: "notes.txt",
    newPath: "notes.txt",
    newStart: 3,
    text: "@@ -3,3 +3,3 @@\n three\n-four\n+four changed\n five\n",
  },
  {
    kind: "text",
    path: "docs/guide.md",
    newPath: "docs/guide.md",
    newStart: 6,
    text: "@@ -6,2 +6,2 @@\n \n-Call parse.\n+Call parse, then count.\n",
  },
  {
    kind: "text",
    path: "src/gen/api.ts",
    newPath: "src/gen/api.ts",
    newStart: 1,
    text: "@@ -1,1 +1,1 @@\n-export const a = 1;\n+export const a = 2;\n",
  },
  {
    kind: "text",
    path: "bun.lock",
    newPath: "bun.lock",
    newStart: 1,
    text: "@@ -1,1 +1,1 @@\n-{ a: 1 }\n+{ a: 2 }\n",
  },
  {
    kind: "binary",
    path: "assets/logo.png",
    newPath: "assets/logo.png",
    newStart: 0,
    text: "Binary files differ: assets/logo.png",
  },
  {
    kind: "metadata",
    path: "scripts/run.sh",
    newPath: "scripts/run.sh",
    newStart: 0,
    text: "mode change: scripts/run.sh",
  },
  {
    kind: "text",
    path: "data/big.txt",
    newPath: "data/big.txt",
    newStart: 1,
    // 1,800 added rows, as the writer's fixture writes them (text SHA-256 checked below).
    text: `@@ -0,0 +1,1800 @@\n${Array.from({ length: 1800 }, (_, i) => `+row ${String(i).padStart(4, "0")} ${"x".repeat(90)}\n`).join("")}`,
  },
];
const BIG_SHA256 =
  "4220d0481ffcd3d08b0bc4db0ffccff484de43ec317e7ff425c58074d4d53728";

const plant = (variant: number, overrides: Partial<Plant> = {}): Plant =>
  ({
    variant,
    caseId: `planted:${variant}`,
    host: { caseId: "h" },
    problem: "source-defect",
    kind: "k",
    category: "source-defect",
    set: "C",
    lines: [{ path: "src/a.ts", side: "new", startLine: 10, endLine: 10 }],
    beside: [{ path: "src/a.ts", side: "new", startLine: 30, endLine: 30 }],
    mentions: [],
    ...overrides,
  }) as Plant;
const at = (path: string, side: "old" | "new", line: number) =>
  plant(1, {
    lines: [{ path, side, startLine: line, endLine: line }],
    beside: [],
  });

const trail = (
  applied: string,
  judged: string | null = applied,
  floors: ReadonlyArray<unknown> = [],
) => ({ judged, surfaced: judged, floors, applied });

/** A `reading.section` row in the writer's shape. */
const section = (
  key: string,
  owned: ReadonlyArray<string>,
  extra: Record<string, unknown> = {},
) => ({
  type: "reading.section",
  decision: "D1",
  section: key,
  path: owned[0]!.split(":")[0],
  owned,
  group: "g1",
  state: "settled",
  lane: trail("human-suggested"),
  floorInputs: {
    facts: { removesDeclaration: false, removesPublicName: false, effects: [] },
    options: { removal: false },
  },
  verdict: "approve",
  cause: null,
  reading: null,
  comments: { shown: 0, belowCut: 0, refuted: 0, unranked: 0 },
  claims: [],
  claimFates: { confirmed: 0, refuted: 0, unconfirmed: 0 },
  at: "2026-11-12T10:00:05.000Z",
  ...extra,
});
const claim = (line: number, extra: Record<string, unknown> = {}) => ({
  key: `c${line}`,
  path: "src/a.ts",
  side: "new",
  startLine: line,
  endLine: line,
  source: "lane-review",
  verify: "confirmed",
  restsOn: true,
  ...extra,
});
const requested = (
  claims: ReadonlyArray<unknown>,
  extra: Record<string, unknown> = {},
) =>
  section("s1", ["src/a.ts:new:5-15"], {
    verdict: "request-changes",
    claims,
    ...extra,
  });
const call = (kind: string, extra: Record<string, unknown> = {}) => ({
  type: "reading.call",
  decision: "D1",
  kind,
  group: "g1",
  part: "read",
  sections: 2,
  rank: 1,
  characters: kind === "assess" ? 300 : 100,
  source: "agent",
  run: "ran",
  key: `k-${kind}`,
  problems: { first: {}, given: {}, repaired: {} },
  ...extra,
});

/** A whole log of one decision: the given section rows, two calls, their model calls, a batch, a unit. */
const rowsOf = (
  rows: ReadonlyArray<Record<string, unknown>>,
  options: {
    calls?: ReadonlyArray<Record<string, unknown>>;
    modelCalls?: boolean;
    decision?: Record<string, unknown> | null;
  } = {},
) =>
  [
    { type: "run.started", at: "2026-11-12T10:00:00.000Z" },
    {
      type: "readings.plan",
      plan: "P1",
      sections: rows.length,
      unread: { excluded: 0, unreadable: 0, "too-large": 0 },
      groups: 1,
      tasks: 2,
      at: "2026-11-12T10:00:01.000Z",
    },
    ...(options.modelCalls === false
      ? []
      : [
          {
            type: "model.call",
            agent: "assess.g1",
            usage: { input: 1000, cacheRead: 400, output: 120, thinking: 30 },
          },
          {
            type: "model.call",
            agent: "lane-review.g1",
            usage: { input: 800, cacheRead: 0, output: 40, thinking: 10 },
          },
          {
            type: "model.call",
            agent: "correctness.find",
            usage: { input: 9999, output: 9999 },
          },
        ]),
    ...rows,
    ...(options.calls ?? [call("assess"), call("lane-review")]),
    {
      type: "reading.batch",
      decision: "D1",
      mapGroup: "m1",
      settled: true,
      ready: true,
      reason: null,
      sections: { settled: 2, waiting: {}, unread: {} },
      units: 1,
      problems: 0,
    },
    {
      type: "reading.unit",
      decision: "D1",
      mapGroup: "m1",
      path: "src/a.ts",
      lane: "human-suggested",
      sections: ["s1"],
      verdict: "approve",
      disposition: null,
    },
    ...(options.decision === null
      ? []
      : [
          {
            type: "readings.decision",
            key: "D1",
            plan: "P1",
            sections: rows.length,
            settled: rows.length,
            units: 1,
            batches: { total: 1, ready: 1 },
            findings: { placed: 0, unplaced: 0, unread: 0 },
            at: "2026-11-12T10:00:42.000Z",
            ...options.decision,
          },
        ]),
  ]
    .map((r) => JSON.stringify(r))
    .join("\n");

const read = (...rows: ReadonlyArray<Record<string, unknown>>) =>
  readProbeRows(rowsOf(rows));

// The floors seam as this build has it, put back after each test that swaps in a stand-in.
const original = useFloorsOf(undefined);
useFloorsOf(original);
const originalLane = useRecordedLane(undefined);
useRecordedLane(originalLane);
afterEach(() => {
  useFloorsOf(original);
  useRecordedLane(originalLane);
});

test("the readers lane's own rows read whole, and score each plant at its level", () => {
  const rows = readProbeRows(REAL_COLLECT);
  expect(rows.sections).toHaveLength(11);
  const outcome = (p: Plant) => scorePlantReadings(p, rows).outcome;
  expect(outcome(at("src/parse.ts", "new", 4))).toBe("caught");
  expect(outcome(at("src/parse.ts", "new", 11))).toBe("undecided");
  expect(
    scorePlantReadings(at("src/parse.ts", "new", 11), rows).undecidedCauses,
  ).toEqual(["unsure"]);
  expect(outcome(at("src/parse.test.ts", "new", 5))).toBe("undecided");
  // Waiting because the review's time ran out before its reading (cause not-reached): its own line.
  expect(outcome(at("docs/guide.md", "new", 7))).toBe("not-reached");
  expect(outcome(at("src/old.ts", "old", 5))).toBe("missed");
  // A lockfile: no reading reads it, so it is not the readings' miss.
  expect(outcome(at("bun.lock", "new", 1))).toBe("excluded");
  expect(outcome(at("src/nowhere.ts", "new", 1))).toBe("no-section");
  const counts = probeCounts(rows);
  expect(counts.sections).toEqual({ settled: 9, waiting: 2 });
  expect(counts.excluded).toEqual({
    "reason not recorded": { sections: 2, lines: 4 },
  });
  expect(Object.keys(counts.undecided).sort()).toEqual([
    "failed",
    "too-large",
    "unreadable",
    "unsure",
  ]);
  // N2: the writer's own call tokens (40196b18) are read; the dump holds no model calls, so input
  // and cached input are not measured, never 0.
  expect(counts.calls["assess"]).toMatchObject({
    tokens: {
      output: { total: 240, unknown: 0 },
      reasoning: { total: 60, unknown: 0 },
      input: null,
      cached: null,
    },
    tokensFrom: {
      output: "reading.call",
      reasoning: "reading.call",
      input: null,
      cached: null,
    },
    classes: { total: 2, calls: 1 },
    outside: { total: 2, calls: 1 },
  });
  expect(counts.calls["lane-review"]).toMatchObject({
    // The route reports no reasoning for it: not measured, never 0.
    tokens: { output: { total: 180, unknown: 0 }, reasoning: null },
    outside: { total: 2, calls: 1 },
  });
  // A verify-claim call records no tokens of its own, and no model call is there for it.
  expect(counts.calls["verify-claim"]!.tokens.output).toBeNull();
  expect(rows.absent).toContain(
    "model.call (input, cached input, cache write tokens not measured)",
  );
  expect(rows.finderFindingsPlaced).toBe(1);
});

test("N1: a later decision keeps the readings' model calls of its own groups and claims, even those written before the first decision", () => {
  const assessGroup = "rg_bc3d183ee2506457";
  const claimKey =
    "7b0dd660a0346dd6c32ebfc0d629c62e919fd9e3c4a17cdea19ae0db1def4b16";
  const model = (agent: string, output: number) =>
    JSON.stringify({
      type: "model.call",
      agent,
      usage: { input: 100, cacheRead: 10, output, thinking: 1 },
    });
  const lines = REAL_COLLECT.split("\n");
  const firstKey = (
    JSON.parse(lines.find((l) => l.includes('"readings.decision"'))!) as {
      key: string;
    }
  ).key;
  // The same collect deciding again: every reading row again, under a second decision key.
  const again = lines
    .filter((l) => l.includes('"reading.') || l.includes('"readings.decision"'))
    .map((l) => l.replaceAll(firstKey, "D-AGAIN"));
  const log = [
    model(`assess.${assessGroup}`, 240),
    model(`assess.${assessGroup}.reread`, 60),
    model(`lane-review.${assessGroup}`, 180),
    model(`verify.claim.${claimKey.slice(0, 12)}`, 30),
    model("verify.claim.000000000000", 999),
    model("correctness.find", 999),
    ...lines,
    ...again,
    model(`assess.${assessGroup}`, 5000),
  ].join("\n");
  const rows = readProbeRows(log);
  expect(rows.decision.key).toBe("D-AGAIN");
  expect(rows.modelCalls.map((m) => m.agent)).toEqual([
    `assess.${assessGroup}`,
    `assess.${assessGroup}.reread`,
    `lane-review.${assessGroup}`,
    `verify.claim.${claimKey.slice(0, 12)}`,
  ]);
  // A Verify call whose claim no section row lists is kept on its own line, not dropped.
  expect(rows.unattributedVerifyCalls.map((m) => m.agent)).toEqual([
    "verify.claim.000000000000",
  ]);
  const counts = probeCounts(rows);
  expect(counts.verifyNotAttributable).toEqual({
    calls: 1,
    output: { total: 999, unknown: 0 },
    input: { total: 100, unknown: 0 },
  });
  expect(counts.calls["assess"]!.tokens.input).toEqual({
    total: 200,
    unknown: 0,
  });
  expect(counts.calls["verify-claim"]).toMatchObject({
    tokens: { output: { total: 30, unknown: 0 } },
    tokensFrom: { output: "model.call" },
  });
});

test("B2: a finder's kept finding is never a catch of the readings; a request resting only on it is its own line", () => {
  const rows = readProbeRows(REAL_FINDERS);
  // The writer's row: both readings failed, the request rests on a finder's claim alone.
  const score = scorePlantReadings(at("docs/guide.md", "new", 7), rows);
  expect(score).toMatchObject({
    outcome: "undecided",
    undecidedCauses: ["failed"],
    finderOnly: true,
  });
  // The same plant with a readings claim beside the finder's is the readings' catch, not finder-only.
  const both = requested([
    claim(10),
    claim(10, { key: "f1", source: "finder" }),
  ]);
  expect(scorePlantReadings(plant(1), read(both))).toMatchObject({
    outcome: "caught",
    finderOnly: false,
  });
  expect(
    scorePlantReadings(
      plant(1),
      read(requested([claim(10, { source: "finder" })])),
    ).outcome,
  ).toBe("missed");
});

test("B3: a batch of sections with no map group (mapGroup null) reads, as the writer writes it", () => {
  const nulled = REAL_COLLECT.split("\n")
    .map((line) => {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (row["type"] !== "reading.batch" || row["mapGroup"] !== "m2")
        return line;
      return JSON.stringify({ ...row, mapGroup: null, reason: "no-map-group" });
    })
    .join("\n");
  const rows = readProbeRows(nulled);
  expect(rows.batches!.some((b) => b.mapGroup === null)).toBe(true);
  // A unit of such a batch reads too.
  expect(() =>
    readProbeRows(
      rowsOf([section("s1", ["src/a.ts:new:5-15"])]).replace(
        '"type":"reading.unit","decision":"D1","mapGroup":"m1"',
        '"type":"reading.unit","decision":"D1","mapGroup":null',
      ),
    ),
  ).not.toThrow();
});

test("each catch level on hand-built rows: refuted, not rested on, under an approval, from another section, missed", () => {
  const p = plant(1);
  const of = (...rows: ReadonlyArray<Record<string, unknown>>) =>
    scorePlantReadings(p, read(...rows)).outcome;
  expect(of(requested([claim(10)]))).toBe("caught");
  expect(
    of(
      section("s1", ["src/a.ts:new:5-15"]),
      section("s2", ["src/a.ts:new:30"], {
        verdict: "request-changes",
        claims: [claim(30)],
      }),
    ),
  ).toBe("caught-beside");
  expect(of(requested([claim(10, { verify: "refuted" })]))).toBe(
    "claimed-not-standing",
  );
  expect(of(requested([claim(10, { restsOn: false }), claim(12)]))).toBe(
    "claimed-not-standing",
  );
  // A claim the row says rests on the verdict, under an approval, is not standing (the request is the verdict).
  expect(
    of(section("s1", ["src/a.ts:new:5-15"], { claims: [claim(10)] })),
  ).toBe("claimed-not-standing");
  // Raised on another section, anchored on the plant.
  expect(
    of(
      section("s1", ["src/a.ts:new:5-15"]),
      section("s2", ["src/a.ts:new:40-50"], {
        verdict: "request-changes",
        claims: [claim(10)],
      }),
    ),
  ).toBe("claimed-from-another-section");
  expect(of(section("s1", ["src/a.ts:new:5-15"]))).toBe("missed");
});

test("a plant section in an agent lane with no standing request is counted on its own line", () => {
  const p = plant(2);
  const agentic = section("s1", ["src/a.ts:new:5-15"], {
    lane: trail("agentic"),
  });
  expect(scorePlantReadings(p, read(agentic))).toMatchObject({
    outcome: "missed",
    noPersonSections: 1,
    lanes: ["agentic"],
  });
  expect(
    scorePlantReadings(
      p,
      read(requested([claim(10)], { lane: trail("agentic") })),
    ).noPersonSections,
  ).toBe(0);
});

test("the log must hold its decision row; a multi-decision log reads the last decision only, its model calls too", () => {
  expect(() =>
    readProbeRows(
      rowsOf([section("s1", ["src/a.ts:new:5-15"])], { decision: null }),
    ),
  ).toThrow(/no readings.decision row: a partial write/);
  expect(() => readProbeRows(JSON.stringify({ type: "run.started" }))).toThrow(
    new UnreadableProbe("the run log holds no reading.section rows"),
  );
  expect(() =>
    readProbeRows(
      JSON.stringify({ type: "readings.plan", plan: null, unavailable: true }),
    ),
  ).toThrow(/the readings did not run/);
  // Two decisions: the first missed the plant and made one assess call; the second caught it.
  const first = rowsOf([section("s1", ["src/a.ts:new:5-15"])], {
    calls: [call("assess")],
  });
  const second = rowsOf([requested([claim(10)])], {
    calls: [call("lane-review")],
  })
    .replaceAll('"D1"', '"D2"')
    .replaceAll('"g1"', '"g2"')
    .replaceAll(".g1", ".g2")
    .split("\n")
    .filter((l) => !l.includes('"run.started"'))
    .join("\n");
  const rows = readProbeRows(`${first}\n${second}`);
  expect(rows.decision.key).toBe("D2");
  expect(rows.sections).toHaveLength(1);
  expect(scorePlantReadings(plant(1), rows).outcome).toBe("caught");
  // The first decision's assess call is not this decision's, and neither are its model calls.
  const counts = probeCounts(rows);
  expect(Object.keys(counts.calls)).toEqual(["lane-review"]);
  expect(rows.modelCalls.map((m) => m.agent)).toEqual([
    "assess.g2",
    "lane-review.g2",
  ]);
  expect(readProbeRows(first).modelCalls).toHaveLength(2);
});

test("counts come from the named row fields; a reused call adds no sections to the tokens' denominator; no model calls is not measured", () => {
  const rows = readProbeRows(
    rowsOf([requested([claim(10), claim(90)])], {
      calls: [
        call("assess"),
        call("assess", {
          run: "reused",
          key: "k-r",
          sections: 4,
          characters: 200,
        }),
        call("lane-review"),
        call("assess", {
          run: "failed",
          key: null,
          sections: null,
          characters: null,
          failure: "invalid_request",
        }),
      ],
    }),
  );
  const c = probeCounts(rows);
  expect(c.calls["assess"]).toMatchObject({
    calls: 3,
    ran: 1,
    reused: 1,
    failed: 1,
    sections: 6,
    ranSections: 2,
    characters: 500,
    tokensFrom: { input: "model.call", output: "model.call" },
    outputTokensPerCall: 120,
    outputTokensPerSectionCovered: 60,
    answerCharactersPerSectionCovered: 83.3,
    sectionsPerCall: 3,
  });
  expect(c.calls["lane-review"]!.tokens.input!.total).toBe(800);
  expect(c.claimsOutsideTheirSection).toBe(1);
  expect(c.secondsToDecision).toBe(42);
  expect(c.secondsToFirstSettledBatch).toBeNull();
  expect(rows.absent).toContain("reading.batch settledAt");
  const bare = readProbeRows(
    rowsOf([requested([claim(10)])], { modelCalls: false }),
  );
  expect(probeCounts(bare).calls["assess"]).toMatchObject({
    tokens: { input: null, cached: null, output: null, reasoning: null },
    outputTokensPerCall: null,
  });
  expect(bare.absent).toContain("model.call (tokens not measured)");
  // The decision row tells none placed from not recorded.
  expect(bare.absent).not.toContain("finder findings placed (not recorded)");
  expect(
    readProbeRows(
      rowsOf([section("s1", ["src/a.ts:new:5-15"])], {
        decision: { findings: undefined },
      }),
    ).absent,
  ).toContain("finder findings placed (not recorded)");
  // N2: a call's own output and reasoning tokens are used before the model calls, input from them.
  const own = readProbeRows(
    rowsOf([section("s1", ["src/a.ts:new:5-15"])], {
      calls: [
        call("assess", {
          outputTokens: 7,
          reasoningTokens: 1,
          classes: 3,
          outside: 1,
        }),
      ],
    }),
  );
  expect(probeCounts(own).calls["assess"]).toMatchObject({
    tokensFrom: {
      output: "reading.call",
      reasoning: "reading.call",
      input: "model.call",
      cached: "model.call",
    },
    tokens: {
      output: { total: 7, unknown: 0 },
      input: { total: 1000, unknown: 0 },
    },
    classes: { total: 3, calls: 1 },
    outside: { total: 1, calls: 1 },
  });
});

test("identity where the rows allow it, and what cannot be checked is counted and reaches the summary", () => {
  const floored = section("s1", ["src/a.ts:new:5-15"], {
    lane: trail("human-suggested", "agentic", [
      { rule: "removal", to: "human-suggested" },
    ]),
  });
  useFloorsOf(undefined);
  expect(identityOfRows(read(floored))).toMatchObject({
    failures: [],
    floors: { checked: 0, notChecked: 1 },
    recordedLane: { checked: 0, notChecked: 1 },
  });
  useFloorsOf(() => []);
  expect(identityOfRows(read(floored)).failures).toEqual([
    "section s1: it stores the floor removal to human-suggested, which its floor inputs do not give",
  ]);
  useFloorsOf(() => [{ rule: "removal", to: "human-suggested" }]);
  expect(identityOfRows(read(floored))).toMatchObject({
    failures: [],
    floors: { checked: 1, notChecked: 0 },
  });
});

// Why (round 5d): a deviating copy judged through another section must never read as judged on its
// own. The readers write `lineage: "fresh"` for every entry (`readings/decide.ts`), so lineage fresh
// and any origin other than model or family say nothing; reading them as own hid a carried deviant.
test("F1: on the writer's rows, a deviating copy is read on its own only from its representative or a model origin, carried wins, and anything else is not measured", () => {
  // The real rows' caught section owns src/parse.ts:new:4: the deviant. Two other copies.
  const members = [
    { path: "src/old.ts", side: "old", startLine: 5, endLine: 5 },
    { path: "src/parse.ts", side: "new", startLine: 4, endLine: 4 },
    { path: "src/parse.ts", side: "new", startLine: 11, endLine: 11 },
  ];
  const p = plant(150, {
    category: "family",
    lines: [members[1]!],
    family: { members, deviant: 1 },
  } as Partial<Plant>);
  const lines = REAL_COLLECT.split("\n");
  const deviantKey = (
    JSON.parse(
      lines.find(
        (l) =>
          l.includes('"reading.section"') && l.includes("src/parse.ts:new:4"),
      )!,
    ) as { section: string }
  ).section;
  // Every section row given the same marks, as feed3 does.
  const marked = (extra: Record<string, unknown>) =>
    readProbeRows(
      lines
        .map((l) => {
          const r = JSON.parse(l) as Record<string, unknown>;
          return JSON.stringify(
            r["type"] === "reading.section" ? { ...r, ...extra } : r,
          );
        })
        .join("\n"),
    );
  const readOf = (extra: Record<string, unknown>) =>
    scorePlantReadings(p, marked(extra)).familyRead;
  for (const extra of [
    {},
    { lineage: "fresh" },
    { origin: "carried" },
    { origin: "family-member" },
    { origin: "none" },
    { origin: { assess: "model", review: "representative" } },
    { origin: { assess: "model" }, lineage: "fresh" },
    { origin: { assess: "rule", review: "none" } },
    { lineage: "copied" },
  ])
    expect([JSON.stringify(extra), readOf(extra)]).toEqual([
      JSON.stringify(extra),
      NO_FAMILY_MARK,
    ]);
  expect(readOf({ origin: { assess: "model", review: "model" } })).toBe("own");
  expect(readOf({ origin: "model" })).toBe("own");
  expect(readOf({ family: { key: "F", representative: deviantKey } })).toBe(
    "own",
  );
  expect(readOf({ origin: { assess: "model", review: "family" } })).toBe(
    "carried",
  );
  expect(readOf({ origin: "family" })).toBe("carried");
  expect(readOf({ lineage: "carried" })).toBe("carried");
  expect(readOf({ family: { key: "F", representative: "another" } })).toBe(
    "carried",
  );
  // Marks that disagree on one row: carried wins.
  expect(
    readOf({
      origin: { assess: "model", review: "model" },
      lineage: "carried",
    }),
  ).toBe("carried");
  expect(
    readOf({
      origin: { assess: "model", review: "family" },
      family: { key: "F", representative: deviantKey },
    }),
  ).toBe("carried");
});

// Why: a copy can be owned by several sections. A carried one among them must not be outweighed by
// one read on its own, and an unmarked one must not let the copy read as own; both safeguards
// survived every earlier test.
test("a copy owned by several sections: carried outweighs own and unmarked; any unmarked section makes it not measured", () => {
  const members = [1, 2, 3, 4, 5].map((n) => ({
    path: `src/m${n}.ts`,
    side: "new",
    startLine: 10,
    endLine: 20,
  }));
  const p = plant(4, {
    category: "family",
    lines: [members[2]!],
    family: { members, deviant: 2 },
  } as Partial<Plant>);
  const own = { origin: { assess: "model", review: "model" } };
  const carried = { origin: { assess: "model", review: "family" } };
  // The deviant's copy split over two sections; every other copy one section read on its own.
  const familyOf = (
    first: Record<string, unknown>,
    second: Record<string, unknown>,
  ) =>
    scorePlantReadings(
      p,
      read(
        ...[1, 2, 4, 5].map((n) =>
          section(`s${n}`, [`src/m${n}.ts:new:5-25`], own),
        ),
        section("s3a", ["src/m3.ts:new:5-15"], first),
        section("s3b", ["src/m3.ts:new:16-25"], second),
      ),
    );
  expect(familyOf(own, carried).familyRead).toBe("carried");
  expect(familyOf(carried, own).familyRead).toBe("carried");
  expect(familyOf(own, {}).familyRead).toBe(NO_FAMILY_MARK);
  expect(familyOf({}, own).familyRead).toBe(NO_FAMILY_MARK);
  expect(familyOf(carried, {}).familyRead).toBe("carried");
  expect(familyOf(own, own)).toMatchObject({
    familyRead: "own",
    familyMembers: { carried: 0, own: 4, notMeasured: 0 },
  });
  // The deviant index is the one read: the other four are counted as the other copies.
  expect(
    scorePlantReadings(
      p,
      read(
        ...[1, 2, 4, 5].map((n) =>
          section(`s${n}`, [`src/m${n}.ts:new:5-25`], carried),
        ),
        section("s3", ["src/m3.ts:new:5-25"], own),
      ),
    ),
  ).toMatchObject({
    familyRead: "own",
    familyMembers: { carried: 4, own: 0, notMeasured: 0 },
  });
});

// Why (round 5d): a family catch must be the deviating copy's own. A standing claim that reached its
// line through a carried judgement was not read on that copy; a claim on another copy, or elsewhere
// in the commit, does not name the deviant. And no row carries a claim's words, so named and not
// named cannot be told apart: the gate says so instead of guessing.
test("a family catch on the writer's rows: on the line (naming not measurable), through a carried judgement (never a catch), or claimed on another member", () => {
  const members = [
    { path: "src/old.ts", side: "old", startLine: 5, endLine: 5 },
    { path: "src/parse.ts", side: "new", startLine: 4, endLine: 4 },
    { path: "src/parse.ts", side: "new", startLine: 11, endLine: 11 },
  ];
  const p = plant(150, {
    category: "family",
    lines: [members[1]!],
    beside: [],
    mentions: ["times: 20"],
    family: { members, deviant: 1 },
  } as Partial<Plant>);
  const lines = REAL_COLLECT.split("\n");
  const withDeviant = (extra: Record<string, unknown>) =>
    readProbeRows(
      lines
        .map((l) => {
          const r = JSON.parse(l) as Record<string, unknown>;
          return JSON.stringify(
            r["type"] === "reading.section" &&
              (r["owned"] as string[]).includes("src/parse.ts:new:4")
              ? { ...r, ...extra }
              : r,
          );
        })
        .join("\n"),
    );
  // Unmarked, or read on its own: a catch, its naming not measurable from the rows.
  for (const extra of [{}, { origin: { assess: "model", review: "model" } }])
    expect(scorePlantReadings(p, withDeviant(extra))).toMatchObject({
      outcome: "caught",
      familyCatch: "caught on the line, naming not measurable",
      familyClaims: { onOtherMembers: 0, offTheFamily: 0 },
    });
  expect(NAMING_NOT_MEASURABLE).toContain("no row carries its text");
  // Carried: the same standing claim, never a catch.
  const carried = scorePlantReadings(
    p,
    withDeviant({ origin: { assess: "model", review: "family" } }),
  );
  expect(carried).toMatchObject({
    outcome: "caught-through-carried",
    familyCatch: "caught through a carried judgement",
    familyRead: "carried",
  });
  // The same claim on another copy (the deviant moved to a copy no claim touches).
  const moved = plant(151, {
    category: "family",
    lines: [{ path: "src/old.ts", side: "old", startLine: 5, endLine: 5 }],
    beside: [],
    family: { members, deviant: 0 },
  } as Partial<Plant>);
  expect(scorePlantReadings(moved, readProbeRows(REAL_COLLECT))).toMatchObject({
    outcome: "claimed-on-another-member",
    familyCatch: "claimed on another member",
    familyClaims: { onOtherMembers: 1, offTheFamily: 0 },
  });
  // A claim off every copy: a miss, its count reported (a whole-commit claim cannot be told apart).
  const apart = plant(152, {
    category: "family",
    lines: [{ path: "src/old.ts", side: "old", startLine: 5, endLine: 5 }],
    beside: [],
    family: { members: [members[0]!, members[2]!], deviant: 0 },
  } as Partial<Plant>);
  expect(scorePlantReadings(apart, readProbeRows(REAL_COLLECT))).toMatchObject({
    outcome: "missed",
    familyCatch: null,
    familyClaims: { onOtherMembers: 0, offTheFamily: 1 },
  });
  // A plant that is not a family keeps its plain catch, even in a carried section.
  expect(
    scorePlantReadings(
      at("src/parse.ts", "new", 4),
      withDeviant({ origin: { assess: "model", review: "family" } }),
    ),
  ).toMatchObject({ outcome: "caught", familyCatch: null, familyClaims: null });
});

test("excluded sections stay in the count of plant sections where no person looks", () => {
  const excluded = section("s1", ["src/a.ts:new:5-15"], {
    cause: "excluded",
    verdict: null,
    lane: trail("agentic", null),
  });
  expect(scorePlantReadings(plant(1), read(excluded))).toMatchObject({
    outcome: "excluded",
    noPersonSections: 1,
  });
});

// Runs on disk, in the local runner's layout

const variantOf = (p: Plant): SetVariant => ({
  plant: p,
  source: "planted",
  number: p.variant,
  index: "set-c.json",
  casePath: "case.json",
  base: "b".repeat(40),
  head: "h".repeat(40),
});
const writeRun = (
  root: string,
  v: SetVariant,
  run: string,
  rows: string | null,
  extra: Record<string, unknown> = {},
) => {
  const folder = join(root, v.source, String(v.number), "run", run);
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, "export.json"),
    JSON.stringify({
      finished: true,
      case: { base: v.base, head: v.head },
      exit: 0,
      wallS: 100,
      build: { commit: "abc123" },
      settings: { "review.sectionReadings": "probe" },
      runId: "R1",
      store: { path: null, kept: false },
      ...extra,
    }),
  );
  rmSync(join(folder, "readings.jsonl"), { force: true });
  if (rows !== null) writeFileSync(join(folder, "readings.jsonl"), rows);
};
const caughtRows = rowsOf([requested([claim(10)])]);
const missedRows = rowsOf([section("s1", ["src/a.ts:new:5-15"])]);
const undecidedRows = rowsOf([
  section("s1", ["src/a.ts:new:5-15"], {
    lane: trail("human-required", null),
    verdict: null,
    cause: "failed",
    reading: "assess",
  }),
]);
const waitingOf = (cause: string) =>
  rowsOf([
    section("s1", ["src/a.ts:new:5-15"], {
      state: "waiting",
      lane: null,
      floorInputs: null,
      verdict: null,
      cause,
      reading: "assess",
    }),
  ]);
const waitingRows = waitingOf("refused");
const notReachedRows = waitingOf("not-reached");

test("B4: the table keys every row by name over all runs, so one reading against two lands under the right labels", () => {
  const root = mkdtempSync(join(tmpdir(), "readings-gate-"));
  try {
    const vs = [
      variantOf(plant(1)),
      variantOf(plant(2, { category: "test-file", problem: "test-file" })),
    ];
    for (const v of vs) {
      writeRun(root, v, "two", caughtRows);
      writeRun(
        root,
        v,
        "one",
        rowsOf([section("s1", ["src/a.ts:new:5-15"])], {
          calls: [call("lane-review", { characters: 50 })],
        }),
        {
          settings: {
            "review.sectionReadings": "probe",
            "readings.mode": "one-reading",
          },
        },
      );
      writeRun(root, v, "medium", caughtRows, {
        settings: {
          "review.sectionReadings": "probe",
          "readings.effort": "medium",
        },
      });
    }
    rmSync(join(root, "planted", "2", "run", "medium", "readings.jsonl"));
    const scores = ["one", "two", "medium"].map((r) =>
      scoreProbeRun(root, r, vs),
    );
    const t = table(scores, { two: "two-readings", one: "one-reading" });
    expect(t.head).toEqual(["one-reading", "two-readings", "medium"]);
    const row = (name: string) => t.rows.find((r) => r[0] === name)!.slice(1);
    // The first run has no assess calls: the assess rows are still there, with "-" under it.
    expect(row("cost: assess: answer characters per section covered")).toEqual([
      "-",
      "150",
      "150",
    ]);
    expect(
      row("cost: lane-review: answer characters per section covered"),
    ).toEqual(["25", "50", "50"]);
    expect(row("cost: assess: calls (ran, reused, failed)")).toEqual([
      "-",
      "2 (2, 0, 0)",
      "1 (1, 0, 0)",
    ]);
    expect(row("all: caught")).toEqual(["0", "2", "1"]);
    expect(row("all: failed / unreadable / missing")).toEqual([
      "0 / 0 / 0",
      "0 / 0 / 0",
      "0 / 1 / 0",
    ]);
    expect(row("test-file: caught")).toEqual(["0", "1", "0"]);
    expect(row("identity: recordedLane checked / not checked")[1]).toMatch(
      /^0 \/ 2 /,
    );
    expect(row("settings")[0]).toContain("one-reading");
    expect(t.rows.every((r) => r.length === 4)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("B1: a candidate that turns catches into undecided or waiting fails, the plants counted not caught and listed by cause and state", () => {
  const root = mkdtempSync(join(tmpdir(), "readings-gate-"));
  try {
    const vs = [1, 2, 3, 4, 5, 6].map((n) => variantOf(plant(n)));
    for (const v of vs) {
      writeRun(root, v, "base", caughtRows);
      writeRun(root, v, "again", caughtRows);
    }
    const score = (r: string) => scoreProbeRun(root, r, vs);
    for (const [name, rows] of [
      ["undecided", undecidedRows],
      ["waiting", waitingRows],
      ["not-reached", notReachedRows],
    ] as const) {
      for (const v of vs) writeRun(root, v, name, rows);
      const result = compareProbeRuns(
        score("base"),
        score("again"),
        score(name),
      );
      expect(result.dataPoints).toBe(6);
      expect(result.categories["source-defect"]!.catches).toMatchObject({
        caught: { baseline: 6, baselineAgain: 6, candidate: 0 },
        lost: 6,
        holds: false,
      });
      expect(result.acceptance.passes).toBe(false);
      expect(result.notCaught.find((n) => n.run === name)).toMatchObject(
        name === "undecided"
          ? { byOutcome: { undecided: 6 }, undecidedByCause: { failed: 6 } }
          : name === "waiting"
            ? { byOutcome: { waiting: 6 } }
            : { byOutcome: { "not-reached": 6 } },
      );
    }
    expect(
      compareProbeRuns(score("base"), score("again"), score("base")).acceptance
        .passes,
    ).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compare: a flip between the baselines, a plant no section owns everywhere stays out, and each acceptance condition fails alone", () => {
  const root = mkdtempSync(join(tmpdir(), "readings-gate-"));
  try {
    const vs = [1, 2, 3, 4].map((n) => variantOf(plant(n)));
    const nowhere = rowsOf([section("s9", ["src/b.ts:new:1"])]);
    const plan: Record<string, [string, string, string, string]> = {
      base: [caughtRows, caughtRows, missedRows, nowhere],
      again: [caughtRows, missedRows, missedRows, nowhere],
      cand: [caughtRows, caughtRows, caughtRows, nowhere],
    };
    for (const [run, rows] of Object.entries(plan))
      for (const [i, v] of vs.entries()) writeRun(root, v, run, rows[i]!);
    const score = (r: string) => scoreProbeRun(root, r, vs);
    const result = compareProbeRuns(
      score("base"),
      score("again"),
      score("cand"),
    );
    expect(result.dataPoints).toBe(3);
    expect(result.outInAllRuns).toEqual([4]);
    expect(result.categories["source-defect"]!.catches).toMatchObject({
      caught: { baseline: 2, baselineAgain: 1, candidate: 3 },
      flips: 1,
      lost: 0,
      gained: 1,
      verdict: "better",
      holds: true,
      bothBaselinesCaught: 1,
    });
    expect(result.acceptance.passes).toBe(true);
    // No section owns it in the candidate only: a data point, not caught there, and said.
    writeRun(root, vs[0]!, "cand", nowhere);
    const moved = compareProbeRuns(
      score("base"),
      score("again"),
      score("cand"),
    );
    expect(moved.outOfReachInSomeRuns).toEqual([
      {
        variant: 1,
        outcomes: { base: "caught", again: "caught", cand: "no-section" },
      },
    ]);
    expect(moved.categories["source-defect"]!.catches.lost).toBe(1);
    writeRun(root, vs[0]!, "cand", caughtRows);
    // Mixed settings in the candidate's run.
    writeRun(root, vs[0]!, "cand", caughtRows, {
      settings: { "review.sectionReadings": "probe", other: 1 },
    });
    expect(
      compareProbeRuns(score("base"), score("again"), score("cand")).acceptance,
    ).toMatchObject({
      passes: false,
      configuration: ["cand: 2 configurations in one run"],
    });
    writeRun(root, vs[0]!, "cand", caughtRows);
    // A plant section where no person looks, alone.
    writeRun(
      root,
      vs[2]!,
      "cand",
      rowsOf([
        section("s1", ["src/a.ts:new:5-15"], { lane: trail("agentic") }),
      ]),
    );
    const unsafe = compareProbeRuns(
      score("base"),
      score("again"),
      score("cand"),
    );
    expect(unsafe.acceptance).toMatchObject({
      passes: false,
      notDataPoints: [],
      configuration: [],
    });
    expect(unsafe.acceptance.noPerson.find((r) => r.run === "cand")).toEqual({
      run: "cand",
      plants: 1,
      sections: 1,
    });
    writeRun(root, vs[2]!, "cand", caughtRows);
    // An incomplete review, alone: not a data point, and acceptance fails on it.
    writeRun(root, vs[1]!, "cand", caughtRows, { exit: 1 });
    const incomplete = compareProbeRuns(
      score("base"),
      score("again"),
      score("cand"),
    );
    expect(incomplete.acceptance).toMatchObject({
      passes: false,
      configuration: [],
      categoriesWithFewerCatches: [],
      notDataPoints: [
        { run: "cand", variant: 2, status: "failed", notComplete: ["exit 1"] },
      ],
    });
    expect(incomplete.acceptance.noPerson.every((r) => r.sections === 0)).toBe(
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run whose rows are not kept, or do not read, is unreadable, never a miss", () => {
  const root = mkdtempSync(join(tmpdir(), "readings-gate-"));
  try {
    const v = variantOf(plant(1));
    writeRun(root, v, "gone", null);
    writeRun(root, v, "bad", '{"type":"reading.section","section":"s"}\n');
    expect(scoreProbeRun(root, "gone", [v]).variants[0]).toMatchObject({
      status: "unreadable",
      outcome: null,
      notComplete: [
        "no readings rows: no readings.jsonl beside export.json, and the store was not kept",
      ],
    });
    expect(scoreProbeRun(root, "bad", [v]).variants[0]!.status).toBe(
      "unreadable",
    );
    expect(scoreProbeRun(root, "absent", [v]).variants[0]!.status).toBe(
      "missing",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("N3: a plant whose rows record no claims is not a data point and fails acceptance, never 'not caught'", () => {
  const root = mkdtempSync(join(tmpdir(), "readings-gate-"));
  try {
    const vs = [1, 2].map((n) => variantOf(plant(n)));
    const noClaims = rowsOf([
      { ...section("s1", ["src/a.ts:new:5-15"]), claims: undefined },
    ]);
    for (const v of vs) {
      writeRun(root, v, "base", noClaims);
      writeRun(root, v, "again", noClaims);
      writeRun(root, v, "cand", missedRows);
    }
    const score = (r: string) => scoreProbeRun(root, r, vs);
    expect(score("base").variants[0]!.outcome).toBe("claims-not-recorded");
    const result = compareProbeRuns(
      score("base"),
      score("again"),
      score("cand"),
    );
    expect(result.dataPoints).toBe(0);
    expect(result.acceptance.passes).toBe(false);
    expect(result.acceptance.notDataPoints).toEqual(
      ["base", "again"].flatMap((run) =>
        [1, 2].map((variant) => ({
          run,
          variant,
          status: "claims not recorded",
          notComplete: ["its plant sections' rows record no claims"],
        })),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Why (round 5d): a family plant caught only through a carried judgement is the outcome the change
// must never hide. It is not a catch, and like a plant section where no person looks it fails
// acceptance by itself, even when every category holds.
test("compare: a family plant caught only through a carried judgement fails acceptance alone, in any run", () => {
  const root = mkdtempSync(join(tmpdir(), "readings-gate-"));
  try {
    const members = [1, 2, 3, 4, 5].map((n) => ({
      path: n === 3 ? "src/a.ts" : `src/m${n}.ts`,
      side: "new",
      startLine: 10,
      endLine: 10,
    }));
    const family = variantOf(
      plant(150, {
        category: "family",
        problem: "family",
        family: { members, deviant: 2 },
      } as Partial<Plant>),
    );
    const other = variantOf(plant(1));
    const carriedRows = rowsOf([
      requested([claim(10)], {
        origin: { assess: "model", review: "family" },
        family: { key: "F", representative: "s9" },
      }),
    ]);
    for (const run of ["base", "again", "cand"]) {
      writeRun(root, other, run, caughtRows);
      writeRun(root, family, run, carriedRows);
    }
    const score = (r: string) => scoreProbeRun(root, r, [other, family]);
    expect(score("cand").variants[1]).toMatchObject({
      outcome: "caught-through-carried",
      familyCatch: "caught through a carried judgement",
    });
    const result = compareProbeRuns(
      score("base"),
      score("again"),
      score("cand"),
    );
    expect(result.dataPoints).toBe(2);
    expect(result.categories["family"]!.catches.caught).toEqual({
      baseline: 0,
      baselineAgain: 0,
      candidate: 0,
    });
    expect(result.acceptance).toMatchObject({
      passes: false,
      notDataPoints: [],
      configuration: [],
      categoriesWithFewerCatches: [],
      caughtThroughCarried: [
        { run: "base", variants: [150] },
        { run: "again", variants: [150] },
        { run: "cand", variants: [150] },
      ],
    });
    expect(result.acceptance.noPerson.every((r) => r.sections === 0)).toBe(
      true,
    );
    // Read on its own in every run: a catch, and acceptance passes.
    for (const run of ["base", "again", "cand"])
      writeRun(
        root,
        family,
        run,
        rowsOf([
          requested([claim(10)], {
            origin: { assess: "model", review: "model" },
          }),
        ]),
      );
    const own = compareProbeRuns(score("base"), score("again"), score("cand"));
    expect(own.categories["family"]!.catches.caught.candidate).toBe(1);
    expect(own.acceptance.passes).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Why (round 5d): the three test-file forms fail in different ways (a forged assertion, none at all,
// the wrong path), so a candidate that loses one form can hide behind the category total. When a
// record has no form the gate says so rather than guessing one.
test("test-file plants are reported per form as well as per category, and a record with no form says so", () => {
  const root = mkdtempSync(join(tmpdir(), "readings-gate-"));
  try {
    const testFile = (n: number, form?: string) =>
      variantOf(
        plant(n, {
          category: "test-file",
          problem: "test-file",
          ...(form === undefined ? {} : { form }),
        } as Partial<Plant>),
      );
    const vs = [
      testFile(141, "forged"),
      testFile(142, "no-assert"),
      testFile(143, "no-assert"),
      testFile(144),
      variantOf(plant(1)),
    ];
    const plan: Record<string, ReadonlyArray<string>> = {
      base: [caughtRows, caughtRows, caughtRows, missedRows, caughtRows],
      again: [caughtRows, caughtRows, missedRows, missedRows, caughtRows],
      cand: [caughtRows, missedRows, missedRows, caughtRows, caughtRows],
    };
    for (const [run, rows] of Object.entries(plan))
      for (const [i, v] of vs.entries()) writeRun(root, v, run, rows[i]!);
    const score = (r: string) => scoreProbeRun(root, r, vs);
    const cand = score("cand");
    expect(cand.variants.map((s) => s.form)).toEqual([
      "forged",
      "no-assert",
      "no-assert",
      FORM_NOT_RECORDED,
      null,
    ]);
    expect(Object.keys(cand.byForm)).toEqual([
      "forged",
      FORM_NOT_RECORDED,
      "no-assert",
    ]);
    expect(cand.byForm["no-assert"]!.outcomes).toMatchObject({
      caught: 0,
      missed: 2,
    });
    expect(cand.byCategory["test-file"]!.outcomes.caught).toBe(2);
    const result = compareProbeRuns(
      score("base"),
      score("again"),
      score("cand"),
    );
    expect(result.forms["no-assert"]!.catches).toMatchObject({
      caught: { baseline: 2, baselineAgain: 1, candidate: 0 },
      holds: false,
    });
    expect(result.forms[FORM_NOT_RECORDED]!.catches.caught.candidate).toBe(1);
    // The category alone hides the lost form: 3, 2, 2 holds against the lower baseline.
    expect(result.categories["test-file"]!.catches).toMatchObject({
      caught: { baseline: 3, baselineAgain: 2, candidate: 2 },
      holds: true,
    });
    const t = table([score("base"), cand], {});
    expect(
      t.rows.find((r) => r[0] === "test-file form no-assert: caught")!.slice(1),
    ).toEqual(["2", "0"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Why (round 5e): the readers now put each call's own input and cached input on its row. The gate
// must take them, say per column where each came from, and leave out what a cut-off or failed call
// spent from every column it takes from the call rows (the cut-off case survived every earlier test).
test("N1 at b46ecb81: input and cached input come from the call rows per column, preferred over model calls, and cut-off and failed calls are left out", () => {
  const rows = readProbeRows(REAL_B46);
  const counts = probeCounts(rows);
  expect(counts.calls["assess"]).toMatchObject({
    tokens: {
      input: { total: 1200, unknown: 0 },
      cached: { total: 300, unknown: 0 },
      output: { total: 240, unknown: 0 },
      reasoning: { total: 60, unknown: 0 },
    },
    tokensFrom: {
      input: "reading.call",
      cached: "reading.call",
      output: "reading.call",
      reasoning: "reading.call",
    },
    // The one failed Assess call.
    leftOut: 1,
  });
  expect(counts.calls["lane-review"]).toMatchObject({
    tokens: {
      input: { total: 900, unknown: 0 },
      cached: { total: 0, unknown: 0 },
    },
    // The one interrupted (cut-off) Lane review call.
    leftOut: 1,
  });
  // Cache writes are on the call rows only from ccd75a4c.
  expect(rows.absent).toContain("model.call (cache write tokens not measured)");
  expect(rows.absent).not.toContain("reading.section entry");
  // A model call for the same group: the call rows' own numbers still win.
  const group = (
    JSON.parse(
      REAL_B46.split("\n").find(
        (l) => l.includes('"kind":"assess"') && l.includes('"run":"ran"'),
      )!,
    ) as { group: string }
  ).group;
  const withModel = readProbeRows(
    [
      JSON.stringify({
        type: "model.call",
        agent: `assess.${group}`,
        usage: { input: 5, cacheRead: 5, output: 5, thinking: 5 },
      }),
      REAL_B46,
    ].join("\n"),
  );
  expect(probeCounts(withModel).calls["assess"]!.tokens.input).toEqual({
    total: 1200,
    unknown: 0,
  });
});

// Why (round 5e): `entry` on the section row lets the harness's own recordedLane recompute each
// stored lane, and the floors be checked in both directions. The gate must pass the row's own entry
// and the lines the section adds, refuse a trail or floors that do not recompute, and say exactly
// which piece is missing where it cannot check, never "the rows carry no assessment" when they do.
test("N1 identity on the writer's b46ecb81 rows: recordedLane from the row's entry and added lines, floors both ways, and the true reason where a piece is missing", () => {
  const rows = readProbeRows(REAL_B46);
  const settled = rows.sections.filter((s) => s.state === "settled");
  expect(settled).toHaveLength(9);
  // A stand-in for the harness's rule: it gives each entry the trail its own row stores, and records
  // what it was given. (The real rule, run on these rows outside the test, gives the same trails.)
  // Keyed without its floors, so the call with the inputs' floors in place finds the same entry.
  const keyOf = (entry: unknown) =>
    JSON.stringify({ ...(entry as object), lane: null });
  const stored = new Map(settled.map((s) => [keyOf(s.entry), s.lane]));
  const seen: Array<{ entry: unknown; added: ReadonlyArray<unknown> }> = [];
  const standIn = (entry: unknown, added: ReadonlyArray<unknown>) => {
    seen.push({ entry, added });
    const lane = stored.get(keyOf(entry))!;
    const floors = (entry as { lane: { floors: Array<{ to: string }> } }).lane
      .floors;
    // As the rule does: a floor more cautious than the stored lane raises it and is kept.
    return floors.some(
      (f) => f.to === "human-required" && lane!.applied !== "human-required",
    )
      ? { ...lane!, floors, applied: "human-required" }
      : lane!;
  };
  useRecordedLane(standIn as never);
  useFloorsOf(() => []);
  // No manifest: only the sections that own no new-side line can be checked.
  const without = identityOfRows(rows);
  expect(without).toMatchObject({
    failures: [],
    recordedLane: {
      checked: 3,
      notChecked: 6,
      why: { [NO_MANIFEST_GIVEN]: 6 },
    },
    floors: { checked: 9, notChecked: 0, why: {} },
    floorsRaised: { checked: 3, notChecked: 6 },
  });
  expect(JSON.stringify(without)).not.toContain("assessment");
  // With the run's manifest hunks: every settled section, each given its own row's entry.
  seen.length = 0;
  // The run's real range manifest (the same fixture at ccd75a4c): it holds every owned new-side line.
  const hunks = REAL_CCD_HUNKS;
  const withHunks = identityOfRows(rows, hunks, "unused");
  expect(withHunks).toMatchObject({
    failures: [],
    recordedLane: { checked: 9, notChecked: 0, why: {} },
    floorsRaised: { checked: 9, notChecked: 0 },
  });
  // Two calls per section: its trail, then its floor inputs' floors in place of the stored ones.
  const first = seen.filter((_, i) => i % 2 === 0);
  expect(first.map((x) => x.entry)).toEqual(settled.map((s) => s.entry));
  const caught = settled.findIndex((s) =>
    s.owned.includes("src/parse.ts:new:4"),
  );
  expect(first[caught]!.added).toEqual([
    { path: "src/parse.ts", line: 4, text: "  return x + 2;" },
  ]);
  // A trail that does not recompute is refused, field by field.
  useRecordedLane(((entry: unknown, added: ReadonlyArray<unknown>) => ({
    ...(standIn(entry, added) as object),
    applied: "agentic",
  })) as never);
  expect(identityOfRows(rows, hunks, "unused").failures[0]).toMatch(
    /recordedLane recomputes applied "agentic" from its entry where the row stores "human-/,
  );
  // Floors raised: inputs that give a floor which would have raised the lane, and none stored.
  useRecordedLane(standIn as never);
  useFloorsOf(() => [{ rule: "removal", to: "human-required" }]);
  expect(identityOfRows(rows, hunks, "unused").failures).toContain(
    `section ${settled[0]!.section}: its floor inputs give the floors [{"rule":"removal","to":"human-required"}] where the row stores []`,
  );
  // Rows from before the entry was written, and a build with no recordedLane: said, not guessed.
  useFloorsOf(() => []);
  expect(identityOfRows(readProbeRows(REAL_COLLECT)).recordedLane.why).toEqual({
    "the row carries no entry (written before the readers lane recorded it)": 9,
  });
  useRecordedLane(undefined);
  expect(identityOfRows(rows, hunks, "unused").recordedLane.why).toEqual({
    "this build's harness exports no recordedLane": 9,
  });
});

// Why (round 5e): once a writer marks family judgements, an unmarked deviating section is a gap in
// the marks, not proof the copy was read on its own. Its catch is not measured, never caught, and
// like a plant whose rows record no claims it is not a data point.
test("N3 on the writer's b46ecb81 rows: in a run whose rows carry family marks, a catch on an unmarked deviating section is not measured", () => {
  const members = [
    { path: "src/old.ts", side: "old", startLine: 5, endLine: 5 },
    { path: "src/parse.ts", side: "new", startLine: 4, endLine: 4 },
    { path: "src/parse.ts", side: "new", startLine: 11, endLine: 11 },
  ];
  const p = plant(150, {
    category: "family",
    problem: "family",
    lines: [members[1]!],
    beside: [],
    family: { members, deviant: 1 },
  } as Partial<Plant>);
  const marked = (byOwned: Record<string, Record<string, unknown>>) =>
    REAL_B46.split("\n")
      .map((l) => {
        const r = JSON.parse(l) as Record<string, unknown>;
        const extra =
          r["type"] === "reading.section"
            ? Object.entries(byOwned).find(([o]) =>
                (r["owned"] as string[]).includes(o),
              )?.[1]
            : undefined;
        return JSON.stringify(extra === undefined ? r : { ...r, ...extra });
      })
      .join("\n");
  const model = { origin: { assess: "model", review: "model" } };
  const outcome = (text: string) =>
    scorePlantReadings(p, readProbeRows(text)).outcome;
  // No row marked: the catch stands.
  expect(outcome(REAL_B46)).toBe("caught");
  // Another copy's row marked, the deviant's not: not measured.
  const gap = marked({ "src/old.ts:old:4-6": model });
  expect(scorePlantReadings(p, readProbeRows(gap))).toMatchObject({
    outcome: "catch-not-measured",
    familyCatch:
      "catch not measured: its section has no family mark while other rows of the run carry one",
  });
  // The deviant's own row marked read on its own: caught.
  expect(
    outcome(
      marked({ "src/old.ts:old:4-6": model, "src/parse.ts:new:4": model }),
    ),
  ).toBe("caught");
  // A plant that is not a family is untouched.
  expect(
    scorePlantReadings(at("src/parse.ts", "new", 4), readProbeRows(gap))
      .outcome,
  ).toBe("caught");
  // In compare: not a data point, listed, and acceptance fails.
  const root = mkdtempSync(join(tmpdir(), "readings-gate-"));
  try {
    const v = variantOf(p);
    writeRun(root, v, "base", REAL_B46);
    writeRun(root, v, "again", REAL_B46);
    writeRun(root, v, "cand", gap);
    const score = (r: string) => scoreProbeRun(root, r, [v]);
    const result = compareProbeRuns(
      score("base"),
      score("again"),
      score("cand"),
    );
    expect(result.dataPoints).toBe(0);
    expect(result.acceptance.passes).toBe(false);
    expect(result.acceptance.notDataPoints).toEqual([
      {
        run: "cand",
        variant: 150,
        status: "catch not measured",
        notComplete: [
          "its deviating copy's catch sits on a section with no family mark, while other rows of the run carry one",
        ],
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Why (round 5e): a reused computation keeps the time it was first completed, so a warm store can
// put a batch's settledAt before the review was asked for; that time must not read as seconds.
test("N2: seconds to the first settled batch only when it is not before the review's request", () => {
  const root = mkdtempSync(join(tmpdir(), "readings-gate-"));
  try {
    const v = variantOf(at("src/parse.ts", "new", 4));
    // The writer's batch settled at 10:43:11.276. The review ended at 10:43:20.
    const runAt = (wallS: number) => {
      writeRun(root, v, "r", REAL_B46, {
        at: "2026-11-12T10:43:20.000Z",
        wallS,
      });
      return probeCounts(scoreProbeRun(root, "r", [v]).variants[0]!.rows!);
    };
    expect(runAt(60)).toMatchObject({
      secondsToFirstSettledBatch: 51.3,
      secondsToFirstSettledBatchNote: null,
      requestedAtFrom: "export.json at − wallS",
    });
    expect(runAt(1)).toMatchObject({
      secondsToFirstSettledBatch: null,
      secondsToFirstSettledBatchNote: REUSED_TIME,
    });
    // A run log's own run.started row gives the request (its enqueuedAt).
    const logged = readProbeRows(
      [
        JSON.stringify({
          type: "run.started",
          at: "2026-11-12T10:43:00.000Z",
          enqueuedAt: "2026-11-12T10:42:59.000Z",
        }),
        REAL_B46,
      ].join("\n"),
    );
    expect(probeCounts(logged)).toMatchObject({
      secondsToFirstSettledBatch: 12.3,
      requestedAtFrom: "run.started",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Why (round 5f, I1): a manifest that is present but lacks a section's lines gave it nothing added,
// and the section counted as checked, though the public-surface raise reads exactly those lines. The
// reviewer's case: the real section at src/parse.ts:new:10-13 adds `export function count(...)`; made
// consistent at agentic with the raise left out of its stored trail, it must fail with the file's
// hunks and be not checked when the manifest lacks them.
test("I1 on the writer's ccd75a4c rows and manifest: a section whose owned lines the manifest does not hold is not checked", () => {
  expect(
    createHash("sha256")
      .update(REAL_CCD_HUNKS.find((h) => h.path === "data/big.txt")!.text)
      .digest("hex"),
  ).toBe(BIG_SHA256);
  const rows = readProbeRows(
    REAL_CCD.split("\n")
      .map((l) => {
        const r = JSON.parse(l) as Record<string, any>;
        if (
          r["type"] === "reading.section" &&
          (r["owned"] as string[]).includes("src/parse.ts:new:10-13")
        ) {
          r["entry"].assess.gaps = [];
          delete r["entry"].undecided;
          r["cause"] = null;
          r["reading"] = null;
          r["lane"] = {
            judged: "agentic",
            surfaced: "agentic",
            floors: [],
            applied: "agentic",
          };
        }
        return JSON.stringify(r);
      })
      .join("\n"),
  );
  // A stand-in for the harness's rule: each entry's stored trail, raised to human-suggested where
  // an added line exports a name (the public-surface raise), as the real rule does on this section.
  const stored = new Map(
    rows.sections.map((s) => [
      JSON.stringify({ ...(s.entry as object), lane: null }),
      s.lane,
    ]),
  );
  useRecordedLane(((entry: unknown, added: ReadonlyArray<{ text: string }>) => {
    const lane = stored.get(
      JSON.stringify({ ...(entry as object), lane: null }),
    )!;
    return added.some((a) => a.text.startsWith("export ")) &&
      lane.applied === "agentic"
      ? { ...lane, surfaced: "human-suggested", applied: "human-suggested" }
      : lane;
  }) as never);
  useFloorsOf(() => []);
  const full = identityOfRows(rows, REAL_CCD_HUNKS, "unused");
  expect(full.recordedLane.checked).toBe(9);
  expect(full.failures).toEqual([
    expect.stringContaining(
      'recordedLane recomputes surfaced "human-suggested" from its entry where the row stores "agentic"',
    ),
    expect.stringContaining(
      'recordedLane recomputes applied "human-suggested" from its entry where the row stores "agentic"',
    ),
  ]);
  for (const hunks of [
    REAL_CCD_HUNKS.filter((h) => h.path !== "src/parse.ts"),
    [],
  ]) {
    const lacking = identityOfRows(rows, hunks, "unused");
    expect(lacking.failures).toEqual([]);
    expect(lacking.recordedLane.why[MANIFEST_LACKS_LINES]).toBeGreaterThan(0);
    expect(lacking.recordedLane.checked).toBeLessThan(9);
  }
  // Without src/parse.ts: exactly its three sections with new-side lines are held back.
  expect(
    identityOfRows(
      rows,
      REAL_CCD_HUNKS.filter((h) => h.path !== "src/parse.ts"),
      "unused",
    ).recordedLane,
  ).toMatchObject({
    checked: 7,
    notChecked: 2,
    why: { [MANIFEST_LACKS_LINES]: 2 },
  });
});

// Why (round 5f): on the readers' first real run 155 of 158 judged sections carry code's own
// relations-unavailable gap, which sends them to human-suggested whatever the readings judged. Only
// a recomputation that leaves code's gaps out says how the readings themselves judged. Rows from
// before the readers lane's round 2h keep each gap's axis only, so on those it cannot be done: the
// gate says so instead of dropping every gap on an axis.
test("two lanes per section on the writer's rows: applied, and recomputed with code's own gaps left out only where each gap's kind is on the row", () => {
  const root = mkdtempSync(join(tmpdir(), "readings-gate-"));
  try {
    const v = variantOf(at("src/parse.ts", "new", 4));
    const write = (rows: string) => {
      writeRun(root, v, "r", rows);
      writeFileSync(
        join(root, v.source, String(v.number), "run", "r", "show.json"),
        JSON.stringify({ manifest: { hunks: REAL_CCD_HUNKS } }),
      );
      return scoreProbeRun(root, "r", [v]);
    };
    // A stand-in for the harness's rule: the row's own stored trail for its own entry (so the
    // identity check holds), and, for an entry with gaps left out, the reading's lean (as laneOf
    // gives once no gap holds the section at human-suggested).
    const rowsOfCcd = readProbeRows(REAL_CCD).sections;
    const keyOf = (entry: any) =>
      JSON.stringify({
        ...entry,
        lane: null,
        assess:
          entry.assess === null
            ? null
            : { ...entry.assess, gaps: entry.assess.gaps.length },
      });
    const stored = new Map(
      rowsOfCcd
        .filter((s) => s.entry)
        .map((s) => [keyOf(s.entry), { lane: s.lane!, entry: s.entry as any }]),
    );
    useRecordedLane(((entry: any) => {
      const same = stored.get(keyOf(entry));
      if (same !== undefined) return same.lane;
      const lean = entry.assess?.lean?.lane ?? "human-required";
      const applied = entry.undecided !== undefined ? "human-required" : lean;
      return { judged: lean, surfaced: lean, floors: [], applied };
    }) as never);
    // Today's rows: the gap's kind is not on the row, so not measured, with the reason.
    const today = write(REAL_CCD);
    expect(today.overall.settledWithoutCodeGaps.notMeasured).toEqual({
      [GAP_KIND_NOT_RECORDED]: 3,
    });
    // The six with no assessment need no gap's kind: four undecided, two excluded files.
    expect(today.overall.settledWithoutCodeGaps.lanes).toEqual({
      "human-required": 4,
      "human-suggested": 2,
    });
    expect(today.variants[0]!.plantLanes).toEqual([
      expect.objectContaining({
        applied: "human-suggested",
        withoutCodeGaps: `not measured: ${GAP_KIND_NOT_RECORDED}`,
      }),
    ]);
    // With each gap's kind on the row (code's relations-unavailable): left out, and the reading's
    // own lean shows; the run's lane is unchanged beside it.
    const kinded = write(
      REAL_CCD.split("\n")
        .map((l) => {
          const r = JSON.parse(l) as Record<string, any>;
          if (r["type"] === "reading.section" && r["entry"]?.assess)
            r["entry"].assess.gaps = r["entry"].assess.gaps.map(
              (g: object) => ({ ...g, kind: "relations-unavailable" }),
            );
          return JSON.stringify(r);
        })
        .join("\n"),
    );
    expect(kinded.variants[0]!.plantLanes).toEqual([
      expect.objectContaining({
        applied: "human-suggested",
        withoutCodeGaps: "agentic",
      }),
    ]);
    expect(kinded.overall.plantSectionLanes).toEqual({
      "human-suggested → agentic": 1,
    });
    expect(kinded.overall.costs.settledByLane["human-suggested"]).toBe(4);
    // A gap the reading wrote (`model`) stays in; a kind the gate does not know is not measured.
    const kindedAs = (kind: string) =>
      write(
        REAL_CCD.split("\n")
          .map((l) => {
            const r = JSON.parse(l) as Record<string, any>;
            if (r["type"] === "reading.section" && r["entry"]?.assess)
              r["entry"].assess.gaps = r["entry"].assess.gaps.map(
                (g: object) => ({ ...g, kind }),
              );
            return JSON.stringify(r);
          })
          .join("\n"),
      );
    expect(kindedAs("model").variants[0]!.plantLanes[0]!.withoutCodeGaps).toBe(
      "human-suggested",
    );
    const unknown = kindedAs("flaky-test");
    expect(unknown.variants[0]!.plantLanes[0]!.withoutCodeGaps).toBe(
      `not measured: ${unknownGapKind(["flaky-test"])}`,
    );
    expect(unknown.overall.settledWithoutCodeGaps.notMeasured).toEqual({
      [unknownGapKind(["flaky-test"])]: 3,
    });
    // A build with no recordedLane: not measured, never the run's lane.
    useRecordedLane(undefined);
    expect(write(REAL_CCD).overall.settledWithoutCodeGaps).toEqual({
      lanes: {},
      notMeasured: { "this build's harness exports no recordedLane": 9 },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Why (round 5f): a plant whose section the review's time ran out before is not a miss of the
// readings and not a refusal; it gets its own line, and stays not caught in compare.
test("not reached on the writer's rows: its own outcome in score, table and compare, not caught", () => {
  const root = mkdtempSync(join(tmpdir(), "readings-gate-"));
  try {
    const reached = variantOf(at("src/parse.ts", "new", 4));
    const notYet = variantOf(
      plant(2, {
        lines: [
          { path: "docs/guide.md", side: "new", startLine: 7, endLine: 7 },
        ],
        beside: [],
      }),
    );
    for (const run of ["base", "again", "cand"])
      for (const v of [reached, notYet]) writeRun(root, v, run, REAL_CCD);
    const score = (r: string) => scoreProbeRun(root, r, [reached, notYet]);
    const cand = score("cand");
    expect(cand.variants.map((s) => s.outcome)).toEqual([
      "caught",
      "not-reached",
    ]);
    expect(cand.overall.outcomes).toMatchObject({
      "not-reached": 1,
      waiting: 0,
      undecided: 0,
    });
    const t = table([score("base"), cand], {});
    expect(
      t.rows
        .find(
          (r) =>
            r[0] ===
            "all: NOT REACHED (the review's time ran out before its reading)",
        )!
        .slice(1),
    ).toEqual(["1", "1"]);
    const result = compareProbeRuns(score("base"), score("again"), cand);
    expect(result.dataPoints).toBe(2);
    expect(result.overall.catches.caught.candidate).toBe(1);
    expect(result.notCaught.find((n) => n.run === "cand")!.byOutcome).toEqual({
      "not-reached": 1,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Why (round 5f): ccd75a4c counts cache writes apart from input, and marks a batch with reused steps,
// whose settledAt may be an earlier run's.
test("cache writes are their own column, and a batch with reused steps is left out of the first settled batch", () => {
  const rows = readProbeRows(REAL_CCD);
  const counts = probeCounts(rows);
  expect(counts.calls["assess"]).toMatchObject({
    tokens: {
      input: { total: 1200, unknown: 0 },
      cached: { total: 300, unknown: 0 },
      cacheWrite: { total: 5200, unknown: 0 },
    },
    tokensFrom: { cacheWrite: "reading.call" },
  });
  // The only batch with a time has a reused step: no first settled batch of this run's.
  expect(
    rows.batches!.find(
      (b) => b.settledAt !== null && b.settledAt !== undefined,
    )!.reused,
  ).toBe(1);
  const timed = { ...rows, requestedAt: "2026-11-12T11:00:00.000Z" };
  expect(probeCounts(timed).secondsToFirstSettledBatch).toBeNull();
  const fresh = {
    ...timed,
    batches: rows.batches!.map((b) => ({ ...b, reused: 0 })),
  };
  expect(probeCounts(fresh).secondsToFirstSettledBatch).toBe(201.4);
  // The prepare row is read for the counts.
  const prepared = readProbeRows(
    [
      JSON.stringify({
        type: "readings.prepare",
        taskId: 7,
        status: "ok",
        durationMs: 1817,
      }),
      REAL_CCD,
    ].join("\n"),
  );
  expect(probeCounts(prepared).prepare).toEqual({
    status: "ok",
    durationMs: 1817,
  });
});

// Why (round 5f): two orders the code had right and no test held. A carried catch goes before
// "catch not measured" (the carried one fails acceptance by itself); and an identity check that
// fails makes the review unreadable, never scored.
test("carried precedes not measured on one copy, and a failed identity check makes the review unreadable", () => {
  const members = [1, 2, 3, 4, 5].map((n) => ({
    path: n === 3 ? "src/a.ts" : `src/m${n}.ts`,
    side: "new",
    startLine: 10,
    endLine: 20,
  }));
  const p = plant(150, {
    category: "family",
    lines: [members[2]!],
    beside: [],
    family: { members, deviant: 2 },
  } as Partial<Plant>);
  // The deviant copy split in two: one carried section holding the catch, one unmarked holding one too.
  const rows = read(
    section("s3a", ["src/a.ts:new:10-15"], {
      verdict: "request-changes",
      claims: [claim(12)],
      origin: { assess: "model", review: "family" },
    }),
    section("s3b", ["src/a.ts:new:16-20"], {
      verdict: "request-changes",
      claims: [claim(18)],
    }),
  );
  expect(scorePlantReadings(p, rows).outcome).toBe("caught-through-carried");
  const root = mkdtempSync(join(tmpdir(), "readings-gate-"));
  try {
    const v = variantOf(plant(1));
    writeRun(root, v, "r", REAL_CCD);
    useRecordedLane(((_entry: unknown) => ({
      judged: "agentic",
      surfaced: "agentic",
      floors: [],
      applied: "agentic",
    })) as never);
    const scored = scoreProbeRun(root, "r", [v]).variants[0]!;
    expect(scored.status).toBe("unreadable");
    expect(scored.notComplete[0]).toMatch(
      /^the identity check failed: section /,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Why (round 6): since the readers lane's round 2h every gap carries a kind, code's two or `model`.
// Leaving out a gap that is not code's, or keeping one that is, moves the recomputed lane with no
// sign; a kind the gate does not know might be either, so treating it as the reading's would be a
// guess.
test("the second lane drops exactly code's own gaps and keeps the readings' model gaps; an unknown kind is not measured and named", () => {
  const base = readProbeRows(REAL_CCD).sections.find((s) =>
    s.owned.includes("src/parse.ts:new:4"),
  )!;
  const withGaps = (gaps: ReadonlyArray<Record<string, unknown>>) =>
    ({
      ...base,
      entry: {
        ...base.entry!,
        assess: { ...(base.entry!.assess as object), gaps },
      },
    }) as SectionRow;
  const seen: unknown[] = [];
  useRecordedLane(((entry: any) => {
    seen.push(entry.assess.gaps);
    return {
      judged: "agentic",
      surfaced: "agentic",
      floors: [],
      applied: "agentic",
    };
  }) as never);
  const relations = {
    axis: "ease-of-validation",
    kind: "relations-unavailable",
  };
  const structure = { axis: "complexity", kind: "structure-unavailable" };
  const model = { axis: "ease-of-validation", kind: "model" };
  const modelToo = { axis: "complexity", kind: "model" };
  expect(
    laneWithoutCodeGaps(
      withGaps([relations, model, structure, modelToo]),
      REAL_CCD_HUNKS,
      "unused",
    ),
  ).toEqual({ lane: "agentic" });
  expect(seen).toEqual([[model, modelToo]]);
  seen.length = 0;
  const unknown = { axis: "complexity", kind: "flaky-test" };
  expect(
    laneWithoutCodeGaps(
      withGaps([relations, unknown, model]),
      REAL_CCD_HUNKS,
      "unused",
    ),
  ).toEqual({ why: unknownGapKind(["flaky-test"]) });
  expect(unknownGapKind(["flaky-test"])).toContain("(flaky-test)");
  expect(seen).toEqual([]);
  // A gap with no kind (a row from before round 2h) stays as before.
  expect(
    laneWithoutCodeGaps(
      withGaps([{ axis: "ease-of-validation" }, model]),
      REAL_CCD_HUNKS,
      "unused",
    ),
  ).toEqual({ why: GAP_KIND_NOT_RECORDED });
});

// Why (round 6): in a checkout whose node_modules belongs to another worktree, the package import
// is that worktree's harness, and a rule that did not load would read as "not measured" on every
// section. A file that does not load, or exports neither function, must fail with its path, and
// leave the seams as they were.
test("--lane-rule: a file that exports neither function, or does not load, fails with its path; one that exports recordedLane takes that seam alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "readings-gate-rule-"));
  try {
    const standIn = () => ({
      judged: null,
      surfaced: null,
      floors: [],
      applied: "agentic",
    });
    const floorsStandIn = () => [];
    useRecordedLane(standIn as never);
    useFloorsOf(floorsStandIn);
    const neither = join(dir, "neither.ts");
    writeFileSync(neither, "export const laneOf = () => null;\n");
    await expect(useLaneRuleFile(neither)).rejects.toThrow(
      `--lane-rule ${neither} exports neither recordedLane nor floorsOf`,
    );
    const broken = join(dir, "broken.ts");
    writeFileSync(broken, "export const = ;\n");
    await expect(useLaneRuleFile(broken)).rejects.toThrow(
      `--lane-rule ${broken} does not load`,
    );
    const absent = join(dir, "absent.ts");
    await expect(useLaneRuleFile(absent)).rejects.toThrow(
      `--lane-rule ${absent}: no such file`,
    );
    const lane = useRecordedLane(undefined);
    const floors = useFloorsOf(undefined);
    expect(lane).toBe(standIn as never);
    expect(floors).toBe(floorsStandIn);
    const only = join(dir, "only.ts");
    writeFileSync(
      only,
      'export const recordedLane = () => ({ judged: null, surfaced: null, floors: [], applied: "human-required" });\n',
    );
    useFloorsOf(floorsStandIn);
    const source = await useLaneRuleFile(only);
    expect(source).toEqual({
      from: "file",
      path: only,
      recordedLane: true,
      floorsOf: false,
    });
    expect(laneRuleLine(source)).toBe(
      `lane rule: the file ${only}; exports recordedLane yes, floorsOf no`,
    );
    const loaded = useRecordedLane(undefined);
    expect(loaded!({} as never, []).applied).toBe("human-required");
    expect(useFloorsOf(undefined)).toBeUndefined();
    // Without the flag: the package import as it left the seams, with the path it resolves to.
    useRecordedLane(originalLane);
    useFloorsOf(original);
    const pkg = packageLaneRule();
    expect(pkg).toMatchObject({
      from: "package import",
      recordedLane: originalLane !== undefined,
      floorsOf: original !== undefined,
    });
    expect(pkg.path).toMatch(/packages\/harness\/src\/lane-rule\.ts$/);
    expect(laneRuleLine(pkg)).toContain(
      `the package import @neuve/harness/lane-rule, resolved to ${pkg.path}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Why (round 6): a plain probe folder has no plants, so nothing else reads its lanes. A move keyed
// on the wrong lane, or a recomputation kept where the rule does not give the run's own lanes,
// would print plausible numbers.
test("probe: a plain run folder's lanes two ways, the moves between them, and gaps by axis and kind; nothing recomputed when identity fails", () => {
  const root = mkdtempSync(join(tmpdir(), "readings-gate-"));
  try {
    const v = variantOf(at("src/parse.ts", "new", 4));
    const folder = join(root, v.source, String(v.number), "run", "p");
    writeRun(
      root,
      v,
      "p",
      REAL_CCD.split("\n")
        .map((l) => {
          const r = JSON.parse(l) as Record<string, any>;
          if (r["type"] === "reading.section" && r["entry"]?.assess)
            r["entry"].assess.gaps = r["entry"].assess.gaps.map(
              (g: object) => ({ ...g, kind: "relations-unavailable" }),
            );
          return JSON.stringify(r);
        })
        .join("\n"),
    );
    writeFileSync(
      join(folder, "show.json"),
      JSON.stringify({ manifest: { hunks: REAL_CCD_HUNKS } }),
    );
    // The stand-in: a section's stored trail for its own entry (identity holds); once code's gaps
    // are out, agentic where it asks for nothing more, human-required where it is undecided.
    const stored = new Map(
      readProbeRows(REAL_CCD)
        .sections.filter((s) => s.entry)
        .map((s) => [
          JSON.stringify({ ...(s.entry as object), lane: null }),
          s.lane!,
        ]),
    );
    const keyOf = (entry: any) =>
      JSON.stringify({
        ...entry,
        lane: null,
        assess:
          entry.assess === null
            ? null
            : {
                ...entry.assess,
                gaps: entry.assess.gaps.map((g: { axis: string }) => ({
                  axis: g.axis,
                })),
              },
      });
    useRecordedLane(((entry: any) => {
      if (entry.assess?.gaps?.length > 0 || entry.assess === null)
        return stored.get(keyOf(entry))!;
      const applied =
        entry.undecided !== undefined ? "human-required" : "agentic";
      return { judged: applied, surfaced: applied, floors: [], applied };
    }) as never);
    useFloorsOf(() => []);
    const p = probeFolder(folder);
    expect(p.status).toBe("read");
    expect(p.identity!.recordedLane).toMatchObject({ checked: 9 });
    expect(p.counts!.settledByLane).toEqual({
      "human-suggested": 4,
      "human-required": 5,
    });
    // The three sections with gaps: two human-suggested ones move to agentic, the undecided one stays.
    expect(p.lanes).toEqual({
      applied: { "human-suggested": 4, "human-required": 5 },
      recomputedWithoutCodeGaps: {
        agentic: 2,
        "human-suggested": 2,
        "human-required": 5,
      },
      moves: {
        "human-suggested → agentic": 2,
        "human-suggested → human-suggested": 2,
        "human-required → human-required": 5,
      },
      notMeasured: {},
    });
    expect(p.gaps).toEqual({ "ease-of-validation / relations-unavailable": 3 });
    // A rule that does not give the run's own lanes recomputes nothing.
    useRecordedLane((() => ({
      judged: "agentic",
      surfaced: "agentic",
      floors: [],
      applied: "agentic",
    })) as never);
    const off = probeFolder(folder);
    expect(off.status).toBe("unreadable");
    expect(off.notComplete[0]).toContain("the identity check failed");
    expect(off.lanes).toMatchObject({
      recomputedWithoutCodeGaps: {},
      moves: {},
      notMeasured: { [IDENTITY_FAILED]: 9 },
    });
    expect(probeFolder(join(root, "none")).status).toBe("missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
