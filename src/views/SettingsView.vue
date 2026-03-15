<script setup lang="ts">
import Card from 'primevue/card'
import Select from 'primevue/select'
import ToggleSwitch from 'primevue/toggleswitch'
import Divider from 'primevue/divider'
import { useSettingsOptions } from './useSettingsOptions'

const {
  layoutStore,
  themePresetOptions,
  selectedPreset,
  onPresetChange,
  onDarkModeChange,
  navPositionOptions,
  selectedNavPosition,
  onNavPositionChange,
  collapseModeOptions,
  selectedCollapseMode,
  onCollapseModeChange,
  showCollapseMode,
} = useSettingsOptions()
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
            :options="themePresetOptions"
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
