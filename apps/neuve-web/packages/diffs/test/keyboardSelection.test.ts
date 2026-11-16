// NEUVE FORK: keyboard line selection against a controlled host (NOTICE.md,
// item 5): the extension anchor survives the host's normalised echo, and
// focus survives a re-render that replaces the rows.
import { afterAll, describe, expect, test } from 'bun:test';

import { disposeHighlighter, FileDiff, parseDiffFromFile } from '../src';
import type { SelectedLineRange, SelectionPoint } from '../src/types';
import { installDom } from './domHarness';

afterAll(async () => {
  await disposeHighlighter();
});

const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
const oldFile = { name: 'paced.ts', contents: `${lines.join('\n')}\n` };
const newFile = {
  name: 'paced.ts',
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

// The desk echoes every selection back with its top line first.
function normalised(range: SelectedLineRange): SelectedLineRange {
  const crossesSides = (range.endSide ?? range.side) !== range.side;
  if (crossesSides || range.start <= range.end) return range;
  return { ...range, start: range.end, end: range.start };
}

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
  const fileDiff = parseDiffFromFile(oldFile, newFile);
  // A controlled host, as the desk is: it echoes the selection back.
  const instance: FileDiff<string> = new FileDiff<string>({
    diffStyle: 'unified',
    disableFileHeader: true,
    enableLineSelection: true,
    enableKeyboardLineSelection: true,
    onLineSelected: (range) =>
      instance.setSelectedLines(range != null ? normalised(range) : null, {
        notify: false,
      }),
    ...(isLineCommentable != null ? { isLineCommentable } : {}),
  });
  instance.render({ fileContainer: container, fileDiff });
  await waitForCode(container);
  const root = container.shadowRoot!;
  const view = container.ownerDocument.defaultView!;
  const cell = (line: number, type: string) =>
    root.querySelector<HTMLElement>(
      `[data-column-number="${line}"][data-line-type="${type}"]`
    )!;
  // Keys go to whatever has focus, as a keyboard's do.
  const press = (key: string, shiftKey = false) =>
    (root.activeElement ?? container).dispatchEvent(
      new view.KeyboardEvent('keydown', {
        key,
        shiftKey,
        bubbles: true,
        composed: true,
      })
    );
  const focus = (target: HTMLElement) => {
    target.tabIndex = 0;
    target.focus();
  };
  const painted = () =>
    [...root.querySelectorAll('[data-column-number][data-selected-line]')].map(
      (element) =>
        `${element.getAttribute('data-column-number')}:${element.getAttribute('data-line-type')}`
    );
  const focused = () => {
    const active = root.activeElement;
    return active == null
      ? null
      : `${active.getAttribute('data-column-number')}:${active.getAttribute('data-line-type')}`;
  };
  return {
    container,
    instance,
    root,
    cell,
    press,
    focus,
    painted,
    focused,
    cleanup() {
      instance.cleanUp();
      dom.cleanup();
    },
  };
}

describe('keyboard selection with a controlled host (NEUVE FORK)', () => {
  test('Shift+↑ keeps growing from where Space was pressed', async () => {
    const ctx = await setup();
    try {
      ctx.focus(ctx.cell(24, 'context'));
      ctx.press(' ');
      for (let step = 0; step < 3; step++) ctx.press('ArrowUp', true);
      expect(ctx.painted()).toEqual([
        '21:change-addition',
        '22:context',
        '23:context',
        '24:context',
      ]);
      expect(ctx.focused()).toBe('21:change-addition');
    } finally {
      ctx.cleanup();
    }
  });

  test('on owned lines the clamp keeps the whole owned run', async () => {
    const ctx = await setup(ownedAdditions);
    try {
      ctx.focus(ctx.cell(21, 'change-addition'));
      ctx.press(' ');
      ctx.press('ArrowUp', true);
      ctx.press('ArrowUp', true);
      ctx.press('ArrowUp', true);
      expect(ctx.painted()).toEqual([
        '20:change-addition',
        '21:change-addition',
      ]);
      // Focus went on past the clamp; the selection didn't follow it.
      expect(ctx.focused()).toBe('20:change-deletion');
    } finally {
      ctx.cleanup();
    }
  });

  test('a re-render that replaces the rows keeps focus on the same line', async () => {
    const ctx = await setup();
    try {
      ctx.focus(ctx.cell(24, 'context'));
      ctx.press(' ');
      const before = ctx.cell(24, 'context');
      ctx.instance.rerender();
      expect(before.isConnected).toBe(false);
      expect(ctx.focused()).toBe('24:context');
      expect(
        ctx.root.querySelectorAll('[data-column-number][tabindex="0"]')
      ).toHaveLength(1);
      // And keyboard selection carries on from there.
      ctx.press('ArrowUp', true);
      expect(ctx.painted()).toEqual(['23:context', '24:context']);
    } finally {
      ctx.cleanup();
    }
  });

  test('focus the reader moved to the page is not pulled back', async () => {
    const ctx = await setup();
    try {
      const line = ctx.cell(24, 'context');
      ctx.focus(line);
      // As a click on empty page: focus leaves for the body, the cell stays.
      line.blur();
      await Promise.resolve();
      ctx.instance.rerender();
      expect(ctx.root.activeElement).toBeNull();
    } finally {
      ctx.cleanup();
    }
  });

  test('a re-render never takes focus from where it went meanwhile', async () => {
    const ctx = await setup();
    try {
      const line = ctx.cell(24, 'context');
      ctx.focus(line);
      // The cell goes (the host re-rendering), and before the next render
      // something else takes focus: the cell itself sends no focusout.
      line.remove();
      const outside = document.createElement('button');
      document.body.appendChild(outside);
      outside.focus();
      ctx.instance.rerender();
      expect(document.activeElement).toBe(outside);
    } finally {
      ctx.cleanup();
    }
  });

  test('focus that left the gutter is not pulled back by a re-render', async () => {
    const ctx = await setup();
    try {
      ctx.focus(ctx.cell(24, 'context'));
      const outside = document.createElement('button');
      document.body.appendChild(outside);
      outside.focus();
      await Promise.resolve();
      ctx.instance.rerender();
      expect(document.activeElement).toBe(outside);
    } finally {
      ctx.cleanup();
    }
  });
});
