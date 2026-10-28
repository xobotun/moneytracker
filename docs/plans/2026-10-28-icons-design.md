# Icons: Design

**Status:** Decided with Pavel, 2026-10-28. Not built yet.
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
- **SVG stays vector**, made safe three ways: on upload it is cleaned (DOMPurify with the SVG profile: no scripts, event handlers, `foreignObject` or external references); it is only ever drawn as an image (`<img>` / data URL), where browsers run no scripts and load nothing; and an upload over about 100 KB is refused.
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
  - **Image** — choose a file (raster or SVG); a preview of the result; an error for an SVG that is too big or not an SVG.

---

## 6. Build order

1. The data model (icon JSON in tags, accounts and groups; the `images` table, synced), the icon packs registry, the badge, and every place that draws an icon switched to it.
2. The picker dialog with its four tabs, image import (downscaling, SVG cleaning), the emoji library.
