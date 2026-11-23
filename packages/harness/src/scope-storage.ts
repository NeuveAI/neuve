import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

export const keepScopeText = (
  location: StoreLocation,
  cycleId: string,
  sourceId: string,
  text: string | Uint8Array,
) =>
  Effect.try({
    try: () => {
      const folder = scopeFolder(location, cycleId);
      mkdirSync(folder, { recursive: true, mode: STORE_DIRECTORY_MODE });
      writeFileSync(join(folder, `${sourceId}.txt`), text, {
        mode: STORE_FILE_MODE,
      });
    },
    catch: (cause) =>
      new ScopeNotKept({
        message: `the unmasked copy was not written: ${String(cause).slice(0, 200)}`,
      }),
  });

export const readScopeBytes = (
  location: StoreLocation,
  cycleId: string,
  sourceId: string,
) => {
  try {
    return {
      bytes: readFileSync(
        join(scopeFolder(location, cycleId), `${sourceId}.txt`),
      ),
    };
  } catch (error) {
    return { cause: String(error) };
  }
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
  keepCapturedText(
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
  keepCapturedText(location, cycleId, sourceId, source.text, [
    { value: source.item.url, kind: "url" },
  ]);

const keepCapturedText = (
  location: StoreLocation,
  cycleId: string,
  sourceId: string,
  text: string,
  identifiers: Parameters<typeof scopeMasker>[0],
) =>
  Effect.gen(function* () {
    const blobs = yield* Blobs.BlobStore;
    yield* keepScopeText(location, cycleId, sourceId, text);
    const masker = scopeMasker(identifiers);
    const masked = masker.mask(text);
    const stored = yield* blobs.put({
      bytes: new TextEncoder().encode(masked),
      mediaType: "text/plain; charset=utf-8",
      retention: "raw-capture",
    });
    return { blob: stored.blob.hash, masked: { ...masker.counts() } };
  });
