import type { Preset } from '@primeuix/themes/types'
import Aura from '@primevue/themes/aura'
import Material from '@primevue/themes/material'
import Lara from '@primevue/themes/lara'
import Nora from '@primevue/themes/nora'
import { settingsKey } from '@/db/SettingsKey'

// --- Domain types ---

export const NAV_POSITIONS = ['auto', 'top', 'bottom', 'left', 'right'] as const
export const COLLAPSE_MODES = ['always-collapsed', 'opens-on-hover', 'always-expanded'] as const

export type NavPosition = (typeof NAV_POSITIONS)[number]
export type CollapseMode = (typeof COLLAPSE_MODES)[number]
export type ThemePreset = 'Aura' | 'Material' | 'Lara' | 'Nora'

// --- Typed settings keys ---

export const LayoutKeys = {
  navPosition: settingsKey<NavPosition>('layout.navPosition'),
  collapseMode: settingsKey<CollapseMode>('layout.collapseMode'),
  isDark: settingsKey<boolean>('layout.isDark'),
  themePreset: settingsKey<ThemePreset>('layout.themePreset'),
}

// --- Theme presets map (used by bootstrap + settings UI) ---

export const themePresets: Record<ThemePreset, Preset> = {
  Aura: Aura as Preset,
  Material: Material as Preset,
  Lara: Lara as Preset,
  Nora: Nora as Preset,
}

// --- Validators for values read back from storage ---
// A stored value can be stale (e.g. a theme removed in a later build) or
// corrupt; hydration keeps the default instead of trusting it.

export function isNavPosition(value: unknown): value is NavPosition {
  return (NAV_POSITIONS as readonly unknown[]).includes(value)
}

export function isCollapseMode(value: unknown): value is CollapseMode {
  return (COLLAPSE_MODES as readonly unknown[]).includes(value)
}

export function isThemePreset(value: unknown): value is ThemePreset {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(themePresets, value)
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}
