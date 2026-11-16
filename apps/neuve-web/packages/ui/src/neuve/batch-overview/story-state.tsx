/**
 * Batch-overview story state: the story kit's store under its old name, so
 * existing stories import it unchanged. New stories import `withStory` from
 * `neuve/story-kit/store` directly.
 */
export { withBatchOverviewState } from "@workspace/ui/neuve/story-kit/store"
