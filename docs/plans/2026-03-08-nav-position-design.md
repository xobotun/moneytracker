# Nav Position Design

Date: 2026-03-08
Status: **COMPLETED** — All decisions implemented as specified.

## Goal

Make the app's navigation bar positionable (top, bottom, left, right) with responsive defaults and user override in Settings. Vertical positions (left/right) get a collapsible sidebar.

## Layout Behavior

| Position | Component | Collapsible? | Layout |
|----------|-----------|-------------|--------|
| Top | PrimeVue Menubar | No | Fixed top, content below |
| Bottom | PrimeVue Menubar | No | Fixed bottom, content above |
| Left | Custom sidebar (PrimeVue Menu) | Yes | Fixed left, content beside |
| Right | Custom sidebar (PrimeVue Menu) | Yes | Fixed right, content beside |

## Sidebar Collapse Modes (vertical only)

| Mode | Behavior |
|------|----------|
| Always collapsed | Icons only, no expansion |
| Opens on hover | Icons by default, expands with labels on mouse hover |
| Always expanded | Full sidebar with icons + labels |

A toggle button at the bottom of the sidebar temporarily overrides the current mode (e.g., pin open when in "opens on hover" mode). This temporary state resets on navigation or page reload.

## Defaults

- Desktop (≥768px): Left sidebar, "Opens on hover" mode.
- Mobile (<768px): Top bar.
- User can override in Settings. "Auto" option restores responsive default.

## Components

- **`AppLayout.vue`** — reads position from store, renders the appropriate nav variant + content area with correct CSS layout (flex row for sidebar, flex column for top/bottom).
- **`AppMenubar.vue`** — horizontal nav for top/bottom positions. Wraps PrimeVue Menubar. Contains logo, nav items, cog button.
- **`AppSidebar.vue`** — vertical nav for left/right positions. Uses PrimeVue Menu for nav items. Handles collapse/expand logic, hover detection, toggle button at bottom.
- **`useLayoutStore`** (Pinia) — holds `navPosition` (top/bottom/left/right/auto), `collapseMode` (always-collapsed/opens-on-hover/always-expanded), `isTemporarilyToggled` (boolean). No persistence for now (in-memory only, resets on refresh).

## Settings UI

Under the existing "Visual" divider in SettingsView, add:

- **Nav position** — Select dropdown with options: Auto (responsive), Top, Bottom, Left, Right.
- **Sidebar collapse mode** — Select dropdown with options: Always collapsed, Opens on hover, Always expanded. Only visible/enabled when the effective nav position is Left or Right.

## Nav Items

Both AppMenubar and AppSidebar share the same nav items data. Each item has: `label`, `icon` (PrimeIcons class), `route`. The items array is defined in the layout store or a shared composable so both components stay in sync.

Nav items:
- Home (pi-home, /)
- Page Two (pi-file, /page-two)
- About (pi-info-circle, /about)
- Settings — in Menubar: cog button in #end slot. In Sidebar: cog button at the bottom, separated from main items.

## Persistence

No persistence for now. All settings are in-memory Pinia state, reset to defaults on page reload. Persistence (localStorage or SQLite) will be added later.
