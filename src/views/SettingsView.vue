<script setup lang="ts">
import { ref, computed } from 'vue'
import Card from 'primevue/card'
import Select from 'primevue/select'
import ToggleSwitch from 'primevue/toggleswitch'
import Divider from 'primevue/divider'
import { usePreset } from '@primeuix/themes'
import Aura from '@primevue/themes/aura'
import Material from '@primevue/themes/material'
import Lara from '@primevue/themes/lara'
import Nora from '@primevue/themes/nora'
import { useLayoutStore, type NavPosition, type CollapseMode, type ThemePreset } from '@/stores/layout'

const layoutStore = useLayoutStore()

const presets = [
  { name: 'Aura' as ThemePreset, value: Aura },
  { name: 'Material' as ThemePreset, value: Material },
  { name: 'Lara' as ThemePreset, value: Lara },
  { name: 'Nora' as ThemePreset, value: Nora },
]

const selectedPreset = ref(
  presets.find((p) => p.name === layoutStore.themePreset) ?? presets[0]
)

async function onPresetChange() {
  if (selectedPreset.value) {
    usePreset(selectedPreset.value.value)
    await layoutStore.setThemePreset(selectedPreset.value.name)
  }
}

async function onDarkModeChange(value: boolean) {
  await layoutStore.setDarkMode(value)
}

const navPositionOptions = [
  { name: 'Auto (responsive)', value: 'auto' as NavPosition },
  { name: 'Top', value: 'top' as NavPosition },
  { name: 'Bottom', value: 'bottom' as NavPosition },
  { name: 'Left', value: 'left' as NavPosition },
  { name: 'Right', value: 'right' as NavPosition },
]

const collapseModeOptions = [
  { name: 'Always collapsed', value: 'always-collapsed' as CollapseMode },
  { name: 'Opens on hover', value: 'opens-on-hover' as CollapseMode },
  { name: 'Always expanded', value: 'always-expanded' as CollapseMode },
]

const selectedNavPosition = ref(
  navPositionOptions.find((o) => o.value === layoutStore.navPosition) ?? navPositionOptions[0]
)
const selectedCollapseMode = ref(
  collapseModeOptions.find((o) => o.value === layoutStore.collapseMode) ?? collapseModeOptions[1]
)

async function onNavPositionChange() {
  if (selectedNavPosition.value) {
    await layoutStore.setNavPosition(selectedNavPosition.value.value)
  }
}

async function onCollapseModeChange() {
  if (selectedCollapseMode.value) {
    await layoutStore.setCollapseMode(selectedCollapseMode.value.value)
  }
}

// Show collapse mode only when effective position is vertical
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
            v-model="selectedPreset"
            :options="presets"
            optionLabel="name"
            @change="onPresetChange"
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
            v-model="selectedNavPosition"
            :options="navPositionOptions"
            optionLabel="name"
            @change="onNavPositionChange"
          />
        </div>
        <div v-if="showCollapseMode" class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
          <label for="collapse-mode">Sidebar mode</label>
          <Select
            id="collapse-mode"
            v-model="selectedCollapseMode"
            :options="collapseModeOptions"
            optionLabel="name"
            @change="onCollapseModeChange"
          />
        </div>
      </div>
    </template>
  </Card>
</template>
