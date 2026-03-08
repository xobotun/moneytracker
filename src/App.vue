<script setup lang="ts">
import { ref } from 'vue'
import Menubar from 'primevue/menubar'
import Button from 'primevue/button'
import { useRouter } from 'vue-router'

const router = useRouter()

const items = ref([
  { label: 'Home', command: () => router.push('/') },
  { label: 'Page Two', command: () => router.push('/page-two') },
  { label: 'About', command: () => router.push('/about') },
])

const isDark = ref(document.documentElement.classList.contains('dark'))

function toggleTheme() {
  isDark.value = !isDark.value
  document.documentElement.classList.toggle('dark', isDark.value)
}
</script>

<template>
  <div>
    <Menubar :model="items">
      <template #start>
        <span class="font-bold">MoneyTracker</span>
      </template>
      <template #end>
        <Button
          :icon="isDark ? 'pi pi-sun' : 'pi pi-moon'"
          severity="secondary"
          text
          rounded
          @click="toggleTheme"
        />
      </template>
    </Menubar>
    <main>
      <RouterView />
    </main>
  </div>
</template>
