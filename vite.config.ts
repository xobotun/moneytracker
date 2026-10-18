import { copyFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * GitHub Pages answers unknown paths with 404.html. A copy of index.html there
 * lets the SPA router handle deep links (e.g. reloading /moneytracker/settings)
 * instead of showing GitHub's "not found" page.
 */
function spaFallback404(): Plugin {
  let outDir = 'dist'
  return {
    name: 'spa-fallback-404',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      copyFileSync(resolve(outDir, 'index.html'), resolve(outDir, '404.html'))
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: process.env.BASE_URL || '/',
  plugins: [
    vue(),
    vueDevTools(),
    tailwindcss(),
    spaFallback404(),
    VitePWA({
      registerType: 'prompt',
      manifest: {
        name: 'Money Tracker',
        short_name: 'MoneyTracker',
        description: 'Personal money tracker',
        theme_color: '#ffffff',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    },
  },
  optimizeDeps: {
    exclude: ['wa-sqlite'],
  },
})
