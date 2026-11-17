import { test } from "bun:test";
import { checkProjection } from "./canonical-projection-fixture.ts";

// Each file owns one quarter of the mutations so file shards can share the work.
test(
  "every carried projection leaf and membership refuses mutation against fixed SQLite and journal (4/4)",
  () => checkProjection(3),
  600_000,
);
