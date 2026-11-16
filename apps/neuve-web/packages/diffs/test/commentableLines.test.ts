// NEUVE FORK: tests for `isLineCommentable` (NOTICE.md, item 5).
import { afterAll, describe, expect, test } from 'bun:test';

import { disposeHighlighter, FileDiff, parseDiffFromFile } from '../src';
import type { SelectionPoint } from '../src/types';
import { installDom } from './domHarness';

afterAll(async () => {
  await disposeHighlighter();
});

const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
const oldFile = { name: 'owned.ts', contents: `${lines.join('\n')}\n` };
const newFile = {
  name: 'owned.ts',
  contents: `${lines
    .map((line, index) =>
      index === 19 ? 'changed 20' : index === 20 ? 'changed 21' : line
    )
    .join('\n')}\n`,
};

// Only the added lines 20–21 can take a comment.
const ownedAdditions = (point: SelectionPoint) =>
  point.side === 'additions' &&
  point.lineNumber >= 20 &&
  point.lineNumber <= 21;

// Lines 20–21 on both sides (the removed and the added) can take a comment.
const ownedChanges = (point: SelectionPoint) =>
  point.lineNumber >= 20 && point.lineNumber <= 21;

async function waitForCode(container: HTMLElement): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (container.shadowRoot?.querySelector('code') != null) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for FileDiff render');
}

async function setup(
  isLineCommentable?: (point: SelectionPoint) => boolean
) {
  const dom = installDom();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const committed: unknown[] = [];
  const selected: unknown[] = [];
  const instance = new FileDiff<string>({
    diffStyle: 'unified',
    disableFileHeader: true,
    enableLineSelection: true,
    enableKeyboardLineSelection: true,
    enableGutterUtility: true,
    onGutterUtilityClick: (range) => committed.push(range),
    onLineSelected: (range) => selected.push(range),
    onLineSelectionCommit: (range) => committed.push(range),
    ...(isLineCommentable != null ? { isLineCommentable } : {}),
  });
  instance.render({
    fileContainer: container,
    fileDiff: parseDiffFromFile(oldFile, newFile),
  });
  await waitForCode(container);
  const root = container.shadowRoot!;
  const view = container.ownerDocument.defaultView!;
  // A line number cell: the added or removed one, or the context line.
  const cell = (line: number, type: string) =>
    root.querySelector<HTMLElement>(
      `[data-column-number="${line}"][data-line-type="${type}"]`
    )!;
  const press = (target: Element, key: string, shiftKey = false) =>
    target.dispatchEvent(
      new view.KeyboardEvent('keydown', {
        key,
        shiftKey,
        bubbles: true,
        composed: true,
      })
    );
  const focus = (target: Element) =>
    target.dispatchEvent(
      new view.FocusEvent('focusin', { bubbles: true, composed: true })
    );
  const painted = () =>
    [...root.querySelectorAll('[data-column-number][data-selected-line]')].map(
      (element) =>
        `${element.getAttribute('data-column-number')}:${element.getAttribute('data-line-type')}`
    );
  // A press and release on a line number, by mouse or touch.
  const tap = (target: Element, pointerType = 'mouse') => {
    for (const [element, type] of [
      [target, 'pointerdown'],
      [view.document, 'pointerup'],
    ] as const) {
      element.dispatchEvent(
        new view.PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerType,
          pointerId: 7,
          button: 0,
        })
      );
    }
  };
  // A mouse over a line number (the gutter utility follows hover).
  const hover = (target: Element) =>
    target.dispatchEvent(
      new view.PointerEvent('pointermove', {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerType: 'mouse',
      })
    );
  // The line number the "+" utility sits on, if any.
  const utilityOn = () =>
    root
      .querySelector('[data-gutter-utility-slot]')
      ?.closest('[data-column-number]')
      ?.getAttribute('data-column-number') ?? null;
  // Pointer selection paints on the next frame (queueRender).
  const rendered = () =>
    new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  const tabStop = () =>
    root.querySelector<HTMLElement>('[data-column-number][tabindex="0"]')!;
  return {
    cell,
    press,
    tap,
    hover,
    utilityOn,
    rendered,
    focus,
    painted,
    tabStop,
    committed,
    selected,
    cleanup() {
      instance.cleanUp();
      dom.cleanup();
    },
  };
}

