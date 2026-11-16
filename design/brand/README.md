# Neuve brand

The files here are exported from the Figma page **Brand and launch** in the [Design System file](https://www.figma.com/design/Ye2zTyk0LbcwufrAKv3HAS/Design-System?node-id=413-2). That page is the source: change the design there, then export again. The mark is the one in [`logo.tsx`](../../apps/neuve-web/packages/ui/src/neuve/shared/logo.tsx), and the horizontal lockup keeps the proportions of the app header in [`brand-mark.tsx`](../../apps/neuve-web/packages/ui/src/neuve/shared/brand-mark.tsx). Colours come from [`globals.css`](../../apps/neuve-web/packages/ui/src/styles/globals.css).

## Name and marks

Neuve's code is under the MIT license in the root [`LICENSE`](../../LICENSE). The Neuve name, the mark, the logotype and the files in `assets/` ([their notice](assets/NOTICE.md)) are Neuve's own; the MIT license does not grant trademark rights to the Neuve name or marks. The same holds for their copies in the apps: the favicons and icons in `apps/app/public/` and `apps/neuve-web/apps/web/public/`, and `apps/app/src/assets/neuve-avatar*.svg`. The logo code has the same note in the [web app UI notice](../../apps/neuve-web/packages/ui/NOTICE.md).

## Usage rules

- **Colour.** Use ink `#1C1A16` on light backgrounds and `#EDEAE3` on dark ones. Where neither works, such as print, photos or another company's page, use the black or white file. Never recolour the mark, add effects to it, or put it in a gradient.
- **Gold is not a brand colour.** Gold marks focus, selection and the tint on lines a link lands on, inside the product ([decision 12.17](../../process/decisions.md)). It appears in launch images only where the product itself shows it.
- **Clear space.** Leave at least half the mark's height clear on every side of the mark or the lockup. The files don't include that space: the mark's 306 × 306 box leaves only about a tenth of the mark's height on each side, so add the rest around the file.
- **Minimum size.** The smallest lockup is the one in the app header: mark 22px, word 17px. The smallest mark is 16px, and it uses the favicon crop.
- **The word.** "Neuve" is set in Geist SemiBold with normal tracking. The logo files have it outlined; anywhere else, set it as live Geist text. Never set it in another typeface.
- **Proportions.** Never stretch, rotate or rearrange the lockups. Use the horizontal lockup by default, and the stacked one only in square spaces.
- **App icon.** The ink tile is the primary icon; its mark is paper `#FAF8F3`, the light background colour. Use the paper tile only where the surroundings are dark and the ink tile would disappear. Platforms that mask icons (Android, PWA, avatars) take the square file: its mark sits inside the 80% safe circle.
- **Images show the product's own screens.** Launch images use the Figma Screens, which mirror the review desk and batch overview in the code, with their sample review data. Never draw invented UI.

## Assets

### Logo (`assets/logo/`, SVG)

| File | What it is |
| --- | --- |
| `neuve-mark.svg` · `-dark` · `-black` · `-white` | The mark in its 306 × 306 box, in ink for light backgrounds, `#EDEAE3` for dark ones, and one-colour black and white |
| `neuve-mark-adaptive.svg` | The mark in its 306 × 306 box, switching from ink to `#EDEAE3` with the viewer's dark mode. For places that use the file as a mask or need the padding, such as the favicon of the app in `apps/app` |
| `neuve-lockup.svg` · `-dark` · `-black` · `-white` | Mark and word side by side, 319 × 88 |
| `neuve-lockup-stacked.svg` · `-dark` · `-black` · `-white` | Mark above the word, 152 × 178, for square spaces |

### Icons (`assets/icon/`)

| File | Size | Where it goes |
| --- | --- | --- |
| `favicon.svg` | vector | Browser tab. The mark cropped to its drawing; it switches to `#EDEAE3` in dark mode |
| `favicon.ico` | 16, 32, 48 | `/favicon.ico` fallback for browsers without SVG favicons |
| `favicon-16.png` · `-32` · `-48` | 16 to 48 | PNG favicons, where a page lists them |
| `apple-touch-icon-180.png` | 180 | `<link rel="apple-touch-icon">`. Square, because iOS rounds the corners itself |
| `neuve-app-icon.svg` · `-1024.png` · `-512.png` · `-192.png` | 1024 to 192 | The rounded ink app icon: web-app manifest (`purpose: any`), docs, the README |
| `neuve-app-icon-square.svg` · `-maskable-512.png` · `-maskable-192.png` | 512, 192 | Web-app manifest (`purpose: maskable`) and other platforms that mask the icon |
| `neuve-app-icon-paper.svg` · `-paper-1024.png` | 1024 | The paper tile, for dark surroundings |
| `neuve-avatar-512.png` | 512 | GitHub organisation avatar and other social profile pictures (they crop it to a circle) |

### Launch images (`assets/social/`, PNG at 1× and 2×)

| File | Size at 1× | Where it goes |
| --- | --- | --- |
| `readme-hero-light.png` · `readme-hero-dark.png` | 1280 × 640 | Top of the root README, switched with `<picture>` by the reader's theme |
| `github-social-preview.png` | 1280 × 640 | Repository settings › Social preview. Upload the 1× file: 1280 × 640 is the size GitHub recommends, and it stays under the 1 MB limit |
| `og-image.png` | 1200 × 630 | `og:image` and `twitter:image` for the site, with `twitter:card` set to `summary_large_image` |
| `x-header.png` | 1500 × 500 | X profile header. The lower left stays clear for the profile picture |
| `linkedin-banner.png` | 1584 × 396 | LinkedIn page banner. The left quarter stays clear for the page logo |
| `article-hero.png` | 1600 × 900 | The launch article's lead image |
| `post-card-1200x675.png` | 1200 × 675 | Landscape image for posts on X, LinkedIn and Bluesky |
| `post-card-1080.png` | 1080 × 1080 | Square image for posts |

Each launch image also has an `@2x` file at double the size.

### Text on the launch images

The headline and lead live once, in the Figma `Launch / Title` component, so changing them there changes every image. Each image sets its own line breaks.

| Slot | Text |
| --- | --- |
| Headline | Large code changes never felt so small |
| Lead | Focus only on parts that require human attention or approval, with the certainty your codebase deserves. |
| Lead, X header only | Focus only on parts that require human attention or approval. |
| Small line, OG image only | None yet: held until the `LICENSE` file is on main |

### Alt text

Use these wherever an image is placed in a page or post.

| File | Alt text |
| --- | --- |
| `readme-hero-light.png`, `readme-hero-dark.png`, `github-social-preview.png`, `og-image.png`, `post-card-1200x675.png` | Large code changes never felt so small. Focus only on parts that require human attention or approval, with the certainty your codebase deserves. Neuve's review desk shows one part of a change, "Index writes retry when the database is busy": how Commit behaves before and after the change, and the status of the part's checkpoints. |
| `linkedin-banner.png` | Large code changes never felt so small. Focus only on parts that require human attention or approval, with the certainty your codebase deserves. Neuve's review desk shows one part of a change, "Index writes retry when the database is busy": how Commit behaves before and after the change, and the first of the part's checkpoints. |
| `x-header.png` | Large code changes never felt so small. Focus only on parts that require human attention or approval. Neuve's review desk shows one part of a change, "Index writes retry when the database is busy": how Commit behaves before and after the change, and the first two of the part's checkpoints. |
| `article-hero.png` | Large code changes never felt so small. Focus only on parts that require human attention or approval, with the certainty your codebase deserves. Two parts of a change in Neuve's review desk: "Revoke cuts off open sessions" with its diff and a conflict marker, and "Index writes retry when the database is busy" with how Commit behaves before and after the change, and its first two checkpoints. |
| `post-card-1080.png` | Large code changes never felt so small. Focus only on parts that require human attention or approval, with the certainty your codebase deserves. Neuve's review desk shows one part of a change, "Revoke cuts off open sessions": its diff, and a context card that flags a conflict between ticket SHR-212 and a May decision in the history. |

## Exporting again

The SVGs are built from the mark's path data in `logo.tsx` and from the word as outlined in Figma, so the mark stays identical to the app's. Export the PNGs from the frames on the Figma page: every launch frame carries 1× and 2× PNG export settings. Render the icons from the `Brand / App icon` component at 1024 and scale them down.
