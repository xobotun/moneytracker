# Icons: Design

**Status:** Decided with Pavel, 2026-10-28. Steps 1 and 2 built (see "As built" at the end).
**Applies to:** everything with an icon — tags, accounts, account groups.

---

## 1. Intent

Today an icon is a PrimeIcons name. A merchant wants its logo (Rewe, Edeka, Amazon), some names are best as a word in a typeface (C&A in Helvetica, the Armenian SAS in Times), and an emoji is often the quickest pick. Developers may add another icon pack later. One icon model and one picker serve all of it.

**Non-goals:** user-installed icon packs; animated images; editing images in the app (cropping beyond fitting).

---

## 2. Kinds of icon

An icon is a small typed value, stored as a JSON object in the existing `icon` column (`TEXT … CHECK (icon IS NULL OR json_valid(icon))`; NULL = inherited from the parent, for tags). Migration 002 is edited in place (no real data yet).

| Kind | Stored as | Notes |
|---|---|---|
| Icon from a pack | `{"kind":"set","set":"pi","name":"shop"}` | PrimeIcons is the set `pi`. |
| Emoji | `{"kind":"emoji","emoji":"🛒"}` | Looks as each device's system draws it. |
| Image | `{"kind":"image","image":"<image id>"}` | An uploaded picture, or a word made in the Text tab. See §3. |

So drawing knows three kinds only. **A word is an image:** the Text tab makes an SVG of it — up to about 6 characters, shrunk to fit the circle, in a font (below), bold or not, with its own text colour and background colour, not the tag's (a new one starts with the tag's current colour as background and a readable text colour, white or black). The image row keeps the settings it was made from (§3), so the Text tab can reopen it to change it; a change makes a new image.

- **Icon packs** are registered in code (`src/icons/`): an id, a label, its icon names, and how to draw one. Adding a pack is a new entry and a lazy import; nothing changes in the data. An icon from a pack or of a kind this build does not know (synced from a newer app) draws as the kind's default icon, never as an error.
- **Fonts** are system font stacks only, so nothing is downloaded: Sans (Helvetica, Arial), Serif (Times New Roman, Times), Mono, Condensed; plus bold.
- SVG text uses the fonts of the device that shows it, so a word looks slightly different across systems (Helvetica on Apple, Arial or a lookalike elsewhere). Identical everywhere would take converting the letters to outlines with bundled font files (a few hundred KB) — a possible later option, not now.

---

## 3. Images

- A synced `images` table holds them: `id` (a UUIDv5 of the content's SHA-256, so the same logo added on two devices is one row, and twenty stores share it), the media type, the content, its size, `source` (JSON: the Text tab's settings for a word; NULL for an upload), and the sync columns. Rows never change; a new picture is a new row.
- **A word** is an SVG the app writes itself (the text escaped), stored like an uploaded SVG and cleaned the same way.
- **Raster pictures** (PNG, JPEG, WebP, …) are scaled down on the device to fit 256×256, keeping their proportions on a transparent background, and stored as WebP.
- **SVG stays vector**, made safe three ways: on upload it is cleaned (DOMPurify with the SVG profile: no scripts, event handlers, `foreignObject` or external references); it is only ever drawn as an image (`<img>` / data URL), where browsers run no scripts and load nothing. An SVG over 100 KB (after cleaning) shows a warning — every device syncs it — with a "Use it anyway" button; only one over 1 MB is refused.
- Images load by id on demand and are cached for the session; a badge whose image is missing (not synced yet) draws the kind's default icon.

---

## 4. Drawing

One badge component draws every kind everywhere: rows, chips, picker options, dialogs, the accounts page and the map pins (which need the same badge as an HTML string for Leaflet).

- **Pack icon:** as today — the icon in a readable colour on the tag's colour.
- **Emoji:** on a light tint of the tag's colour.
- **Image:** the picture inside the circle on a neutral background, with the tag's colour as a thin ring, so a logo is not drowned in colour. A word fills the circle with its own background, so it shows the ring only.
- Small renderings (chips, picker options) show a small badge for every kind but the pack icon, which stays a bare icon in the tag's colour.

---

## 5. Picker