describe('isLineCommentable (NEUVE FORK)', () => {
  test('unset: every line keeps the full name and is selectable', async () => {
    const ctx = await setup();
    try {
      const context = ctx.cell(19, 'context');
      ctx.focus(context);
      expect(context.getAttribute('aria-label')).toBe(
        'Line 19. Enter to comment, Shift+Arrow to extend.'
      );
      ctx.press(context, ' ');
      expect(ctx.painted()).toContain('19:context');
    } finally {
      ctx.cleanup();
    }
  });

  test('unset: hovering any line number shows the "+" utility', async () => {
    const ctx = await setup();
    try {
      ctx.hover(ctx.cell(19, 'context'));
      expect(ctx.utilityOn()).toBe('19');
    } finally {
      ctx.cleanup();
    }
  });

  test('the "+" utility shows only on lines that can take a comment', async () => {
    const ctx = await setup(ownedAdditions);
    try {
      ctx.hover(ctx.cell(19, 'context'));
      expect(ctx.utilityOn()).toBeNull();
      ctx.hover(ctx.cell(20, 'change-addition'));
      expect(ctx.utilityOn()).toBe('20');
      // Moving on to a line that can't takes it away again.
      ctx.hover(ctx.cell(22, 'context'));
      expect(ctx.utilityOn()).toBeNull();
    } finally {
      ctx.cleanup();
    }
  });

  test('names only commentable lines with how to comment', async () => {
    const ctx = await setup(ownedAdditions);
    try {
      const owned = ctx.cell(20, 'change-addition');
      ctx.focus(owned);
      expect(owned.getAttribute('aria-label')).toBe(
        'Line 20. Enter to comment, Shift+Arrow to extend.'
      );
      const context = ctx.cell(19, 'context');
      ctx.focus(context);
      expect(context.getAttribute('aria-label')).toBe('Line 19');
      const removed = ctx.cell(20, 'change-deletion');
      ctx.focus(removed);
      expect(removed.getAttribute('aria-label')).toBe('Line 20 (removed)');
    } finally {
      ctx.cleanup();
    }
  });

  test('Space and Enter on a line that cannot take a comment do nothing', async () => {
    const ctx = await setup(ownedAdditions);
    try {
      const context = ctx.cell(19, 'context');
      ctx.press(context, ' ');
      ctx.press(context, 'Enter');
      ctx.press(context, 'c');
      expect(ctx.painted()).toEqual([]);
      expect(ctx.selected).toEqual([]);
      expect(ctx.committed).toEqual([]);
    } finally {
      ctx.cleanup();
    }
  });

  test('Shift+↓ stops at the last commentable line; focus still moves', async () => {
    const ctx = await setup(ownedAdditions);
    try {
      const first = ctx.cell(20, 'change-addition');
      ctx.press(first, ' ');
      ctx.press(first, 'ArrowDown', true);
      expect(ctx.painted()).toEqual(['20:change-addition', '21:change-addition']);
      const second = ctx.tabStop();
      expect(second).toBe(ctx.cell(21, 'change-addition'));
      ctx.press(second, 'ArrowDown', true);
      // Focus reached line 22; the selection didn't follow it.
      expect(ctx.tabStop()).toBe(ctx.cell(22, 'context'));
      expect(ctx.painted()).toEqual(['20:change-addition', '21:change-addition']);
      ctx.press(ctx.tabStop(), 'ArrowDown');
      expect(ctx.tabStop()).toBe(ctx.cell(23, 'context'));
    } finally {
      ctx.cleanup();
    }
  });

  test('a click or touch tap on a line that cannot take a comment paints nothing', async () => {
    const ctx = await setup(ownedAdditions);
    try {
      ctx.tap(ctx.cell(19, 'context'));
      ctx.tap(ctx.cell(22, 'context'), 'touch');
      await ctx.rendered();
      expect(ctx.painted()).toEqual([]);
      expect(ctx.selected.every((range) => range == null)).toBe(true);
      ctx.tap(ctx.cell(20, 'change-addition'));
      await ctx.rendered();
      expect(ctx.painted()).toEqual(['20:change-addition']);
      expect(ctx.selected.at(-1)).toEqual({
        start: 20,
        side: 'additions',
        end: 20,
      });
    } finally {
      ctx.cleanup();
    }
  });

  test('crossing sides keeps the anchor side as far as it can go', async () => {
    const ctx = await setup(ownedChanges);
    try {
      // Unified rows: removed 20, removed 21, added 20, added 21.
      const removed20 = ctx.cell(20, 'change-deletion');
      ctx.press(removed20, ' ');
      ctx.press(removed20, 'ArrowDown', true);
      expect(ctx.painted()).toEqual(['20:change-deletion', '21:change-deletion']);
      // Onto the added side: the removed 20–21 stay (not just the anchor).
      ctx.press(ctx.tabStop(), 'ArrowDown', true);
      expect(ctx.tabStop()).toBe(ctx.cell(20, 'change-addition'));
      expect(ctx.painted()).toEqual(['20:change-deletion', '21:change-deletion']);
    } finally {
      ctx.cleanup();
    }
  });

  test('a press or Space on a line that cannot take a comment clears the selection', async () => {
    const ctx = await setup(ownedAdditions);
    try {
      const owned = ctx.cell(20, 'change-addition');
      ctx.press(owned, ' ');
      expect(ctx.painted()).toEqual(['20:change-addition']);
      ctx.tap(ctx.cell(19, 'context'));
      await ctx.rendered();
      expect(ctx.painted()).toEqual([]);
      expect(ctx.selected.at(-1)).toBeNull();
      ctx.press(owned, ' ');
      expect(ctx.painted()).toEqual(['20:change-addition']);
      ctx.press(ctx.cell(22, 'context'), ' ');
      expect(ctx.painted()).toEqual([]);
      expect(ctx.selected.at(-1)).toBeNull();
    } finally {
      ctx.cleanup();
    }
  });

  test('Enter past a clamped Shift+↓ commits the clamped selection', async () => {
    const ctx = await setup(ownedAdditions);
    try {
      const first = ctx.cell(20, 'change-addition');
      ctx.press(first, ' ');
      ctx.press(first, 'ArrowDown', true);
      ctx.press(ctx.tabStop(), 'ArrowDown', true);
      // Focus is on context line 22, past the clamp at 21.
      expect(ctx.tabStop()).toBe(ctx.cell(22, 'context'));
      ctx.press(ctx.tabStop(), 'Enter');
      expect(ctx.committed.at(-1)).toEqual({
        start: 20,
        side: 'additions',
        end: 21,
      });
      ctx.press(ctx.tabStop(), 'c');
      expect(ctx.committed).toHaveLength(2);
      expect(ctx.painted()).toEqual(['20:change-addition', '21:change-addition']);
    } finally {
      ctx.cleanup();
    }
  });

  test('after a plain arrow, Enter on such a line commits nothing', async () => {
    const ctx = await setup(ownedAdditions);
    try {
      const first = ctx.cell(20, 'change-addition');
      ctx.press(first, ' ');
      ctx.press(first, 'ArrowDown', true);
      ctx.press(ctx.tabStop(), 'ArrowDown', true);
      // Clamped at 21, focus on 22; a plain ↓ moves on to 23.
      ctx.press(ctx.tabStop(), 'ArrowDown');
      expect(ctx.tabStop()).toBe(ctx.cell(23, 'context'));
      ctx.press(ctx.tabStop(), 'Enter');
      ctx.press(ctx.tabStop(), 'c');
      expect(ctx.committed).toEqual([]);
      // The selection itself is untouched.
      expect(ctx.painted()).toEqual(['20:change-addition', '21:change-addition']);
    } finally {
      ctx.cleanup();
    }
  });

  test('Shift+↓ from a line that cannot take a comment selects nothing', async () => {
    const ctx = await setup(ownedAdditions);
    try {
      ctx.press(ctx.cell(18, 'context'), 'ArrowDown', true);
      expect(ctx.painted()).toEqual([]);
      expect(ctx.tabStop()).toBe(ctx.cell(19, 'context'));
    } finally {
      ctx.cleanup();
    }
  });
});
