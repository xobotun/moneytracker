import type { Preset } from '@primeuix/themes/types'
import Aura from '@primevue/themes/aura'
import Material from '@primevue/themes/material'
import Lara from '@primevue/themes/lara'
import Nora from '@primevue/themes/nora'
import { settingsKey } from '@/db/SettingsKey'

// --- Domain types ---

export type NavPosition = 'auto' | 'top' | 'bottom' | 'left' | 'right'
export type CollapseMode = 'always-collapsed' | 'opens-on-hover' | 'always-expanded'
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