- The quick picks (PrimeIcons) stay in the edit dialogs.
- "All icons" becomes a dialog (full screen on a phone) with tabs:
  - **Icons** — one per installed pack, searchable (today's list).
  - **Emoji** — a full, searchable emoji picker library, loaded only when the tab opens, with its emoji data bundled with the app (not fetched from a CDN), so it works offline.
  - **Text** — the text, the font, bold, the text colour and the background colour, with a live preview; saving makes the word's image. Opened on an icon that is a word, it starts from that word's settings.
  - **Image** — choose a file (raster or SVG); a preview of the result; for an SVG over 100 KB a warning with "Use it anyway"; an error for one over 1 MB or a file that is no image.

---

## 6. Build order

1. The data model (icon JSON in tags, accounts and groups; the `images` table, synced), the icon packs registry, the badge, and every place that draws an icon switched to it.
2. The picker dialog with its four tabs, image import (downscaling, SVG cleaning), the emoji library.

---

## As built (step 1)

2026-10-28. The data model, the packs registry, the badge, and every place that draws an icon.

- **Value:** `src/icons/types.ts` — `Icon` is `set` / `emoji` / `image`, plus `unknown`: anything that is not exactly one of the three (another kind, a field more or less) keeps its column text and is written back unchanged. Known kinds are written with a fixed key order; saves compare icons as stored text (`sameIcon`), so an untouched save still writes nothing. A `set` icon of a pack this build lacks stays a `set` icon and draws the default. Column mappers `iconToColumn` / `iconFromColumn` (+ nullable).
- **Images:** the `images` table is in migration 002, first in `SYNC_TABLES`; its timestamps are in `EQUALITY_IGNORED_COLUMNS` like those of `applied_rates`, so the same picture put on two devices is one row and no conflict. Id: `nameBasedId('images', <SHA-256 hex of the stored text>)` (the base64 for WebP); the media type is not part of the key. `ImagesRepository.put` is `INSERT … ON CONFLICT DO NOTHING` (not `OR IGNORE`, which would swallow a CHECK failure). `useImagesStore` reads by id and keeps the data URL; a miss is retried on the next `load`.
- **Packs:** `src/icons/sets.ts` (PrimeIcons as `pi`), with `QUICK_ICONS` and `iconLabel`.
- **Default icon** (drawn for an unknown kind or pack icon and while an image loads or is missing): the kind's (`KIND_ICONS`, carried as `TagLook.fallback`), `wallet` for accounts, `folder` for groups (their new-group icon).
- **Drawing:** `src/icons/face.ts` decides what a badge shows; `IconBadge.vue` (was `AccountBadge.vue`) and `badgeElement.ts` (the map pins, built with DOM APIs) render it. An emoji's tint is per theme: light (OKLCH L 0.92) in the light theme, dark (L 0.36) in the dark one. A picture sits on white in both themes; an upload is inset 15 %, a word (`source` set) fills the circle. Inline (chips, picker options) a pack icon is a bare icon as wide as the tiny badge, so labels line up.
- The quick picks and the "all icons" popover still pick PrimeIcons only; the "all icons" tile shows a picked emoji or picture.

---

## As built (step 2)

2026-10-28. The icon dialog, image import, the emoji library.

- **Dialog:** `IconDialog.vue`, opened from the "all icons" tile of `IconPicker.vue` (the popover is gone; the quick picks stay). A PrimeVue Dialog, full screen below `sm`, with Tabs: Icons, Emoji, Text, Image (`IconsTab` / `EmojiTab` / `TextTab` / `ImageTab.vue`). Picking or saving in any tab sets the icon and closes. It opens on the tab of the current icon: an emoji on Emoji; an image whose `source` reads as a word (`wordFromSource`) on Text with those settings; another image on Image, showing it; anything else on Icons. Every open PrimeVue dialog hears Escape, so `IconPicker` exposes `v-model:open` and the tag, account and group dialogs ignore Escape while it is open. Previews use `IconBadge` with a `preview` picture (an unsaved image) and a new `xl` size.
- **Icons tab:** one searchable section per pack in `ICON_SETS` (today PrimeIcons).
- **Emoji tab:** [emoji-picker-element](https://github.com/nolanlawson/emoji-picker-element) — a small, maintained, accessible web component with search and skin tones (1.29, 2026), taking its data from a URL, which suits a bundled asset; emoji-mart (the alternative) last released 5.6.0 in April 2024. `src/icons/emojiPicker.ts` is imported when the tab first opens; its data (`emoji-picker-element-data`, English, emojibase) is a build asset imported with `?url` and passed as `dataSource`, so nothing comes from a CDN. Lazy cost: the picker chunk is 40 KB (14 KB gzip), the data 440 KB (74 KB gzip); the library keeps the data in its own IndexedDB after the first load. The service worker precaches both: `workbox.globPatterns` adds `json` (and `woff2`, so the PrimeIcons font is there offline too). The picker takes the app's theme (a `dark` / `light` class) and PrimeVue's colour tokens. Only an emoji from the picker can be chosen.
- **Text tab:** text (up to 8 characters; 6 read best), font (Sans, Serif, Mono, Condensed — system stacks in `WORD_FONTS`), bold (on for a new word), text colour and background colour (`ColourPicker`), previewed at every badge size. A new word starts on the owner's colour (the tag's effective colour, inherited included) with `iconColourOn` text. Each colour has a Reset, shown only while it differs: background → the owner's colour, text → readable on the background; while the text has the readable colour it follows a change of background.
- **The word's SVG** (`src/icons/wordSvg.ts`) is a pure function of its settings, so two devices making the same word write the same text and therefore one image row: no canvas measuring. The text is sized from built-in advance widths (`fontMetrics.ts`: Helvetica/Arial, Times, Arial Narrow, regular and bold, measured once; 600 for mono; estimates outside ASCII) so its box fits inside a circle of radius 108 (font size at most 140), and `textLength` with `lengthAdjust="spacingAndGlyphs"` pins the drawn width to that estimate — a device whose look-alike font is wider squeezes rather than overflows. All numbers are whole pixels; colours are normalised `#rrggbb`; the text is escaped. The SVG is written exactly as the cleaner serialises it, so cleaning it changes nothing (tested in jsdom and checked in Chromium). `source` is `wordSource(settings)`, and `ImagesRepository.put` stores any `source` as JSON with sorted keys (`jsonObjectToCanonicalNullableColumn`).
- **Image tab:** a file (`accept="image/*,.svg"`) → `prepareUpload` (`src/icons/upload.ts`), with the cleaner and the encoder passed in.
  - **SVG** (by type or `.svg` name): over 1 MB refused unread; cleaned by `src/icons/svgClean.ts` — DOMPurify's SVG profile plus `<use>`, no `script` / `foreignObject`; hooks drop any `href` / `xlink:href` that is not `#…` or an embedded raster `data:image/…` (`<use>`: `#…` only), replace a `url(…)` leaving the picture with `none` in attributes, `style` and `<style>`, drop `@import`, and drop CSS holding a backslash (an escape could spell `url(`). The root must be a single `<svg>` ("This file is not an SVG image."); comments and namespace declarations are removed and `XMLSerializer` writes well-formed XML. A missing viewBox comes from a plain width/height; with neither, the file is refused. Width/height stored from the viewBox. Over 100 KB after cleaning: a warning ("Every device syncs this picture…") and "Use it anyway"; over 1 MB: refused.
  - **Raster:** `src/icons/rasterEncode.ts` decodes with `createImageBitmap` (a GIF's first frame), draws it on a transparent square canvas fitted within 256 × 256 (`rasterLayout`, never enlarged), and encodes `image/webp` at 0.9. Safari answers with PNG, so the blob's type decides: `image/png` is now allowed by the `images.media_type` CHECK, the types and `imageDataUrl` (`src/icons/dataUrl.ts`). The 100 KB / 1 MB rule applies to the encoded size too. Not decodable → "This file is not an image this browser can read."; another non-image type → "This file is not an image."
  - DOMPurify (`svgClean` chunk, 32 KB / 12 KB gzip) loads when the Text or Image tab opens.
- **Not done / limits:** a true network-offline run of the Emoji tab passed once on a fresh preview origin, but Playwright's offline emulation later failed fetches the service worker should have answered, so offline is shown by the precache list (`dist/sw.js`) more than by a browser run. An upload's cleaned text depends on the browser's serialiser, so the same SVG uploaded in two different browsers could make two rows (words do not have this problem).
