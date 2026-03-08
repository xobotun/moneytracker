<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useLayoutStore } from '@/stores/layout'
import AppMenubar from './AppMenubar.vue'
import AppSidebar from './AppSidebar.vue'

const layoutStore = useLayoutStore()
const windowWidth = ref(window.innerWidth)

function onResize() {
  windowWidth.value = window.innerWidth
}

onMounted(() => window.addEventListener('resize', onResize))
onUnmounted(() => window.removeEventListener('resize', onResize))

const position = computed(() => layoutStore.effectivePosition(windowWidth.value))
const isHorizontal = computed(() => position.value === 'top' || position.value === 'bottom')
const isTop = computed(() => position.value === 'top')
const isLeft = computed(() => position.value === 'left')
</script>

<template>
  <div class="min-h-screen" :class="isHorizontal ? 'flex flex-col' : 'flex flex-row'">
    <!-- Top menubar -->
    <AppMenubar v-if="isHorizontal && isTop" />

    <!-- Left sidebar -->
    <AppSidebar v-if="!isHorizontal && isLeft" />

    <!-- Content -->
    <main class="flex-1">
      <RouterView />
    </main>

    <!-- Right sidebar -->
    <AppSidebar v-if="!isHorizontal && !isLeft" />

    <!-- Bottom menubar -->
    <AppMenubar v-if="isHorizontal && !isTop" />
  </div>
</template>
