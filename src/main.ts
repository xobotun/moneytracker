import './assets/main.css'
import 'primeicons/primeicons.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import PrimeVue from 'primevue/config'
import { usePreset } from '@primeuix/themes'
import Aura from '@primevue/themes/aura'

import App from './App.vue'
import router from './router'
import { initDatabase } from './db/init'
import { useLayoutStore } from './stores/layout'
import { themePresets } from './stores/layout-types'

async function bootstrap(): Promise<void> {
  await initDatabase()

  const app = createApp(App)
  const pinia = createPinia()
  app.use(pinia)
  app.use(router)
  app.use(PrimeVue, {
    theme: {
      preset: Aura,
      options: {
        darkModeSelector: '.dark',
      },
    },
  })

  const layoutStore = useLayoutStore()
  await layoutStore.hydrate()

  // Apply persisted theme settings
  if (layoutStore.themePreset !== 'Aura') {
    usePreset(themePresets[layoutStore.themePreset])
  }
  document.documentElement.classList.toggle('dark', layoutStore.isDark)

  app.mount('#app')
}

bootstrap().catch((err) => {
  console.error('Failed to initialize app:', err)
  const el = document.getElementById('app')
  if (el) {
    el.textContent = `Failed to load application: ${err}. Please refresh or try a different browser.`
  }
})
