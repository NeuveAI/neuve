import { expect, test } from "bun:test";
import { repositoryOwner } from "../src/budget/owner.ts";
import { Request } from "../src/budget/scheduler.ts";

// Owner equality must survive path hashing, and long paths must fit the socket's schema.
test("repository owners preserve exact path identity within the request bound", () => {
  expect(repositoryOwner("/checkout/repo")).toBe(
    "repository:8eede564242f073fb6a01adbb0a794a725abce936f32c0731c488347e2953010",
  );
  const repository = `/checkout/${"nested/".repeat(40)}repo`;
  const first = repositoryOwner(repository);
  const second = repositoryOwner(repository);
  expect(first).toBe(second);
  expect(repositoryOwner(`${repository}-other`)).not.toBe(first);
  expect(repositoryOwner(`${repository}/.`)).not.toBe(first);
  expect(first).toMatch(/^repository:[a-f0-9]{64}$/);
  expect(first).toHaveLength(75);
  const request = {
    owner: first,
    priority: { class: "interactive", position: "new", stage: 0 },
    resource: { kind: "cpu", permits: 1 },
  };
  expect(Request.parse(request).owner).toBe(first);
  expect(Request.safeParse({ ...request, owner: repository }).success).toBe(
    false,
  );
  expect(
    Request.safeParse({ ...request, owner: "x".repeat(129) }).success,
  ).toBe(false);
});
