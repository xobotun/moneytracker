<script setup lang="ts">
import { ref, computed } from 'vue'
import Card from 'primevue/card'
import Select from 'primevue/select'
import ToggleSwitch from 'primevue/toggleswitch'
import Divider from 'primevue/divider'
import { usePreset } from '@primeuix/themes'
import type { Preset } from '@primeuix/themes/types'
import Aura from '@primevue/themes/aura'
import Material from '@primevue/themes/material'
import Lara from '@primevue/themes/lara'
import Nora from '@primevue/themes/nora'
import { useLayoutStore, type NavPosition, type CollapseMode, type ThemePreset } from '@/stores/layout'

const layoutStore = useLayoutStore()

// --- Theme preset ---
const themePresetSetting = {
  options: [
    { name: 'Aura' as ThemePreset, preset: Aura as Preset },
    { name: 'Material' as ThemePreset, preset: Material as Preset },
    { name: 'Lara' as ThemePreset, preset: Lara as Preset },
    { name: 'Nora' as ThemePreset, preset: Nora as Preset },
  ],
  selected: ref(null as { name: ThemePreset; preset: Preset } | null),
  async onChange() {
    if (themePresetSetting.selected.value) {
      usePreset(themePresetSetting.selected.value.preset)
      await layoutStore.setThemePreset(themePresetSetting.selected.value.name)
    }
  },
}
themePresetSetting.selected.value =
  themePresetSetting.options.find((p) => p.name === layoutStore.themePreset) ?? themePresetSetting.options[0]!

// --- Dark mode ---
async function onDarkModeChange(value: boolean) {
  await layoutStore.setDarkMode(value)
}

// --- Nav position ---
const navPositionSetting = {
  options: [
    { name: 'Auto (responsive)', value: 'auto' as NavPosition },
    { name: 'Top', value: 'top' as NavPosition },
    { name: 'Bottom', value: 'bottom' as NavPosition },
    { name: 'Left', value: 'left' as NavPosition },
    { name: 'Right', value: 'right' as NavPosition },
  ],
  selected: ref(null as { name: string; value: NavPosition } | null),
  async onChange() {
    if (navPositionSetting.selected.value) {
      await layoutStore.setNavPosition(navPositionSetting.selected.value.value)
    }
  },
}
navPositionSetting.selected.value =
  navPositionSetting.options.find((o) => o.value === layoutStore.navPosition) ?? navPositionSetting.options[0]!

// --- Collapse mode ---
const collapseModeSetting = {
  options: [
    { name: 'Always collapsed', value: 'always-collapsed' as CollapseMode },
    { name: 'Opens on hover', value: 'opens-on-hover' as CollapseMode },
    { name: 'Always expanded', value: 'always-expanded' as CollapseMode },
  ],
  selected: ref(null as { name: string; value: CollapseMode } | null),
  async onChange() {
    if (collapseModeSetting.selected.value) {
      await layoutStore.setCollapseMode(collapseModeSetting.selected.value.value)
    }
  },
}
collapseModeSetting.selected.value =
  collapseModeSetting.options.find((o) => o.value === layoutStore.collapseMode) ?? collapseModeSetting.options[1]!

const showCollapseMode = computed(() => {
  const pos = layoutStore.navPosition
  return pos === 'left' || pos === 'right' || pos === 'auto'
})
</script>

<template>
  <Card>
    <template #title>Settings</template>
    <template #content>
      <Divider align="left" type="solid">
        <b>Visual</b>
      </Divider>
      <div class="flex flex-col gap-4">
        <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
          <label for="theme-preset">Theme preset</label>
          <Select
            id="theme-preset"
            v-model="themePresetSetting.selected.value"
            :options="themePresetSetting.options"
            optionLabel="name"
            @change="themePresetSetting.onChange"
          />
        </div>
        <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
          <label for="dark-mode">Dark mode</label>
          <ToggleSwitch
            id="dark-mode"
            v-model="layoutStore.isDark"
            @update:modelValue="onDarkModeChange"
          />
        </div>
        <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
          <label for="nav-position">Nav position</label>
          <Select
            id="nav-position"
            v-model="navPositionSetting.selected.value"
            :options="navPositionSetting.options"
            optionLabel="name"
            @change="navPositionSetting.onChange"
          />
        </div>
        <div v-if="showCollapseMode" class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
          <label for="collapse-mode">Sidebar mode</label>
          <Select
            id="collapse-mode"
            v-model="collapseModeSetting.selected.value"
            :options="collapseModeSetting.options"
            optionLabel="name"
            @change="collapseModeSetting.onChange"
          />
        </div>
      </div>
    </template>
  </Card>
</template>
