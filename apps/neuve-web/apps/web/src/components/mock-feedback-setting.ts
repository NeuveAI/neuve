import { atom } from "jotai"

import type {
  FeedbackSetting,
  FeedbackSettingAtom,
} from "@workspace/ui/neuve/review-desk/feedback/atoms"

/**
 * The feedback setting for `/mock` pages, provided by the `/mock` layout: in
 * memory, so the sample settings page never writes the real setting's
 * cookie. Mock desks carry no feedback, so it shows nothing there.
 */
export const mockFeedbackSettingAtom: FeedbackSettingAtom =
  atom<FeedbackSetting>({ enabled: false })
