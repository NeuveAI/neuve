/**
 * Review-desk story state: the story kit's store and paper, kept under their
 * old names so existing stories import them unchanged. New stories import
 * from `neuve/story-kit/*` directly.
 */
export { withReviewDeskState } from "@workspace/ui/neuve/story-kit/store"
export type { StoryExtras } from "@workspace/ui/neuve/story-kit/store"
export { onPaper } from "@workspace/ui/neuve/story-kit/frames"
