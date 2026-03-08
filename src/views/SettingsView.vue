<script setup lang="ts">
import { ref } from 'vue'
import Card from 'primevue/card'
import Select from 'primevue/select'
import ToggleSwitch from 'primevue/toggleswitch'
import { usePreset } from '@primeuix/themes'
import Aura from '@primevue/themes/aura'
import Material from '@primevue/themes/material'
import Lara from '@primevue/themes/lara'
import Nora from '@primevue/themes/nora'

const presets = [
  { name: 'Aura', value: Aura },
  { name: 'Material', value: Material },
  { name: 'Lara', value: Lara },
  { name: 'Nora', value: Nora },
]

const selectedPreset = ref(presets[0])
const isDark = ref(document.documentElement.classList.contains('dark'))

function onPresetChange() {
  if (selectedPreset.value) {
    usePreset(selectedPreset.value.value)
  }
}

function onDarkModeChange() {
  document.documentElement.classList.toggle('dark', isDark.value)
}
</script>

<template>
  <Card>
    <template #title>Settings</template>
    <template #content>
      <div class="flex flex-col gap-4">
        <div class="flex items-center justify-between">
          <label for="theme-preset">Theme preset</label>
          <Select
            id="theme-preset"
            v-model="selectedPreset"
            :options="presets"
            optionLabel="name"
            @change="onPresetChange"
          />
        </div>
        <div class="flex items-center justify-between">
          <label for="dark-mode">Dark mode</label>
          <ToggleSwitch
            id="dark-mode"
            v-model="isDark"
            @update:modelValue="onDarkModeChange"
          />
        </div>
      </div>
    </template>
  </Card>
</template>
