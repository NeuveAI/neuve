// Cache identity and the Records packet boundary must stay stable unless their versions change.
import { expect, test } from "bun:test";
import { z } from "zod";
import { Computations, canonicalJson, sha256Hex } from "@neuve/records-core";
import * as Stored from "@neuve/records-schema";
import { AssembledBatch, UnitsPlan } from "../src/compose.ts";
import { FrameSubmission, Frame, FRAME_PROMPT_VERSION } from "../src/frame.ts";
import {
  MapSubmission,
  ReviewMap,
  MAP_PROMPT_VERSION,
} from "../src/review-map.ts";
import { FindSubmission, FindStored } from "../src/find.ts";
import { VerifySubmission, VerifyStored } from "../src/verify.ts";
import { LinkedReview } from "../src/disposition.ts";
import { PIPELINE_VERSION, defaultConfig, runKeyFor } from "../src/config.ts";
import { agentStageSpec } from "../src/pipeline.ts";
import { PUBLISH_VERSION } from "../src/publish.ts";
import { OPUS_ROUTE, SOL_ROUTE } from "../src/route.ts";
import { wireSchema } from "../src/toolkit.ts";

const hash = (value: unknown) => sha256Hex(canonicalJson(value as never));
export const fingerprints = () => ({
  submissions: Object.fromEntries(
    Object.entries({
      frame: FrameSubmission,
      map: MapSubmission,
      find: FindSubmission,
      verify: VerifySubmission,
    }).map(([name, schema]) => [name, hash(wireSchema(schema))]),
  ),
  stored: Object.fromEntries(
    Object.entries({
      frame: Frame,
      map: ReviewMap,
      find: FindStored,
      verify: VerifyStored,
      linked: LinkedReview,
      assembled: AssembledBatch,
    }).map(([name, schema]) => [
      name,
      hash(z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" })),
    ]),
  ),
  versions: {
    FRAME_PROMPT_VERSION,
    MAP_PROMPT_VERSION,
    PUBLISH_VERSION,
    PIPELINE_VERSION,
  },
});
const EXPECTED = {
  submissions: {
    frame: "96c50d44e491bb7ad48697e0b39d89e646dc26e09dd72e23c53bf262a98ea5e8",
    map: "30f819efe9d22ab3bc778d9d2a9ed66eaaef577cd6872c21549de9f88a409a6e",
    find: "557bcaf0405fbe00c7b331d4a44061fcc20501947f8dc32ee241724655f07c58",
    verify: "5ef1c18762c6d38f7171c1cafa5bf895dc6e615b226424667fbb3a584ed88e6b",
  },
  stored: {
    frame: "54a726c8759192afd4461fdb6adf0524096ce0b0cd0d3b2e5f09da1ab97b9de0",
    map: "9fdd94151371b85204a9beaed155c8b28f503c961f10d410c7f0d1bc73db7ebc",
    find: "1e852c88549508f2c536cc53fc9c361b9769ce30daf5c607cae33ee942acaadb",
    verify: "197659c0e6f55cfe89e88eb82feb68b861a49bdf3614df21b26c1e0d10a1bb79",
    linked: "9e215f806f241f48e3c3568f302315b32f8a69dcdc263ed46a8a998e491fd658",
    assembled:
      "838a4dc7b0e8a7dcf104201b1af0869f8826eb45bb107d2d33cbddc36c5f8430",
  },
  versions: {
    FRAME_PROMPT_VERSION: 1,
    MAP_PROMPT_VERSION: 2,
    PUBLISH_VERSION: 7,
    PIPELINE_VERSION: 12,
  },
};
if (process.env["PRINT_FINGERPRINTS"] === "1")
  console.log(JSON.stringify(fingerprints()));
test("current submission and stored schema fingerprints match their versions", () => {
  expect(fingerprints()).toEqual(EXPECTED);
});
test("the harness writes the packet schemas Records reads", () => {
  expect(AssembledBatch).toBe(Stored.AssembledBatch);
  expect(UnitsPlan.shape.confirmation).toBe(Stored.UnitsConfirmation);
  expect(LinkedReview.shape.guided).toBe(Stored.GuidedBasis);
  expect(hash(z.toJSONSchema(AssembledBatch, { io: "input" }))).toBe(
    "838a4dc7b0e8a7dcf104201b1af0869f8826eb45bb107d2d33cbddc36c5f8430",
  );
});
test("new runs have distinct keys while agent keys bind retry policy and reuse across run lifetimes", () => {
  const range = {
    baseRef: "main",
    baseOid: "a".repeat(40),
    headOid: "b".repeat(40),
  };
  const config = defaultConfig(undefined, OPUS_ROUTE);
  expect(PIPELINE_VERSION).toBe(12);
  expect(runKeyFor(range, config)).not.toBe(
    runKeyFor(range, defaultConfig(undefined, SOL_ROUTE)),
  );
  const key = (retry: number, settings = config) =>
    Computations.computationKey(
      agentStageSpec(
        settings,
        { stage: "frame", turnLimit: 1, retries: retry, agent: "frame" },
        {
          op: "harness.frame",
          opVersion: FRAME_PROMPT_VERSION,
          inputs: { basis: "scope" },
        },
      ),
    ).key;
  expect(key(1)).not.toBe(key(2));
  expect(key(1)).toBe(
    key(1, {
      ...config,
      budgets: {
        ...config.budgets,
        lifetimeMs: 1_200_000,
        cutoffMs: 1_150_000,
      },
    }),
  );
});
