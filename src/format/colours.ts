/** Preset swatches (Tailwind 500 shades) for accounts, groups and tags; any other colour can be picked too. */
export const COLOUR_PRESETS = [
  '#3b82f6',
  '#22c55e',
  '#f59e0b',
  '#ef4444',
  '#a855f7',
  '#14b8a6',
  '#ec4899',
  '#f97316',
  '#6366f1',
  '#64748b',
] as const

/** Names of the preset swatches, for their accessible labels. */
export const COLOUR_PRESET_NAMES: Record<(typeof COLOUR_PRESETS)[number], string> = {
  '#3b82f6': 'blue',
  '#22c55e': 'green',
  '#f59e0b': 'amber',
  '#ef4444': 'red',
  '#a855f7': 'purple',
  '#14b8a6': 'teal',
  '#ec4899': 'pink',
  '#f97316': 'orange',
  '#6366f1': 'indigo',
  '#64748b': 'slate',
}
