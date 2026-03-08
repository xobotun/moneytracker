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
</script>

<template>
  <div>
    <Menubar :model="items">
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
    <main>
      <RouterView />
    </main>
  </div>
</template>
