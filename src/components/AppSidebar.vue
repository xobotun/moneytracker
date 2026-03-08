<script setup lang="ts">
import { computed, ref } from 'vue'
import Menu from 'primevue/menu'
import Button from 'primevue/button'
import { useRouter } from 'vue-router'
import { useLayoutStore } from '@/stores/layout'

const router = useRouter()
const layoutStore = useLayoutStore()
const isHovered = ref(false)

const isExpanded = computed(() => {
  if (layoutStore.collapseMode === 'always-expanded') {
    return !layoutStore.isTemporarilyToggled
  }
  if (layoutStore.collapseMode === 'always-collapsed') {
    return layoutStore.isTemporarilyToggled
  }
  // opens-on-hover
  return isHovered.value || layoutStore.isTemporarilyToggled
})

const menuItems = computed(() =>
  layoutStore.navItems.map((item) => ({
    label: isExpanded.value ? item.label : undefined,
    icon: item.icon,
    command: () => router.push(item.route),
  }))
)

const toggleIcon = computed(() => {
  const pos = layoutStore.navPosition
  if (pos === 'right') {
    return isExpanded.value ? 'pi pi-chevron-right' : 'pi pi-chevron-left'
  }
  return isExpanded.value ? 'pi pi-chevron-left' : 'pi pi-chevron-right'
})

function toggleSidebar() {
  layoutStore.isTemporarilyToggled = !layoutStore.isTemporarilyToggled
}
</script>

<template>
  <nav
    class="h-screen flex flex-col transition-all duration-200 overflow-hidden"
    :class="[
      isExpanded ? 'w-56' : 'w-16',
      layoutStore.navPosition === 'right' ? 'border-l border-gray-200' : 'border-r border-gray-200'
    ]"
    @mouseenter="isHovered = true"
    @mouseleave="isHovered = false"
  >
    <div class="p-3 font-bold text-center">
      {{ isExpanded ? 'MoneyTracker' : 'MT' }}
    </div>
    <Menu :model="menuItems" class="flex-1 border-0 w-full min-w-0 overflow-hidden" />
    <div class="flex flex-col gap-1 p-2">
      <Button
        icon="pi pi-cog"
        :label="isExpanded ? 'Settings' : undefined"
        severity="secondary"
        text
        @click="router.push('/settings')"
      />
      <Button
        :icon="toggleIcon"
        severity="secondary"
        text
        size="small"
        @click="toggleSidebar"
      />
    </div>
  </nav>
</template>
