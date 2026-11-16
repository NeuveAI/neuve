import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, within } from "storybook/test"

import {
  Pagination,
  PaginationContent,
  PaginationDisabled,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNextContent,
  PaginationPreviousContent,
  pageWindow,
} from "@workspace/ui/components/pagination"
import { StoryFrame } from "@workspace/ui/foundations/sheet"
import { expectFocusVisible, tabTo } from "@workspace/ui/neuve/story-kit/play"

/**
 * shadcn Pagination (radix-nova) on Neuve's tokens: Previous, the pages
 * around the current one with an ellipsis between far pages, Next. The
 * current page is outlined; a step that can't be taken is shown dimmed and
 * is not a link. The Reviews page uses it ("Screens/Reviews").
 */
function Pages({ page, count }: { page: number; count: number }) {
  return (
    <Pagination aria-label="Pages of reviews">
      <PaginationContent>
        <PaginationItem>
          {page > 1 ? (
            <PaginationLink
              href={`#${page - 1}`}
              aria-label="Previous page"
              className="pr-3 pl-2"
            >
              <PaginationPreviousContent />
            </PaginationLink>
          ) : (
            <PaginationDisabled className="pr-3 pl-2">
              <PaginationPreviousContent />
            </PaginationDisabled>
          )}
        </PaginationItem>
        {pageWindow(page, count).map((n, index) => (
          <PaginationItem key={n ?? `gap-${index}`}>
            {n === null ? (
              <PaginationEllipsis />
            ) : (
              <PaginationLink
                href={`#${n}`}
                aria-label={`Page ${n}`}
                isActive={n === page}
              >
                {n}
              </PaginationLink>
            )}
          </PaginationItem>
        ))}
        <PaginationItem>
          {page < count ? (
            <PaginationLink
              href={`#${page + 1}`}
              aria-label="Next page"
              className="pr-2 pl-3"
            >
              <PaginationNextContent />
            </PaginationLink>
          ) : (
            <PaginationDisabled className="pr-2 pl-3">
              <PaginationNextContent />
            </PaginationDisabled>
          )}
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  )
}

const meta = {
  title: "Primitives/Pagination",
  component: Pages,
  decorators: [
    (Story) => (
      <StoryFrame>
        <Story />
      </StoryFrame>
    ),
  ],
  args: { page: 1, count: 2 },
} satisfies Meta<typeof Pages>

export default meta
type Story = StoryObj<typeof meta>

/** The first of two pages: Previous can't be taken. */
export const FirstOfTwo: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("link", { name: "Page 1" })).toHaveAttribute(
      "aria-current",
      "page"
    )
    await expect(
      canvas.queryByRole("link", { name: "Previous page" })
    ).toBeNull()
  },
}

/** The middle of many: the first and last pages, the neighbours, and a gap on each side. */
export const MiddleOfMany: Story = {
  args: { page: 6, count: 12 },
  play: async ({ canvas }) => {
    const nav = canvas.getByRole("navigation", { name: "Pages of reviews" })
    await expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.textContent)
    ).toEqual(["Previous", "1", "5", "6", "7", "12", "Next"])
  },
}

/** The last page: Next can't be taken. */
export const LastPage: Story = { args: { page: 12, count: 12 } }

/** Keyboard focus shows the ring; pointer focus does not. */
export const KeyboardFocus: Story = {
  args: { page: 2, count: 4 },
  play: async ({ canvas }) => {
    const page = canvas.getByRole("link", { name: "Page 3" })
    await tabTo(page)
    await expectFocusVisible(page)
  },
}

export const Dark: Story = {
  args: { page: 3, count: 8 },
  globals: { theme: "dark" },
}
