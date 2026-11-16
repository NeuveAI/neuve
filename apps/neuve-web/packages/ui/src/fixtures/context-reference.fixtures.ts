import type { ContextualMarker } from "@workspace/ui/neuve/types"

/**
 * Three published context references from a real review (the batch that
 * offers line commenting only within a unit's owned ranges), as the BFF's
 * projection gives them to the desk: one that supports the change, one that
 * is background, and one unchecked lead whose stance is unresolved. Their
 * cards and source sheets lead with the reference's tie to the unit.
 */
export const contextReferenceFixtures = {
  supports: {
    key: "reference-supports",
    tone: "batch",
    short: "Same batch",
    target: "apps/neuve-web/packages/ui/src/neuve/review-desk/diff-surface.tsx",
    peek: "The desk adapter maps SelectionPoint side/line to the current ownership callback and only passes the option under limitsComments.",
    kindLabel: "Same batch · unreviewed",
    title: "apps/neuve-web/packages/ui/src/neuve/review-desk/diff-surface.tsx",
    meta: "Supports",
    quote: "onLineSelected: select,",
    applies:
      "The desk adapter maps SelectionPoint side/line to the current ownership callback and only passes the option under limitsComments.",
    check:
      "Verify undefined sides map to additions consistently and unranged callers omit the option.",
    reference: {
      stance: "supports",
      grade: "necessary",
    },
    sharedWith: [
      "01M5J6XYHD0001GBG6518PJSGG",
      "01M5J6XYHD0005646FXT9M5GQQ",
      "01M5J6XYHD0002GY7249WVHME2",
    ],
    source: {
      kind: "Code",
      chips: [],
      title:
        "apps/neuve-web/packages/ui/src/neuve/review-desk/diff-surface.tsx",
      subtitle:
        "apps/neuve-web/packages/ui/src/neuve/review-desk/diff-surface.tsx@5fa1ba94d6a0:446-460",
      path: "apps/neuve-web/packages/ui/src/neuve/review-desk/diff-surface.tsx",
      actions: [
        {
          kind: "copy-path",
          path: "apps/neuve-web/packages/ui/src/neuve/review-desk/diff-surface.tsx",
        },
      ],
      facts: [],
      blocks: [
        {
          kind: "code",
          lines: [
            {
              number: 440,
              text: "              enableLineSelection: true,",
              cited: false,
            },
            {
              number: 441,
              text: "              enableKeyboardLineSelection: true,",
              cited: false,
            },
            {
              number: 442,
              text: "              touchTapExtendsSelection: true,",
              cited: false,
            },
            {
              number: 443,
              text: '              lineHoverHighlight: "number" as const,',
              cited: false,
            },
            {
              number: 444,
              text: "              enableGutterUtility: true,",
              cited: false,
            },
            {
              number: 445,
              text: "              onLineSelectionChange: select,",
              cited: false,
            },
            {
              number: 446,
              text: "              onLineSelected: select,",
              cited: true,
            },
            {
              number: 447,
              text: "              onLineSelectionCommit: commit,",
              cited: true,
            },
            {
              number: 448,
              text: "              onGutterUtilityClick: commit,",
              cited: true,
            },
            {
              number: 449,
              text: "              ...(limitsComments",
              cited: true,
            },
            {
              number: 450,
              text: "                ? {",
              cited: true,
            },
            {
              number: 451,
              text: "                    isLineCommentable: (point: SelectionPoint) =>",
              cited: true,
            },
            {
              number: 452,
              text: "                      callbacks.current.isLineCommentable?.(",
              cited: true,
            },
            {
              number: 453,
              text: '                        point.side ?? "additions",',
              cited: true,
            },
            {
              number: 454,
              text: "                        point.lineNumber",
              cited: true,
            },
            {
              number: 455,
              text: "                      ) ?? true,",
              cited: true,
            },
            {
              number: 456,
              text: "                  }",
              cited: true,
            },
            {
              number: 457,
              text: "                : {}),",
              cited: true,
            },
            {
              number: 458,
              text: "            }",
              cited: true,
            },
            {
              number: 459,
              text: "          : {}),",
              cited: true,
            },
            {
              number: 460,
              text: "      }",
              cited: true,
            },
            {
              number: 461,
              text: "      const pool = getDiffWorkerPool()",
              cited: false,
            },
            {
              number: 462,
              text: "      const instance: Instance = virtualizer",
              cited: false,
            },
            {
              number: 463,
              text: "        ? new VirtualizedFileDiff(options, virtualizer, METRICS, pool, true)",
              cited: false,
            },
            {
              number: 464,
              text: "        : new FileDiff(options, pool, true)",
              cited: false,
            },
            {
              number: 465,
              text: "      // Exposed for stories and tests (which renderer is mounted).",
              cited: false,
            },
            {
              number: 466,
              text: '      host.dataset.virtualized = virtualizer ? "true" : "false"',
              cited: false,
            },
          ],
          caption: "Lines 446–460, after this change",
        },
      ],
      citedBy: [
        "This unit",
        "Add the optional line-comment eligibility contract",
        "Extract line comment eligibility from renderer options",
        "Forward line-comment eligibility in interaction options",
      ],
    },
  },
  background: {
    key: "reference-background",
    tone: "signal",
    short: "Signal",
    target: "apps/neuve-web/packages/diffs/src/managers/InteractionManager.ts",
    peek: "Keyboard and focus paths create SelectionPoint from the resolved target side rather than inferring it in the desk.",
    kindLabel: "Contextual signal",
    title: "apps/neuve-web/packages/diffs/src/managers/InteractionManager.ts",
    meta: "Background",
    quote: "",
    applies:
      "Keyboard and focus paths create SelectionPoint from the resolved target side rather than inferring it in the desk.",
    check:
      "Trace diff-mode resolved sides through to the ownership predicate for deletion and context cells.",
    reference: {
      stance: "background",
      grade: "necessary",
    },
    sharedWith: ["01M5J6XYHD000C8TAHPRSWHYSY", "01M5J6XYHD000ESWZ065ZHK3V6"],
    source: {
      kind: "Code",
      chips: [],
      title: "apps/neuve-web/packages/diffs/src/managers/InteractionManager.ts",
      subtitle:
        "apps/neuve-web/packages/diffs/src/managers/InteractionManager.ts@5fa1ba94d6a0:1658-1670",
      path: "apps/neuve-web/packages/diffs/src/managers/InteractionManager.ts",
      actions: [
        {
          kind: "copy-path",
          path: "apps/neuve-web/packages/diffs/src/managers/InteractionManager.ts",
        },
      ],
      facts: [],
      blocks: [
        {
          kind: "code",
          lines: [
            {
              number: 1652,
              text: "  ): SelectionInfo | undefined {",
              cited: false,
            },
            {
              number: 1653,
              text: "    const path = this.resolveSelectionPath(event, options);",
              cited: false,
            },
            {
              number: 1654,
              text: "    return path != null",
              cited: false,
            },
            {
              number: 1655,
              text: "      ? this.selectionInfoFromPath(path, options.requireNumberColumn)",
              cited: false,
            },
            {
              number: 1656,
              text: "      : undefined;",
              cited: false,
            },
            {
              number: 1657,
              text: "  }",
              cited: false,
            },
            {
              number: 1658,
              text: "",
              cited: true,
            },
            {
              number: 1659,
              text: "  private selectionPointFromPath(",
              cited: true,
            },
            {
              number: 1660,
              text: "    path: (EventTarget | undefined)[]",
              cited: true,
            },
            {
              number: 1661,
              text: "  ): SelectionPoint | undefined {",
              cited: true,
            },
            {
              number: 1662,
              text: "    const target = this.resolvePointerTarget(path);",
              cited: true,
            },
            {
              number: 1663,
              text: "    if (!isLinePointerTarget(target)) {",
              cited: true,
            },
            {
              number: 1664,
              text: "      return undefined;",
              cited: true,
            },
            {
              number: 1665,
              text: "    }",
              cited: true,
            },
            {
              number: 1666,
              text: "    return {",
              cited: true,
            },
            {
              number: 1667,
              text: "      lineNumber: target.lineNumber,",
              cited: true,
            },
            {
              number: 1668,
              text: "      side: this.mode === 'diff' ? target.side : undefined,",
              cited: true,
            },
            {
              number: 1669,
              text: "    };",
              cited: true,
            },
            {
              number: 1670,
              text: "  }",
              cited: true,
            },
            {
              number: 1671,
              text: "",
              cited: false,
            },
            {
              number: 1672,
              text: "  private resolveSelectionPoint(",
              cited: false,
            },
            {
              number: 1673,
              text: "    event: PointerEvent,",
              cited: false,
            },
            {
              number: 1674,
              text: "    options: SelectionHitOptions",
              cited: false,
            },
            {
              number: 1675,
              text: "  ): SelectionPoint | undefined {",
              cited: false,
            },
            {
              number: 1676,
              text: "    const path = this.resolveSelectionPath(event, options);",
              cited: false,
            },
          ],
          caption: "Lines 1658–1670, after this change",
        },
      ],
      citedBy: [
        "This unit",
        "Bridge renderer selection points to desk comment eligibility",
        "Make focused gutter names reflect comment eligibility",
      ],
    },
  },
  unchecked: {
    key: "reference-unchecked",
    tone: "signal",
    short: "Signal",
    target: "apps/neuve-web/packages/diffs/src/managers/InteractionManager.ts",
    peek: "A preloaded lead for this hunk, kept without regrading.",
    kindLabel: "Contextual signal",
    title: "apps/neuve-web/packages/diffs/src/managers/InteractionManager.ts",
    meta: "Unclear fit",
    quote: "",
    applies: "A preloaded lead for this hunk, kept without regrading.",
    check: "Check whether it applies to these lines at all.",
    reference: {
      stance: "unresolved",
      grade: "useful",
    },
    sharedWith: ["01M5J6XYHD000ESWZ065ZHK3V6"],
    source: {
      kind: "Code",
      chips: [],
      title: "apps/neuve-web/packages/diffs/src/managers/InteractionManager.ts",
      subtitle:
        "apps/neuve-web/packages/diffs/src/managers/InteractionManager.ts@c0c47cea1f5e:590-627",
      path: "apps/neuve-web/packages/diffs/src/managers/InteractionManager.ts",
      actions: [
        {
          kind: "copy-path",
          path: "apps/neuve-web/packages/diffs/src/managers/InteractionManager.ts",
        },
      ],
      facts: [],
      blocks: [
        {
          kind: "code",
          lines: [
            {
              number: 584,
              text: "      return false;",
              cited: false,
            },
            {
              number: 585,
              text: "    }",
              cited: false,
            },
            {
              number: 586,
              text: "    const top = this.selectionPointRowIndex(ends.top);",
              cited: false,
            },
            {
              number: 587,
              text: "    const bottom = this.selectionPointRowIndex(ends.bottom);",
              cited: false,
            },
            {
              number: 588,
              text: "    return top != null && bottom != null && index >= top && index <= bottom;",
              cited: false,
            },
            {
              number: 589,
              text: "  }",
              cited: false,
            },
            {
              number: 590,
              text: "",
              cited: true,
            },
            {
              number: 591,
              text: "  // One gutter cell is the tab stop: the last keyboard-focused line, else the",
              cited: true,
            },
            {
              number: 592,
              text: "  // top of the selection, else the first changed line, else the first line.",
              cited: true,
            },
            {
              number: 593,
              text: "  // Re-applied after every selection render because rows can be re-created.",
              cited: true,
            },
            {
              number: 594,
              text: "  private syncGutterTabStop(): void {",
              cited: true,
            },
            {
              number: 595,
              text: "    const { pre } = this;",
              cited: true,
            },
            {
              number: 596,
              text: "    if (",
              cited: true,
            },
            {
              number: 597,
              text: "      pre == null ||",
              cited: true,
            },
            {
              number: 598,
              text: "      this.options.enableKeyboardLineSelection !== true ||",
              cited: true,
            },
            {
              number: 599,
              text: "      this.options.enableLineSelection !== true",
              cited: true,
            },
            {
              number: 600,
              text: "    ) {",
              cited: true,
            },
            {
              number: 601,
              text: "      return;",
              cited: true,
            },
            {
              number: 602,
              text: "    }",
              cited: true,
            },
            {
              number: 603,
              text: "    const cells = pre.querySelectorAll<HTMLElement>('[data-column-number]');",
              cited: true,
            },
            {
              number: 604,
              text: "    if (cells.length === 0) {",
              cited: true,
            },
            {
              number: 605,
              text: "      return;",
              cited: true,
            },
            {
              number: 606,
              text: "    }",
              cited: true,
            },
            {
              number: 607,
              text: "    const preferred =",
              cited: true,
            },
            {
              number: 608,
              text: "      (this.keyboardFocusPoint != null",
              cited: true,
            },
            {
              number: 609,
              text: "        ? this.targetForSelectionPoint(this.keyboardFocusPoint)?.numberElement",
              cited: true,
            },
            {
              number: 610,
              text: "        : undefined) ??",
              cited: true,
            },
            {
              number: 611,
              text: "      (() => {",
              cited: true,
            },
            {
              number: 612,
              text: "        const ends = this.currentSelectionEnds();",
              cited: true,
            },
            {
              number: 613,
              text: "        return ends != null",
              cited: true,
            },
            {
              number: 614,
              text: "          ? this.targetForSelectionPoint(ends.top)?.numberElement",
              cited: true,
            },
            {
              number: 615,
              text: "          : undefined;",
              cited: true,
            },
            {
              number: 616,
              text: "      })() ??",
              cited: true,
            },
            {
              number: 617,
              text: "      pre.querySelector<HTMLElement>(",
              cited: true,
            },
            {
              number: 618,
              text: "        \"[data-column-number]:is([data-line-type='change-deletion'], [data-line-type='change-addition'])\"",
              cited: true,
            },
            {
              number: 619,
              text: "      ) ??",
              cited: true,
            },
            {
              number: 620,
              text: "      cells[0];",
              cited: true,
            },
            {
              number: 621,
              text: "    for (const cell of cells) {",
              cited: true,
            },
            {
              number: 622,
              text: "      const isStop = cell === preferred;",
              cited: true,
            },
            {
              number: 623,
              text: "      if (cell.tabIndex !== (isStop ? 0 : -1)) {",
              cited: true,
            },
            {
              number: 624,
              text: "        cell.tabIndex = isStop ? 0 : -1;",
              cited: true,
            },
            {
              number: 625,
              text: "      }",
              cited: true,
            },
            {
              number: 626,
              text: "    }",
              cited: true,
            },
            {
              number: 627,
              text: "  }",
              cited: true,
            },
            {
              number: 628,
              text: "",
              cited: false,
            },
            {
              number: 629,
              text: "  // Focusing a line number reveals the comment/gutter utility on it, so the",
              cited: false,
            },
            {
              number: 630,
              text: "  // affordance is never hover-only.",
              cited: false,
            },
            {
              number: 631,
              text: "  private handleGutterFocusIn = (event: FocusEvent): void => {",
              cited: false,
            },
            {
              number: 632,
              text: "    const target = event.composedPath()[0];",
              cited: false,
            },
            {
              number: 633,
              text: "    if (",
              cited: false,
            },
          ],
          caption: "Lines 590–627, before this change",
        },
      ],
      citedBy: [
        "This unit",
        "Make focused gutter names reflect comment eligibility",
      ],
    },
  },
} satisfies Record<string, ContextualMarker>
