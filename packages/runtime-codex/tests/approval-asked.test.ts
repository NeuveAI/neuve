// A permission the mapper drops can become an approval the person never saw.
import { expect, test } from "bun:test";
import { describeApproval } from "../src/approval-asked.ts";

const permission = (fileSystem: unknown, network: unknown = null) => ({
  method: "item/permissions/requestApproval" as const,
  params: {
    cwd: "/work ",
    reason: " More access\n",
    permissions: { network, fileSystem },
  },
});

test("legacy paths and all entries reach the card together, including root write and deny", () => {
  expect(
    describeApproval(
      permission(
        {
          read: ["/read "],
          write: ["/write\n"],
          globScanMaxDepth: 4,
          entries: [
            { path: { type: "path", path: "/" }, access: "write" },
            {
              path: { type: "special", value: { kind: "root" } },
              access: "write",
            },
            {
              path: { type: "glob_pattern", pattern: "**/.env\u202e" },
              access: "deny",
            },
            {
              path: {
                type: "special",
                value: { kind: "project_roots", subpath: "../docs " },
              },
              access: "read",
            },
            {
              path: {
                type: "special",
                value: { kind: "project_roots", subpath: null },
              },
              access: "write",
            },
            {
              path: { type: "special", value: { kind: "tmpdir" } },
              access: "write",
            },
            {
              path: { type: "special", value: { kind: "slash_tmp" } },
              access: "read",
            },
            {
              path: { type: "special", value: { kind: "minimal" } },
              access: "read",
            },
          ],
        },
        { enabled: true },
      ),
    ),
  ).toEqual({
    kind: "wider-access",
    folder: "/work ",
    reason: " More access\n",
    network: true,
    globDepthLimit: 4,
    paths: [
      { target: { kind: "path", path: "/read " }, access: "read" },
      { target: { kind: "path", path: "/write\n" }, access: "write" },
      { target: { kind: "path", path: "/" }, access: "write" },
      { target: { kind: "root" }, access: "write" },
      { target: { kind: "glob", pattern: "**/.env\u202e" }, access: "deny" },
      {
        target: { kind: "project-roots", subpath: "../docs " },
        access: "read",
      },
      { target: { kind: "project-roots" }, access: "write" },
      { target: { kind: "tmpdir" }, access: "write" },
      { target: { kind: "slash-tmp" }, access: "read" },
      { target: { kind: "minimal" }, access: "read" },
    ],
  });
});

test("entries-only and legacy-only profiles are both described", () => {
  expect(
    describeApproval(
      permission(
        { entries: [{ path: { type: "path", path: "/" }, access: "write" }] },
        { enabled: false },
      ),
    ),
  ).toEqual({
    kind: "wider-access",
    folder: "/work ",
    reason: " More access\n",
    network: false,
    paths: [{ target: { kind: "path", path: "/" }, access: "write" }],
  });
  expect(
    describeApproval(permission({ read: ["/read"], write: ["/write"] })),
  ).toEqual({
    kind: "wider-access",
    folder: "/work ",
    reason: " More access\n",
    network: null,
    paths: [
      { target: { kind: "path", path: "/read" }, access: "read" },
      { target: { kind: "path", path: "/write" }, access: "write" },
    ],
  });
});

test("unknown keys and path kinds make the whole permission profile unrecognised", () => {
  const source = permission({ read: null, write: ["/known"] });
  const unknown = [
    { ...source.params.permissions, future: true },
    { ...source.params.permissions, network: { enabled: true, future: true } },
    {
      ...source.params.permissions,
      fileSystem: { write: ["/known"], future: true },
    },
    ...[
      { path: { type: "future", path: "/" }, access: "write" },
      { path: { type: "path", path: "/" }, access: "future" },
      {
        path: {
          type: "special",
          value: { kind: "unknown", path: "future", subpath: null },
        },
        access: "write",
      },
      {
        path: { type: "special", value: { kind: "root", extra: true } },
        access: "write",
      },
    ].map((entry) => ({
      ...source.params.permissions,
      fileSystem: { write: ["/known"], entries: [entry] },
    })),
  ];
  for (const permissions of unknown) {
    expect(
      describeApproval({
        ...source,
        params: { ...source.params, permissions },
      }),
    ).toEqual({ kind: "unrecognised", reason: " More access\n" });
  }
});

test("command descriptions preserve the original text and network target", () => {
  const method = "item/commandExecution/requestApproval";
  const params = {
    command: " printf '\u202e'\n",
    cwd: "/work ",
    reason: " network ",
    networkApprovalContext: { host: "example.test:443", protocol: "socks5Tcp" },
  };
  expect(describeApproval({ method, params })).toEqual({
    kind: "command",
    command: " printf '\u202e'\n",
    folder: "/work ",
    reason: " network ",
    network: { host: "example.test:443", protocol: "socks5-tcp" },
  });
  for (const kind of ["humanCommand", "writeStdin", "future"]) {
    expect(describeApproval({ method, params: { ...params, kind } })).toEqual({
      kind: "unrecognised",
      reason: " network ",
    });
  }
  expect(
    describeApproval({ method, params: { ...params, command: null } }),
  ).toEqual({ kind: "unrecognised", reason: " network " });
});

test("a URL prompt includes the target, and a form prompt has no URL", () => {
  const method = "mcpServer/elicitation/request";
  const params = {
    serverName: "docs",
    message: " Sign in\n",
    reason: " sign in ",
    url: "https://example.test/",
  };
  expect(
    describeApproval({ method, params: { ...params, mode: "url" } }),
  ).toEqual({
    kind: "server-prompt",
    server: "docs",
    message: " Sign in\n",
    url: "https://example.test/",
    reason: " sign in ",
  });
  expect(
    describeApproval({ method, params: { ...params, mode: "form" } }),
  ).toEqual({
    kind: "server-prompt",
    server: "docs",
    message: " Sign in\n",
    reason: " sign in ",
  });
});
