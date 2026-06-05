# assets

Project images, grouped by purpose. Most `.png` files are rendered from a sibling `.html` generator — open the HTML in a browser at the canvas size set in its CSS and screenshot it (or capture headless), then overwrite the `.png`.

## brand/

| File | Size | Notes |
|---|---|---|
| `logo.svg` | vector | Canonical logo. The docs site keeps its own copy at `docs/public/logo.svg` (VitePress serves it as site logo + favicon) — keep the two in sync. |
| `logo.png` | 1024×1024 | Raster logo for contexts that can't use SVG. |
| `favicon.svg` | vector | Favicon mark. |

## screenshots/

| File | Size | Used by |
|---|---|---|
| `report-overview.png` | 2880×2240 | embedded in `README.md` |
| `report-overview-zh.png` | 2880×2200 | embedded in `README.zh.md` |

Re-shoot from a real `omk eval` report page (retina / 2× scale) when the report UI changes.

## social/

| File | Size | Generator | Notes |
|---|---|---|---|
| `social-preview.png` | 1280×640 | `social-preview.html` | OG card (2:1). Used as the GitHub repo social preview; wire into `og:image` if/when added. |
| `social-preview.zh.png` | 1080×1080 | — (standalone) | Square zh card. No HTML generator — edit the image directly. |

## poster/

| File | Size | Generator |
|---|---|---|
| `omk-name-poster.png` | 2160×2240 | `omk-name-poster.html` (1080px-wide canvas, captured at 2×) |

Promotional poster ("why the yardstick is called omk"). Not referenced by code or docs.
