<script setup lang="ts">
import Menubar from 'primevue/menubar'
import Button from 'primevue/button'
import { useRouter } from 'vue-router'
import { useLayoutStore } from '@/stores/layout'
import { computed } from 'vue'

const router = useRouter()
const layoutStore = useLayoutStore()

const menuItems = computed(() =>
  layoutStore.navItems.map((item) => ({
    label: item.label,
    icon: item.icon,
    command: () => router.push(item.route),
  }))
)
</script>

<template>
  <Menubar :model="menuItems">
    <template #start>
      <span class="font-bold">MoneyTracker</span>
    </template>
    <template #end>
      <Button
        icon="pi pi-cog"
        severity="secondary"
        text
        rounded
        @click="router.push('/settings')"
      />
    </template>
  </Menubar>
</template>
