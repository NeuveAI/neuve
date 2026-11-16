import {
  PrivateInspection,
  NativeAuthorityReceipt,
  NativeHistoryUncertified,
  type NativeSourceImportOptions,
} from "./private-inspection.ts";

export { NativeAuthorityReceipt, NativeHistoryUncertified };
export const nativeSourceExportState = (
  authority: PrivateInspection,
): { kind: "fresh" } | { kind: "uncertified-import" } => ({
  kind: authority.exportState(),
});
export type { NativeSourceImportOptions };

export const checkpointNativeAuthority = (
  authority: PrivateInspection,
  input: Parameters<PrivateInspection["snapshotForNative"]>[0],
): Promise<NativeAuthorityReceipt> => authority.snapshotForNative(input);

export const prepareNativeSourceImport = (
  input: NativeSourceImportOptions,
): Promise<PrivateInspection> => PrivateInspection.prepareNativeImport(input);
