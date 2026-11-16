# Third-party notices

`@workspace/ui` is MIT-licensed. It contains or depends on the third-party material below, which keeps
its own license.

## Copied or adapted into this package

| Material                                                                   | Where                                            | License                                                                                                                               |
| -------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| [shadcn/ui](https://github.com/shadcn-ui/ui) components and styles         | `src/components/*.tsx`, `src/styles/globals.css` | [MIT](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md), © 2023 shadcn                                                            |
| [Lucide](https://lucide.dev) `circle-dashed` icon, adapted to add an x     | `src/neuve/shared/marker-kind.tsx`               | [ISC](https://github.com/lucide-icons/lucide/blob/main/LICENSE), © 2026 Lucide Icons and Contributors                                 |
| [Lucide](https://lucide.dev) `circle-x` cross paths (Feather's `x-circle`) | `src/neuve/shared/marker-kind.tsx`               | [MIT](https://github.com/lucide-icons/lucide/blob/main/LICENSE), © 2013-present Cole Bemis; ISC, © 2026 Lucide Icons and Contributors |
| [Lucide](https://lucide.dev) `check` and `x` icons, derived from Feather   | `src/neuve/shared/review-mark.tsx`               | [MIT](https://github.com/lucide-icons/lucide/blob/main/LICENSE), © 2013-present Cole Bemis; ISC, © 2026 Lucide Icons and Contributors |

The Neuve logo and logotype (`src/neuve/shared/logo.tsx`, `src/neuve/shared/brand-mark.tsx`) are
Neuve's own; the MIT license does not grant trademark rights to the Neuve name or marks.

## Fonts

| Material                                                                                  | License                                       |
| ----------------------------------------------------------------------------------------- | --------------------------------------------- |
| [Geist](https://github.com/vercel/geist-font), via `@fontsource-variable/geist`           | SIL OFL 1.1, © 2024 The Geist Project Authors |
| [Geist Mono](https://github.com/vercel/geist-font), via `@fontsource-variable/geist-mono` | SIL OFL 1.1, © 2024 The Geist Project Authors |

Distributions that bundle the font files must keep the Geist and Geist Mono copyright notices and licenses.

## Dependencies with non-MIT licenses

These are installed from npm, not copied. Distributed bundles must carry their notices.

| Package                                                                      | License                                   |
| ---------------------------------------------------------------------------- | ----------------------------------------- |
| `class-variance-authority`, `pdfjs-dist`                                     | Apache-2.0                                |
| `lucide-react`                                                               | ISC; portions © Cole Bemis (Feather, MIT) |
| `@fontsource-variable/geist`, `@fontsource-variable/geist-mono` (font files) | OFL-1.1                                   |

The workspace dependency `@workspace/diffs` keeps its own Apache-2.0 [license](../diffs/LICENSE.md)
and [notice](../diffs/NOTICE.md). That notice records the copied source and the modifications.

All other runtime dependencies in [package.json](package.json) are MIT. Tailwind CSS is also MIT. It is
a development dependency, but `src/styles/globals.css` imports its CSS. The remaining development
dependencies are build, typechecking, linting, or Storybook tools and do not ship with the batch
overview or the review desk.
