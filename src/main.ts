import './assets/main.css'
import 'primeicons/primeicons.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import PrimeVue from 'primevue/config'
import Aura from '@primevue/themes/aura'

import App from './App.vue'
import router from './router'
import { initDatabase } from './db/init'
import { useLayoutStore } from './stores/layout'

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

  app.mount('#app')
}

bootstrap()
