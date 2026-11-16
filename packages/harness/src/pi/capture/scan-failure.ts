import { z } from "zod";

export const ScanFailureKind = z.enum([
  "storage",
  "worker",
  "cancelled",
  "authority-busy",
  "execution",
  "pruned",
]);
export type ScanFailureKind = z.infer<typeof ScanFailureKind>;

/** Classification comes from error fields at the boundary, never from public diagnostic text. */
export const scanFailureKind = (
  error: unknown,
): ScanFailureKind | undefined => {
  if (typeof error !== "object" || error === null) return "execution";
  if ("failureKind" in error) {
    const parsed = ScanFailureKind.safeParse(error.failureKind);
    return parsed.success ? parsed.data : undefined;
  }
  if ("_tag" in error) {
    switch (error._tag) {
      case "DumpFailed":
      case "DumpRejected":
      case "RawCapturePruned":
      case "BlobPruned":
        return undefined;
      case "BlobWriteFailed":
      case "BlobMissing":
      case "StoreIoError":
      case "SqlError":
        return "storage";
    }
  }
  if ("name" in error) {
    switch (error.name) {
      case "PrivateInspectionError":
      case "NativeHistoryUncertified":
        return undefined;
      case "PrivateInspectionBusy":
        return "authority-busy";
      case "AbortError":
        return "cancelled";
    }
  }
  if (
    "code" in error &&
    typeof error.code === "string" &&
    new Set([
      "EACCES",
      "ENOENT",
      "ENOSPC",
      "EIO",
      "EROFS",
      "EBUSY",
      "EMFILE",
      "ENFILE",
      "EPERM",
      "SQLITE_BUSY",
      "SQLITE_LOCKED",
    ]).has(error.code)
  )
    return "storage";
  return "execution";
};
