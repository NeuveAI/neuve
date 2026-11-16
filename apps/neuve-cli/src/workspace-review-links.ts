import { existsSync } from "node:fs";
import { ReviewOrigins, resolveStoreLocation } from "@neuve/records-core";
import { Ulid, type ReviewOrigin } from "@neuve/records-schema";
import type { ReviewHistoryQuery } from "@ace/host/extension-protocol";
import { reviewPaths } from "@ace/host/app-gateway";
import { execute, withStore } from "./records-cli.ts";

export const aceReviewDestination = (
  root: string,
  project: string,
  reference: string,
  returnTo?: string,
) => {
  const path = reviewPaths(project, reference).batch;
  const destination =
    returnTo === undefined
      ? path
      : `${path}?${new URLSearchParams({ returnTo })}`;
  return new URL(destination, root).href;
};

export const exactReviewUrl = (
  root: string,
  reference: string,
  returnTo?: string,
) => {
  const url = new URL(root);
  url.pathname = "/";
  url.search = new URLSearchParams({ cycle: Ulid.parse(reference) }).toString();
  if (returnTo !== undefined) url.searchParams.set("returnTo", returnTo);
  url.hash = "";
  return url.href;
};

export const codingReturnUrl = (
  root: string,
  project: string,
  origin?: ReviewOrigin,
) => {
  const url = new URL(root);
  url.pathname = "/";
  url.search = new URLSearchParams({ project }).toString();
  url.hash = "dashboard";
  if (origin?.kind === "channel") {
    url.searchParams.set("channel", origin.channel);
    url.searchParams.set("chat", String(origin.chat));
    url.hash = "channels";
  } else if (origin?.kind === "external") {
    const item = origin.items[0];
    if (item) {
      url.searchParams.set("repo", item.repo);
      url.searchParams.set(
        item.kind === "pull-request" ? "pull" : "issue",
        String(item.number),
      );
      url.hash = item.kind === "pull-request" ? "prs" : "issues";
    }
  }
  return url.href;
};

export const reviewAt = (project: string, reference: string) =>
  execute(withStore(project, "read", ReviewOrigins.cycle(reference)));

export const reviewOrigin = async (project: string, reference: string) => {
  const [review] = await execute(
    withStore(project, "read", ReviewOrigins.list({ reference })),
  );
  return review?.origin;
};

export const reviewHistory = async (query: ReviewHistoryQuery) => {
  const project = query.project;
  const location = await execute(resolveStoreLocation(project));
  if (!existsSync(location.database)) return [];
  const reviews = await execute(
    withStore(project, "read", ReviewOrigins.list(query)),
  );
  if (query.item === undefined) return reviews;
  const cycles = new Set<string>();
  return reviews.filter(({ reference }) => {
    if (cycles.has(reference)) return false;
    cycles.add(reference);
    return true;
  });
};
