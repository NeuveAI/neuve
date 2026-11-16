// Modified by Neuve AI in 2026: add a placeholder slot before rendering. See NOTICE.md.

import { DIFFS_TAG_NAME } from '../constants';
import styles from '../style.css?inline';
import { getMeasuredScrollbarGutter } from '../utils/scrollbarGutter';

// If HTMLElement is undefined it usually means we are in a server environment
// so best to just not do anything
if (
  typeof HTMLElement !== 'undefined' &&
  customElements.get(DIFFS_TAG_NAME) == null
) {
  let sheet: CSSStyleSheet | undefined;

  class FileDiffContainer extends HTMLElement {
    constructor() {
      super();
      // If shadow root is already open, we can sorta assume the
      // CSS is already in place
      if (this.shadowRoot != null) {
        return;
      }
      const shadowRoot = this.attachShadow({ mode: 'open' });
      if (sheet == null) {
        sheet = new CSSStyleSheet();
        sheet.replaceSync(styles);
      }
      shadowRoot.adoptedStyleSheets = [sheet];
      // NEUVE FORK: the host's placeholder (e.g. skeleton rows) shows until
      // the renderer adds its <pre> (style.css hides the slot after that), so
      // a host never sits blank between attach and its first render.
      const placeholder = document.createElement('slot');
      placeholder.name = 'placeholder';
      shadowRoot.append(placeholder);
    }

    connectedCallback() {
      const shadowRoot = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
      getMeasuredScrollbarGutter(shadowRoot);
    }
  }

  customElements.define(DIFFS_TAG_NAME, FileDiffContainer);
}

export const DiffsContainerLoaded = true;
