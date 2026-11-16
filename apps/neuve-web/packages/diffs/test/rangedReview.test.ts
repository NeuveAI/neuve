// NEUVE FORK: tests for ranged review presentation (NOTICE.md): old and new
// numbers in the unified gutter, hunk fold rows, host-owned gap expansion,
// slot-anchored overlay items, hidden gaps and the landing tint.
import { afterAll, describe, expect, test } from 'bun:test';

import { disposeHighlighter, FileDiff, parseDiffFromFile } from '../src';
import type { DiffLineAnnotation, HunkFold } from '../src/types';
import { installDom } from './domHarness';

afterAll(async () => {
  await disposeHighlighter();
});

const ROW_HEIGHT = 20;

const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
const oldFile = { name: 'ranged.ts', contents: `${lines.join('\n')}\n` };
const newFile = {
  name: 'ranged.ts',
  contents: `${lines
    .map((line, index) =>
      index === 9 ? 'owned 10' : index === 29 ? 'sibling 30' : line
    )
    .join('\n')}\n`,
};

// jsdom performs no layout: rows (and any row cell) stack in DOM order.
function installGeometry(): () => void {
  const proto = HTMLElement.prototype;
  const originalRect = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (this: HTMLElement) {
    const column = this.parentElement;
    const top =
      column != null && this.closest('pre') != null
        ? Array.prototype.indexOf.call(column.children, this) * ROW_HEIGHT
        : 0;
    return {
      top,
      bottom: top + ROW_HEIGHT,
      left: 0,
      right: 0,
      width: 0,
      height: ROW_HEIGHT,
      x: 0,
      y: top,
      toJSON() {},
    } as DOMRect;
  };
  return () => {
    proto.getBoundingClientRect = originalRect;
  };
}

async function waitForCode(container: HTMLElement): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (container.shadowRoot?.querySelector('code') != null) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for FileDiff render');
}

async function nextFrame() {
  await new Promise((resolve) => setTimeout(resolve, 40));
}

function setup({
  folds = [],
  annotations = [],
}: {
  folds?: HunkFold[];
  annotations?: DiffLineAnnotation<string>[];
} = {}) {
  const dom = installDom();
  const restoreGeometry = installGeometry();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const instance = new FileDiff<string>({
    diffStyle: 'unified',
    disableFileHeader: true,
    disableErrorHandling: true,
    annotationLayout: 'overlay',
    unifiedLineNumbers: 'both',
    hunkFolds: folds,
    hunkSeparators: 'custom',
  });
  // No context: each change is its own hunk (one owner per hunk).
  const fileDiff = parseDiffFromFile(oldFile, newFile, { context: 0 });
  instance.render({
    fileContainer: container,
    fileDiff,
    lineAnnotations: annotations,
  });
  const shadow = () => container.shadowRoot!;
  return {
    container,
    instance,
    fileDiff,
    shadow,
    contentRows: () =>
      Array.from(
        shadow().querySelectorAll<HTMLElement>('[data-content] [data-line]')
      ),
    cleanup() {
      instance.cleanUp();
      restoreGeometry();
      dom.cleanup();
    },
  };
}

