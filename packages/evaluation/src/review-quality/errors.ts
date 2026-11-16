export class ReviewQualityInputError extends Error {
  readonly _tag = "ReviewQualityInputError";
}
export class ReviewQualityDatasetError extends Error {
  readonly _tag = "ReviewQualityDatasetError";
}
export class ReviewQualityGoldPending extends Error {
  readonly _tag = "ReviewQualityGoldPending";
}
export class ReviewQualityHoldoutSealed extends Error {
  readonly _tag = "ReviewQualityHoldoutSealed";
}
