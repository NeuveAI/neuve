/**
 * Storybook's reduced-motion toolbar: one switch for motion/react and CSS.
 *
 * - motion/react reads `matchMedia("(prefers-reduced-motion)")` (through
 *   useReducedMotion and MotionConfig reducedMotion="user"), so matchMedia
 *   answers reduced-motion queries from the toolbar and fires `change`.
 * - CSS (Tailwind motion-reduce: / motion-safe:, globals.css, the diff's
 *   shadow-root styles) uses `@media (prefers-reduced-motion: …)`, so every
 *   such media rule is rewritten to an always-true or always-false query,
 *   in the document and in every open shadow root, and restored on "system".
 *
 * "system" leaves the OS preference in charge. The decorator remounts the
 * story when the mode changes, because useReducedMotion reads it once.
 */
export type ReducedMotionMode = "system" | "reduce" | "full"

const FEATURE =
  /\(\s*prefers-reduced-motion\s*(?::\s*(reduce|no-preference)\s*)?\)/g
/** Always true / always false, at any width (a zero-width frame included). */
const TRUE = "(min-width: 0px)"
const FALSE = "(not (min-width: 0px))"

let mode: ReducedMotionMode = "system"

/** The query with every reduced-motion feature replaced for `mode`. */
function resolve(query: string): string {
  if (mode === "system") return query
  return query.replace(FEATURE, (_feature, value: string | undefined) => {
    const asksReduce = value !== "no-preference"
    return asksReduce === (mode === "reduce") ? TRUE : FALSE
  })
}

/* ── matchMedia ─────────────────────────────────────────────────────── */

const nativeMatchMedia = window.matchMedia.bind(window)
/**
 * Query lists someone listens to. Held strongly, like the browser holds a
 * native list with listeners: motion/react keeps only its listener, which
 * would otherwise let the list be collected and miss every change.
 */
const listening = new Set<ShimQuery>()

class ShimQuery extends EventTarget implements MediaQueryList {
  private handler: MediaQueryList["onchange"] = null
  readonly media: string
  private last: boolean

  constructor(media: string) {
    super()
    this.media = media
    this.last = this.matches
  }

  get onchange() {
    return this.handler
  }

  set onchange(handler: MediaQueryList["onchange"]) {
    this.handler = handler
    if (handler) listening.add(this)
  }

  private listeners = 0

  override addEventListener(
    ...args: Parameters<EventTarget["addEventListener"]>
  ) {
    this.listeners++
    listening.add(this)
    super.addEventListener(...args)
  }

  override removeEventListener(
    ...args: Parameters<EventTarget["removeEventListener"]>
  ) {
    super.removeEventListener(...args)
    this.listeners = Math.max(0, this.listeners - 1)
    if (this.listeners === 0 && !this.handler) listening.delete(this)
  }

  get matches() {
    return nativeMatchMedia(resolve(this.media)).matches
  }

  /** Fires `change` when the toolbar flips the answer. */
  sync() {
    const matches = this.matches
    if (matches === this.last) return
    this.last = matches
    const event = new MediaQueryListEvent("change", {
      matches,
      media: this.media,
    })
    this.handler?.call(this, event)
    this.dispatchEvent(event)
  }

  addListener(listener: ((event: MediaQueryListEvent) => void) | null) {
    if (listener) this.addEventListener("change", listener as EventListener)
  }

  removeListener(listener: ((event: MediaQueryListEvent) => void) | null) {
    if (listener) this.removeEventListener("change", listener as EventListener)
  }
}

window.matchMedia = (query: string) => {
  FEATURE.lastIndex = 0
  if (!FEATURE.test(query)) return nativeMatchMedia(query)
  return new ShimQuery(query)
}

/* ── CSS media rules ────────────────────────────────────────────────── */

const original = new WeakMap<CSSMediaRule, string>()
/**
 * Every rule this shim has changed, held strongly: a module-level sheet (the
 * diff fork's) can be unmounted when the mode changes and still has to come
 * back to its original text before it's adopted again.
 */
const rewritten = new Set<CSSMediaRule>()

function rewriteRules(rules: CSSRuleList) {
  for (const rule of rules) {
    if (rule instanceof CSSMediaRule) {
      const source = original.get(rule) ?? rule.media.mediaText
      FEATURE.lastIndex = 0
      if (FEATURE.test(source)) {
        original.set(rule, source)
        const next = resolve(source)
        if (rule.media.mediaText !== next) rule.media.mediaText = next
        if (next === source) rewritten.delete(rule)
        else rewritten.add(rule)
      }
    }
    if (rule instanceof CSSImportRule && rule.styleSheet)
      rewriteSheet(rule.styleSheet)
    if ("cssRules" in rule) rewriteRules((rule as CSSGroupingRule).cssRules)
  }
}

function rewriteSheet(sheet: CSSStyleSheet) {
  try {
    rewriteRules(sheet.cssRules)
  } catch {
    // A cross-origin sheet (web fonts) can't be read and holds no motion.
  }
}

const observed = new WeakSet<Node>()
const observer = new MutationObserver(() => schedule())

function rewriteRoot(root: Document | ShadowRoot) {
  if (!observed.has(root)) {
    observed.add(root)
    observer.observe(root, { childList: true, subtree: true })
  }
  for (const sheet of root.styleSheets) rewriteSheet(sheet)
  for (const sheet of root.adoptedStyleSheets) rewriteSheet(sheet)
  for (const element of root.querySelectorAll("*"))
    if (element.shadowRoot) rewriteRoot(element.shadowRoot)
}

let pending = false
function schedule() {
  // On "system" with nothing rewritten, every sheet is already the original.
  if (pending || (mode === "system" && rewritten.size === 0)) return
  pending = true
  requestAnimationFrame(() => {
    pending = false
    rewriteRoot(document)
  })
}

// Constructed sheets arrive without a DOM mutation: catch them as they land.
for (const proto of [Document.prototype, ShadowRoot.prototype]) {
  const adopted = Object.getOwnPropertyDescriptor(proto, "adoptedStyleSheets")
  if (adopted?.set) {
    Object.defineProperty(proto, "adoptedStyleSheets", {
      ...adopted,
      set(this: Document | ShadowRoot, sheets: Array<CSSStyleSheet>) {
        adopted.set!.call(this, sheets)
        schedule()
      },
    })
  }
}
for (const method of ["replace", "replaceSync", "insertRule"] as const) {
  const native = CSSStyleSheet.prototype[method] as (
    ...args: Array<unknown>
  ) => unknown
  CSSStyleSheet.prototype[method] = function (
    this: CSSStyleSheet,
    ...args: Array<unknown>
  ) {
    const result = native.apply(this, args)
    schedule()
    return result
  } as never
}

/** Sets the toolbar mode; idempotent, so the decorator can call it each render. */
export function setReducedMotion(next: ReducedMotionMode) {
  document.documentElement.dataset.reducedMotion = next
  if (next === mode) return
  mode = next
  // Mounted or not: every rule changed before follows the new mode.
  for (const rule of [...rewritten]) {
    const source = original.get(rule)!
    const value = resolve(source)
    if (rule.media.mediaText !== value) rule.media.mediaText = value
    if (value === source) rewritten.delete(rule)
  }
  rewriteRoot(document)
  for (const query of listening) query.sync()
}

/** motion/react's MotionConfig value for a mode. */
export function motionConfigValue(next: ReducedMotionMode) {
  return next === "reduce" ? "always" : next === "full" ? "never" : "user"
}
