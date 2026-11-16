import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, within } from "storybook/test"

import {
  historyEmptyPageFixture,
  historyFirstPageFixture,
  historyLoaderFixture,
} from "@workspace/ui/fixtures/history.fixtures"
import { HistorySource } from "@workspace/ui/neuve/review-desk/history-source"
import { onPaper } from "@workspace/ui/neuve/story-kit/frames"

/**
 * The recorded review history inside the source sheet (L3): the records of
 * the snapshot the desk loaded, "Load more records" through the loader, and
 * each record's full text on demand. Loader stubs answer, stay loading or
 * fail.
 */
const meta = {
  title: "Review desk/History source",
  component: HistorySource,
  args: { page: historyFirstPageFixture },
  decorators: [
    // The sheet's surface, as the source sheet hosts the history.
    (Story) => (
      <div className="max-w-[480px] rounded-xl bg-surface p-5 shadow-card">
        <Story />
      </div>
    ),
    onPaper,
  ],
} satisfies Meta<typeof HistorySource>

export default meta
type Story = StoryObj<typeof meta>

/** No loader (a stored view): the snapshot only, with the CLI pointer. */
export const Snapshot: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "2 records loaded · more available"
    )
    await expect(
      canvas.getByText("More records are available through the ledger CLI.")
    ).toBeInTheDocument()
    await expect(
      canvas.queryByRole("button", { name: "Load more records" })
    ).toBeNull()
  },
}

export const Empty: Story = {
  args: { page: historyEmptyPageFixture },
  play: async ({ canvas }) => {
    await expect(
      canvas.getByText(
        "No records were retained for this unit at this snapshot."
      )
    ).toBeInTheDocument()
  },
}

/** "Load more records" fetches the rest of the snapshot, then ends. */
export const LoadMore: Story = {
  args: { loadPage: historyLoaderFixture() },
  play: async ({ canvas }) => {
    await userEvent.click(
      canvas.getByRole("button", { name: "Load more records" })
    )
    await expect(
      await canvas.findByText("4 records loaded · end of this snapshot", {
        exact: false,
      })
    ).toBeInTheDocument()
    await expect(canvas.getByText("New commit observed")).toBeInTheDocument()
    await expect(canvas.queryByRole("button", { name: /load/i })).toBeNull()
  },
}

export const LoadMoreLoading: Story = {
  args: { loadPage: historyLoaderFixture({ page: "loading" }) },
  play: async ({ canvas }) => {
    await userEvent.click(
      canvas.getByRole("button", { name: "Load more records" })
    )
    await expect(
      await canvas.findByRole("button", { name: "Loading records…" })
    ).toBeDisabled()
  },
}

export const LoadMoreError: Story = {
  args: { loadPage: historyLoaderFixture({ page: "fails" }) },
  play: async ({ canvas }) => {
    await userEvent.click(
      canvas.getByRole("button", { name: "Load more records" })
    )
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "The next records could not be loaded."
    )
    await expect(
      canvas.getByRole("button", { name: "Retry loading records" })
    ).toBeEnabled()
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "2 records loaded"
    )
  },
}

async function openFullRecord(canvasElement: HTMLElement) {
  const canvas = within(canvasElement)
  await userEvent.click(canvas.getByText("Review unit prepared"))
  await userEvent.click(canvas.getAllByText("Full record and references")[0]!)
  return canvas
}

/** A record opened to its full text and references. */
export const FullRecord: Story = {
  args: { loadPage: historyLoaderFixture() },
  play: async ({ canvasElement }) => {
    const canvas = await openFullRecord(canvasElement)
    await expect(
      await canvas.findByText(/"kind": "unit.prepared"/)
    ).toBeInTheDocument()
  },
}

export const FullRecordLoading: Story = {
  args: { loadPage: historyLoaderFixture({ record: "loading" }) },
  play: async ({ canvasElement }) => {
    const canvas = await openFullRecord(canvasElement)
    await expect(await canvas.findByText("Loading record…")).toBeVisible()
  },
}

export const FullRecordError: Story = {
  args: { loadPage: historyLoaderFixture({ record: "fails" }) },
  play: async ({ canvasElement }) => {
    const canvas = await openFullRecord(canvasElement)
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "The record could not be loaded."
    )
    await expect(canvas.getByRole("button", { name: "Retry" })).toBeVisible()
  },
}

/** A retry after a failed record load shows the record. */
export const FullRecordRetry: Story = {
  args: { loadPage: historyLoaderFixture({ record: "fails-once" }) },
  play: async ({ canvasElement }) => {
    const canvas = await openFullRecord(canvasElement)
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "The record could not be loaded."
    )
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }))
    await expect(
      await canvas.findByText(/"kind": "unit.prepared"/)
    ).toBeInTheDocument()
    await expect(canvas.queryByRole("alert")).toBeNull()
  },
}

/** Without a loader (a stored view) the full record says it isn't here. */
export const FullRecordWithoutLoader: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await openFullRecord(canvasElement)
    await expect(
      canvas.getByText("Full record unavailable in this view.")
    ).toBeVisible()
  },
}

export const LoadMoreDark: Story = {
  ...LoadMore,
  globals: { theme: "dark" },
}