describe('ranged review presentation', () => {
  test('the unified gutter shows old and new numbers', async () => {
    const ctx = setup();
    try {
      await waitForCode(ctx.container);
      const cells = Array.from(
        ctx.shadow().querySelectorAll('[data-gutter] [data-line-number-pair]'),
        (cell) => [
          cell.querySelector('[data-line-number-old]')?.textContent,
          cell.querySelector('[data-line-number-content]')?.textContent,
        ]
      );
      // Deletion 10, addition 10, deletion 30, addition 30.
      expect(cells).toEqual([
        ['10', ''],
        ['', '10'],
        ['30', ''],
        ['', '30'],
      ]);
    } finally {
      ctx.cleanup();
    }
  });

  test('a collapsed fold replaces its hunk with one slotted row', async () => {
    const ctx = setup({
      folds: [{ hunkIndex: 1, slotName: 'fold-1', collapsed: true, readOnly: true }],
    });
    try {
      await waitForCode(ctx.container);
      expect(ctx.contentRows().map((row) => row.textContent?.trim())).toEqual([
        'line 10',
        'owned 10',
      ]);
      const gutterCell = ctx.shadow().querySelector(
        "[data-gutter] [data-fold-row='gutter']"
      );
      expect(gutterCell?.querySelector('slot')?.getAttribute('name')).toBe(
        'fold-1'
      );
      expect(gutterCell?.hasAttribute('data-fold-collapsed')).toBe(true);
      expect(
        ctx.shadow().querySelector("[data-content] [data-fold-row='content']")
      ).not.toBeNull();
    } finally {
      ctx.cleanup();
    }
  });

  test('an open read-only fold shows its rows tagged read-only', async () => {
    const ctx = setup({
      folds: [{ hunkIndex: 1, slotName: 'fold-1', collapsed: true, readOnly: true }],
    });
    try {
      await waitForCode(ctx.container);
      ctx.instance.setPresentation({
        hunkFolds: [
          { hunkIndex: 1, slotName: 'fold-1', collapsed: false, readOnly: true },
        ],
      });
      const rows = ctx.contentRows();
      expect(rows.map((row) => row.textContent?.trim())).toEqual([
        'line 10',
        'owned 10',
        'line 30',
        'sibling 30',
      ]);
      expect(rows.map((row) => row.hasAttribute('data-read-only'))).toEqual([
        false,
        false,
        true,
        true,
      ]);
      expect(
        ctx
          .shadow()
          .querySelectorAll('[data-gutter] [data-read-only]').length
      ).toBe(2);
    } finally {
      ctx.cleanup();
    }
  });

  test('the host owns gap expansion without rebuilding the code element', async () => {
    const ctx = setup();
    try {
      await waitForCode(ctx.container);
      expect(ctx.contentRows().length).toBe(4);
      const code = ctx.shadow().querySelector('code');
      // The gap above hunk 1 (lines 11–29): reveal 5 from its top.
      ctx.instance.setPresentation(
        {},
        new Map([[1, { fromStart: 5, fromEnd: 0 }]])
      );
      const texts = ctx.contentRows().map((row) => row.textContent?.trim());
      expect(texts.length).toBe(9);
      expect(texts.slice(2, 7)).toEqual([
        'line 11',
        'line 12',
        'line 13',
        'line 14',
        'line 15',
      ]);
      // Every gap open (whole file).
      ctx.instance.setPresentation({ expandUnchanged: true });
      expect(ctx.contentRows().length).toBe(42);
      // Same renderer, same code element: presentation, not a rebuild.
      expect(ctx.shadow().querySelector('code')).toBe(code);
    } finally {
      ctx.cleanup();
    }
  });

  test('a hidden gap takes no row: separator, expanded and trailing rows', async () => {
    const ctx = setup({
      folds: [
        { hunkIndex: 1, slotName: 'fold-1', collapsed: true, readOnly: true },
      ],
    });
    try {
      await waitForCode(ctx.container);
      // Gutter and content cells each hold a row's slot: one name per row.
      const slots = () =>
        [
          ...new Set(
            Array.from(
              ctx.shadow().querySelectorAll('slot'),
              (slot) => slot.name
            )
          ),
        ]
          .filter((name) => /^(fold|hunk-separator)-/.test(name))
          .sort();
      expect(slots()).toEqual([
        'fold-1',
        'hunk-separator-unified-0',
        'hunk-separator-unified-1',
        'hunk-separator-unified-2',
      ]);
      // The gaps around the folded hunk merge into the fold row: their
      // separators go, even with some of their lines expanded.
      ctx.instance.setPresentation(
        { hiddenGaps: [1, 2] },
        new Map([
          [1, { fromStart: 3, fromEnd: 2 }],
          [2, { fromStart: 4, fromEnd: 0 }],
        ])
      );
      expect(slots()).toEqual(['fold-1', 'hunk-separator-unified-0']);
      expect(ctx.contentRows().map((row) => row.textContent?.trim())).toEqual([
        'line 10',
        'owned 10',
      ]);
      // Shown again, the expanded lines come back where they were.
      ctx.instance.setPresentation({ hiddenGaps: [] });
      const texts = ctx.contentRows().map((row) => row.textContent?.trim());
      expect(texts).toContain('line 13');
      expect(texts).toContain('line 28');
      expect(texts).toContain('line 34');
      expect(slots()).toContain('hunk-separator-unified-2');
    } finally {
      ctx.cleanup();
    }
  });

  test('a slot-anchored item sits at the row holding its slot', async () => {
    const ctx = setup({
      folds: [{ hunkIndex: 1, slotName: 'fold-1', collapsed: true }],
      annotations: [
        {
          id: 'hidden',
          side: 'additions',
          lineNumber: 30,
          anchorSlot: 'fold-1',
          metadata: 'hidden',
        },
      ],
    });
    try {
      await waitForCode(ctx.container);
      await nextFrame();
      const item = ctx.shadow().querySelector<HTMLElement>(
        '[data-overlay-item]'
      );
      expect(item?.hidden).toBe(false);
      const layout = ctx.instance.getAnnotationOverlayLayout();
      // Above the fold row: the gap row for lines 1–9, deletion 10,
      // addition 10 and the gap row for lines 11–29.
      expect(layout[0]?.anchorTop).toBe(4 * ROW_HEIGHT);
    } finally {
      ctx.cleanup();
    }
  });

  test('a landing tags its rows and a repeat swaps the key', async () => {
    const ctx = setup();
    try {
      await waitForCode(ctx.container);
      const land = (key: 'a' | 'b' | 'static') =>
        ctx.instance.setAnnotationOverlayState({
          landing: {
            range: { start: 10, end: 10, side: 'additions' },
            key,
          },
        });
      land('a');
      const tagged = () =>
        Array.from(
          ctx.shadow().querySelectorAll('[data-overlay-land]'),
          (el) => el.getAttribute('data-overlay-land')
        );
      // The row and its gutter cell.
      expect(tagged()).toEqual(['a', 'a']);
      land('b');
      expect(tagged()).toEqual(['b', 'b']);
      ctx.instance.setAnnotationOverlayState({ landing: undefined });
      expect(tagged()).toEqual([]);
    } finally {
      ctx.cleanup();
    }
  });

  test('gaps of 1 line render inline; 2 and 3 lines get a separator slot', async () => {
    const dom = installDom();
    const restoreGeometry = installGeometry();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const base = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const changed = [5, 7, 10, 14];
    const next = base.map((line, i) =>
      changed.includes(i + 1) ? `${line} changed` : line
    );
    const instance = new FileDiff<string>({
      diffStyle: 'unified',
      disableFileHeader: true,
      disableErrorHandling: true,
      hunkSeparators: 'custom',
    });
    try {
      instance.render({
        fileContainer: container,
        fileDiff: parseDiffFromFile(
          { name: 'gaps.ts', contents: `${base.join('\n')}\n` },
          { name: 'gaps.ts', contents: `${next.join('\n')}\n` },
          { context: 0 }
        ),
      });
      await waitForCode(container);
      const shadow = container.shadowRoot!;
      const lines = Array.from(
        shadow.querySelectorAll('[data-content] [data-line]'),
        (row) => row.textContent?.trim()
      );
      // L6 (a 1-line gap) is inline; L8–9 and L11–13 are not.
      expect(lines).toContain('line 6');
      expect(lines).not.toContain('line 8');
      expect(lines).not.toContain('line 12');
      const slots = new Set(
        Array.from(shadow.querySelectorAll('slot'), (slot) => slot.name)
      );
      expect(slots.has('hunk-separator-unified-1')).toBe(false);
      expect(slots.has('hunk-separator-unified-2')).toBe(true);
      expect(slots.has('hunk-separator-unified-3')).toBe(true);
    } finally {
      instance.cleanUp();
      restoreGeometry();
      dom.cleanup();
    }
  });

  test('a separator names its still-hidden lines through expansions', async () => {
    const dom = installDom();
    const restoreGeometry = installGeometry();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const instance = new FileDiff<string>({
      diffStyle: 'unified',
      disableFileHeader: true,
      disableErrorHandling: true,
      expansionLineCount: 5,
    });
    try {
      instance.render({
        fileContainer: container,
        fileDiff: parseDiffFromFile(oldFile, newFile, { context: 0 }),
      });
      await waitForCode(container);
      const ranges = () => [
        ...new Set(
          Array.from(
            container.shadowRoot!.querySelectorAll('[data-hidden-range]'),
            (el) => el.getAttribute('data-hidden-range')
          )
        ),
      ];
      const counts = () => [
        ...new Set(
          Array.from(
            container.shadowRoot!.querySelectorAll('[data-unmodified-lines]'),
            (el) => el.textContent
          )
        ),
      ];
      expect(ranges()).toEqual(['L1\u20139', 'L11\u201329', 'L31\u201340']);
      expect(counts()).toEqual([
        '9 unchanged lines',
        '19 unchanged lines',
        '10 unchanged lines',
      ]);
      // From the top of the middle gap, then from its bottom.
      instance.expandHunk(1, 'up', 5);
      expect(ranges()).toEqual(['L1\u20139', 'L16\u201329', 'L31\u201340']);
      instance.expandHunk(1, 'down', 5);
      expect(ranges()).toEqual(['L1\u20139', 'L16\u201324', 'L31\u201340']);
      // The trailing gap opens from its top.
      instance.expandHunk(2, 'up', 5);
      expect(ranges()).toEqual(['L1\u20139', 'L16\u201324', 'L36\u201340']);
    } finally {
      instance.cleanUp();
      restoreGeometry();
      dom.cleanup();
    }
  });
});
