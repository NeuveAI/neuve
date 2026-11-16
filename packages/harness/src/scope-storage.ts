import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Data, Effect } from "effect";
import {
  Blobs,
  STORE_DIRECTORY_MODE,
  STORE_FILE_MODE,
  type StoreLocation,
} from "@neuve/records-core";
import type { ExternalReviewSource } from "@neuve/records-schema";
import type { IntegrationServer } from "./integrations.ts";
import { declaredValues, scopeMasker } from "./scope-masking.ts";

/** A fetched item could not be kept; the snapshot records it as a gap. */
export class ScopeNotKept extends Data.TaggedError("ScopeNotKept")<{
  readonly message: string;
}> {}

/** Where the unmasked text of a cycle's fetched items is kept, beside Records, outside the tree. */
export const scopeFolder = (location: StoreLocation, cycleId: string) =>
  join(location.directory, "scope", cycleId);

const writePrivate = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true, mode: STORE_DIRECTORY_MODE });
  writeFileSync(path, text, { mode: STORE_FILE_MODE });
};

/** Stores the masked capture of fetched text and keeps the unmasked copy in the cycle's folder. */
export const keepFetched = (
  location: StoreLocation,
  cycleId: string,
  sourceId: string,
  text: string,
  response: unknown,
  server: IntegrationServer,
) =>
  keepScopeText(
    location,
    cycleId,
    sourceId,
    text,
    declaredValues(response, server.identifiers),
  );

export const keepExternalFetched = (
  location: StoreLocation,
  cycleId: string,
  sourceId: string,
  source: ExternalReviewSource,
) =>
  keepScopeText(location, cycleId, sourceId, source.text, [
    { value: source.item.url, kind: "url" },
  ]);

const keepScopeText = (
  location: StoreLocation,
  cycleId: string,
  sourceId: string,
  text: string,
  identifiers: Parameters<typeof scopeMasker>[0],
) =>
  Effect.gen(function* () {
    const blobs = yield* Blobs.BlobStore;
    yield* Effect.try({
      try: () =>
        writePrivate(
          join(scopeFolder(location, cycleId), `${sourceId}.txt`),
          text,
        ),
      catch: (cause) =>
        new ScopeNotKept({
          message: `the unmasked copy was not written: ${String(cause).slice(0, 200)}`,
        }),
    });
    const masker = scopeMasker(identifiers);
    const masked = masker.mask(text);
    const stored = yield* blobs.put({
      bytes: new TextEncoder().encode(masked),
      mediaType: "text/plain; charset=utf-8",
      retention: "raw-capture",
    });
    return { blob: stored.blob.hash, masked: { ...masker.counts() } };
  });
