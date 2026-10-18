<script setup lang="ts">
import Menubar from 'primevue/menubar'
import Button from 'primevue/button'
import { useLayoutStore } from '@/stores/layout'
import { computed } from 'vue'

const layoutStore = useLayoutStore()

const menuItems = computed(() =>
  layoutStore.navItems.map((item) => ({
    label: item.label,
    icon: item.icon,
    route: item.route,
  })),
)
</script>

<template>
  <Menubar :model="menuItems" aria-label="Main">
    <template #start>
      <span class="font-bold">MoneyTracker</span>
    </template>
    <!-- Render items as real links (href, middle-click, active state)
         instead of click handlers calling router.push. -->
    <template #item="{ item, props }">
      <RouterLink v-slot="{ href, navigate, isExactActive }" :to="item.route" custom>
        <a
          :href="href"
          v-bind="props.action"
          :aria-current="isExactActive ? 'page' : undefined"
          :class="{ 'font-semibold': isExactActive }"
          @click="navigate"
        >
          <span :class="item.icon" />
          <span class="ml-2">{{ item.label }}</span>
        </a>
      </RouterLink>
    </template>
    <template #end>
      <Button
        as="router-link"
        to="/settings"
        icon="pi pi-cog"
        aria-label="Settings"
        severity="secondary"
        text
        rounded
      />
    </template>
  </Menubar>
</template>
