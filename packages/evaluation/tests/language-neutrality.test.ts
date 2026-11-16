import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const repository = resolve(import.meta.dir, "../../..");

describe("repository-language neutrality", () => {
  test("constitution makes repository-language neutrality durable", async () => {
    const constitution = await Bun.file(
      resolve(repository, "CONSTITUTION.md"),
    ).text();

    expect(constitution).toContain("## Repository-language neutrality");
    expect(constitution).toContain(
      "must not infer evidence eligibility or trust from a programming-language name or file-extension allowlist",
    );
  });
});
