<script setup lang="ts">
import { computed, ref } from 'vue'
import Menu from 'primevue/menu'
import Button from 'primevue/button'
import { useLayoutStore } from '@/stores/layout'

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
    route: item.route,
    // Collapsed items show only an icon; this keeps them named for screen readers.
    ariaLabel: item.label,
  })),
)

const toggleIcon = computed(() => {
  const pos = layoutStore.navPosition
  if (pos === 'right') {
    return isExpanded.value ? 'pi pi-chevron-right' : 'pi pi-chevron-left'
  }
  return isExpanded.value ? 'pi pi-chevron-left' : 'pi pi-chevron-right'
})

const toggleLabel = computed(() => {
  if (!isExpanded.value) return undefined
  return isExpanded.value && layoutStore.isTemporarilyToggled ? 'Unpin' : 'Pin'
})

const toggleAriaLabel = computed(() =>
  isExpanded.value ? `${toggleLabel.value} sidebar` : 'Expand sidebar',
)

function toggleSidebar() {
  layoutStore.isTemporarilyToggled = !layoutStore.isTemporarilyToggled
}
</script>

<template>
  <!-- h-dvh, not h-screen: 100vh on mobile includes the area behind the browser's address bar. -->
  <nav
    aria-label="Main"
    class="h-dvh flex flex-col transition-all duration-200 overflow-hidden"
    :class="[
      isExpanded ? 'w-56' : 'w-16',
      'shrink-0',
      layoutStore.navPosition === 'right'
        ? 'border-l border-gray-200 dark:border-gray-700'
        : 'border-r border-gray-200 dark:border-gray-700',
    ]"
    @mouseenter="isHovered = true"
    @mouseleave="isHovered = false"
  >
    <div class="p-3 font-bold text-center">
      {{ isExpanded ? 'MoneyTracker' : 'MT' }}
    </div>
    <Menu :model="menuItems" class="flex-1 border-0 w-full min-w-0 overflow-hidden">
      <!-- Render items as real links (href, middle-click, active state)
           instead of click handlers calling router.push. -->
      <template #item="{ item, props }">
        <RouterLink v-slot="{ href, navigate, isExactActive }" :to="item.route" custom>
          <a
            :href="href"
            v-bind="props.action"
            :aria-label="item.label ? undefined : item.ariaLabel"
            :aria-current="isExactActive ? 'page' : undefined"
            :class="{ 'font-semibold': isExactActive }"
            @click="navigate"
          >
            <span :class="item.icon" />
            <span v-if="item.label" class="ml-2">{{ item.label }}</span>
          </a>
        </RouterLink>
      </template>
    </Menu>
    <div class="flex flex-col gap-1 p-2">
      <Button
        as="router-link"
        to="/settings"
        icon="pi pi-cog"
        :label="isExpanded ? 'Settings' : undefined"
        :aria-label="isExpanded ? undefined : 'Settings'"
        severity="secondary"
        text
      />
      <Button
        :icon="toggleIcon"
        :label="toggleLabel"
        :aria-label="toggleAriaLabel"
        severity="secondary"
        text
        size="small"
        @click="toggleSidebar"
      />
    </div>
  </nav>
</template>
