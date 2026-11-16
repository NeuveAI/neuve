// Modified by Neuve AI in 2026: compare annotation ids and anchor slots. See NOTICE.md.

import type { DiffLineAnnotation } from '../types';

export function areDiffLineAnnotationsEqual<LAnnotation = undefined>(
  annotationA: DiffLineAnnotation<LAnnotation>,
  annotationB: DiffLineAnnotation<LAnnotation>
): boolean {
  return (
    annotationA.lineNumber === annotationB.lineNumber &&
    annotationA.side === annotationB.side &&
    // NEUVE FORK: overlay annotations are keyed by id.
    annotationA.id === annotationB.id &&
    annotationA.anchorSlot === annotationB.anchorSlot &&
    annotationA.metadata === annotationB.metadata
  );
}
