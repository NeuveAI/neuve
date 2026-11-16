// The shared traversal must preserve own-key reconstruction, ordered arrays and lazy pruning.
import { expect, test } from "bun:test";
import { foldJson, rebuildJson } from "../../../src/pi/capture/json-walk.ts";
import type { Json } from "../../../src/pi/capture/types.ts";

test("the JSON fold rebuilds own protocol-looking keys and arrays without prototype mutation", () => {
  const value: Json = JSON.parse(
    '{"__proto__":{"text":"café"},"constructor":{"prototype":"kept"},"array":["first",2,null,true]}',
  );
  const transformed = foldJson(
    value,
    undefined,
    (value, _state, children): Json =>
      typeof value === "string"
        ? `${value}!`
        : rebuildJson(
            value,
            children(() => undefined),
          ),
  );
  expect(JSON.stringify(transformed)).toBe(
    '{"__proto__":{"text":"café!"},"constructor":{"prototype":"kept!"},"array":["first!",2,null,true]}',
  );
  if (transformed === null || typeof transformed !== "object")
    throw new Error("expected rebuilt object");
  expect(Object.getPrototypeOf(transformed)).toBe(Object.prototype);
  expect(Object.hasOwn(transformed, "__proto__")).toBe(true);
  expect(JSON.stringify(value)).toBe(
    '{"__proto__":{"text":"café"},"constructor":{"prototype":"kept"},"array":["first",2,null,true]}',
  );
});

test("the JSON fold prunes a subtree and stops before unrequested siblings", () => {
  const visited: Json[] = [];
  const found = foldJson<Json | undefined, boolean>(
    {
      ignored: { payload: "not visited" },
      match: "target",
      after: "not visited",
    },
    undefined,
    (value, prune, children) => {
      if (prune !== undefined) return false;
      if (typeof value === "string") {
        visited.push(value);
        return value === "target";
      }
      for (const [, match] of children((key, child) =>
        key === "ignored" ? child : undefined,
      ))
        if (match) return true;
      return false;
    },
  );
  expect(found).toBe(true);
  expect(visited).toEqual(["target"]);
});

test("own-key traversal excludes inherited values after direct-key enumeration", () => {
  const value = { visible: ["first", "second"] };
  Object.setPrototypeOf(value, { inherited: "must not be visited" });
  const found = foldJson<undefined, string[]>(
    value,
    undefined,
    (value, _state, children) => {
      if (typeof value === "string") return [value];
      const strings: string[] = [];
      for (const [, child] of children(() => undefined)) strings.push(...child);
      return strings;
    },
  );
  expect(found).toEqual(["first", "second"]);
});
