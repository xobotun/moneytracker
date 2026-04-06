# Nav Position Implementation Plan

Status: **COMPLETED** — All tasks implemented as specified.

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the navigation bar positionable (top/bottom/left/right/auto) with a collapsible sidebar for vertical positions, responsive defaults, and user-configurable settings.

**Architecture:** A Pinia store (`useLayoutStore`) holds nav position and collapse preferences. `App.vue` uses a new `AppLayout` component that conditionally renders either `AppMenubar` (horizontal, for top/bottom) or `AppSidebar` (vertical, for left/right). Both share nav item data from the store. Settings page gets new controls.

**Tech Stack:** Vue 3 Composition API, Pinia, PrimeVue (Menubar, Menu, Select, ToggleSwitch, Button), Tailwind CSS, Vitest

---

### Task 1: Create the layout Pinia store

**Files:**
- Create: `src/stores/layout.ts`
- Test: `src/stores/__tests__/layout.spec.ts`

**Step 1: Write the test**

```ts
// src/stores/__tests__/layout.spec.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useLayoutStore } from '../layout'

describe('useLayoutStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('has correct defaults', () => {
    const store = useLayoutStore()
    expect(store.navPosition).toBe('auto')
    expect(store.collapseMode).toBe('opens-on-hover')
    expect(store.isTemporarilyToggled).toBe(false)
  })

  it('resolves effective position for desktop', () => {
    const store = useLayoutStore()
    store.navPosition = 'auto'
    expect(store.effectivePosition(1024)).toBe('left')
  })

  it('resolves effective position for mobile', () => {
    const store = useLayoutStore()
    store.navPosition = 'auto'
    expect(store.effectivePosition(500)).toBe('top')
  })

  it('uses explicit position when not auto', () => {
    const store = useLayoutStore()
    store.navPosition = 'bottom'
    expect(store.effectivePosition(1024)).toBe('bottom')
    expect(store.effectivePosition(500)).toBe('bottom')
  })

  it('computes isVertical correctly', () => {
    const store = useLayoutStore()
    store.navPosition = 'left'
    expect(store.isVertical).toBe(true)
    store.navPosition = 'right'
    expect(store.isVertical).toBe(true)
    store.navPosition = 'top'
    expect(store.isVertical).toBe(false)
  })

  it('provides nav items', () => {
    const store = useLayoutStore()
    expect(store.navItems.length).toBeGreaterThan(0)
    expect(store.navItems[0]).toHaveProperty('label')
    expect(store.navItems[0]).toHaveProperty('icon')
    expect(store.navItems[0]).toHaveProperty('route')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm run test:unit -- --reporter=verbose`
Expected: FAIL — module `../layout` not found

**Step 3: Implement the store**

```ts
// src/stores/layout.ts
import { ref, computed } from 'vue'
import { defineStore } from 'pinia'

export type NavPosition = 'auto' | 'top' | 'bottom' | 'left' | 'right'
export type CollapseMode = 'always-collapsed' | 'opens-on-hover' | 'always-expanded'

const MOBILE_BREAKPOINT = 768

export const useLayoutStore = defineStore('layout', () => {
  const navPosition = ref<NavPosition>('auto')
  const collapseMode = ref<CollapseMode>('opens-on-hover')
  const isTemporarilyToggled = ref(false)

  const navItems = ref([
    { label: 'Home', icon: 'pi pi-home', route: '/' },
    { label: 'Page Two', icon: 'pi pi-file', route: '/page-two' },
    { label: 'About', icon: 'pi pi-info-circle', route: '/about' },
  ])

  function effectivePosition(windowWidth: number): Exclude<NavPosition, 'auto'> {
    if (navPosition.value !== 'auto') {
      return navPosition.value
    }
    return windowWidth >= MOBILE_BREAKPOINT ? 'left' : 'top'
  }

  const isVertical = computed(() => {
    return navPosition.value === 'left' || navPosition.value === 'right'
  })

  return {
    navPosition,
    collapseMode,
    isTemporarilyToggled,
    navItems,
    effectivePosition,
    isVertical,
  }
})
```

**Step 4: Run test to verify it passes**

Run: `npm run test:unit -- --reporter=verbose`
Expected: All 6 tests PASS

**Step 5: Commit**

```bash
git add src/stores/layout.ts src/stores/__tests__/layout.spec.ts
git commit -m "feat: add layout Pinia store with nav position and collapse settings"
```

---

### Task 2: Create AppMenubar component

**Files:**
- Create: `src/components/AppMenubar.vue`
- Test: `src/components/__tests__/AppMenubar.spec.ts`

**Step 1: Write the test**

```ts
// src/components/__tests__/AppMenubar.spec.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import PrimeVue from 'primevue/config'
import Aura from '@primevue/themes/aura'
import AppMenubar from '../AppMenubar.vue'

describe('AppMenubar', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('renders the app title', () => {
    const wrapper = mount(AppMenubar, {
      global: {
        plugins: [
          createPinia(),
          [PrimeVue, { theme: { preset: Aura } }],
        ],
        stubs: {
          Menubar: {
            template: '<div><slot name="start" /><slot name="end" /></div>',
            props: ['model'],
          },
          Button: {
            template: '<button><slot /></button>',
            props: ['icon', 'severity', 'text', 'rounded'],
          },
        },
      },
    })
    expect(wrapper.text()).toContain('MoneyTracker')
  })
})
```

Note: We stub Menubar because it calls `window.matchMedia` which jsdom doesn't support.

**Step 2: Run test to verify it fails**

Run: `npm run test:unit -- --reporter=verbose`
Expected: FAIL — component not found

**Step 3: Implement the component**

```vue
<!-- src/components/AppMenubar.vue -->
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
```

**Step 4: Run test to verify it passes**

Run: `npm run test:unit -- --reporter=verbose`
Expected: PASS

**Step 5: Commit**

```bash
git add src/components/AppMenubar.vue src/components/__tests__/AppMenubar.spec.ts
git commit -m "feat: extract AppMenubar component from App.vue"
```

---

### Task 3: Create AppSidebar component

**Files:**
- Create: `src/components/AppSidebar.vue`
- Test: `src/components/__tests__/AppSidebar.spec.ts`

**Step 1: Write the test**

```ts
// src/components/__tests__/AppSidebar.spec.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import PrimeVue from 'primevue/config'
import Aura from '@primevue/themes/aura'
import AppSidebar from '../AppSidebar.vue'
import { useLayoutStore } from '@/stores/layout'

describe('AppSidebar', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  const mountOptions = {
    global: {
      plugins: [
        createPinia(),
        [PrimeVue, { theme: { preset: Aura } }],
      ],
      stubs: {
        Menu: {
          template: '<div class="mock-menu"><slot /></div>',
          props: ['model'],
        },
        Button: {
          template: '<button class="mock-button" @click="$emit(\'click\')"><slot /></button>',
          props: ['icon', 'severity', 'text', 'rounded', 'size'],
        },
      },
    },
  }

  it('renders the app title when expanded', () => {
    const store = useLayoutStore()
    store.collapseMode = 'always-expanded'
    const wrapper = mount(AppSidebar, mountOptions)
    expect(wrapper.text()).toContain('MoneyTracker')
  })

  it('renders short title when collapsed', () => {
    const store = useLayoutStore()
    store.collapseMode = 'always-collapsed'
    const wrapper = mount(AppSidebar, mountOptions)
    expect(wrapper.text()).toContain('MT')
    expect(wrapper.text()).not.toContain('MoneyTracker')
  })

  it('has a toggle button', () => {
    const wrapper = mount(AppSidebar, mountOptions)
    expect(wrapper.find('.mock-button').exists()).toBe(true)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm run test:unit -- --reporter=verbose`
Expected: FAIL — component not found

**Step 3: Implement the component**

```vue
<!-- src/components/AppSidebar.vue -->
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

const toggleIcon = computed(() =>
  isExpanded.value ? 'pi pi-chevron-left' : 'pi pi-chevron-right'
)

function toggleSidebar() {
  layoutStore.isTemporarilyToggled = !layoutStore.isTemporarilyToggled
}
</script>

<template>
  <nav
    class="h-screen flex flex-col border-r border-gray-200 transition-all duration-200"
    :class="isExpanded ? 'w-56' : 'w-16'"
    @mouseenter="isHovered = true"
    @mouseleave="isHovered = false"
  >
    <div class="p-3 font-bold text-center">
      {{ isExpanded ? 'MoneyTracker' : 'MT' }}
    </div>
    <Menu :model="menuItems" class="flex-1 border-0" />
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
```

Note: When `navPosition` is `'right'`, the chevron icons should flip. This is handled in Task 5 when we wire up AppLayout.

**Step 4: Run test to verify it passes**

Run: `npm run test:unit -- --reporter=verbose`
Expected: All 3 tests PASS

**Step 5: Commit**

```bash
git add src/components/AppSidebar.vue src/components/__tests__/AppSidebar.spec.ts
git commit -m "feat: add AppSidebar component with collapse modes"
```

---

### Task 4: Create AppLayout component

**Files:**
- Create: `src/components/AppLayout.vue`
- Test: `src/components/__tests__/AppLayout.spec.ts`

**Step 1: Write the test**

```ts
// src/components/__tests__/AppLayout.spec.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import PrimeVue from 'primevue/config'
import Aura from '@primevue/themes/aura'
import AppLayout from '../AppLayout.vue'
import { useLayoutStore } from '@/stores/layout'

describe('AppLayout', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  const mountOptions = {
    global: {
      plugins: [
        createPinia(),
        [PrimeVue, { theme: { preset: Aura } }],
      ],
      stubs: {
        AppMenubar: { template: '<div class="stub-menubar" />' },
        AppSidebar: { template: '<div class="stub-sidebar" />' },
        RouterView: { template: '<div class="stub-router-view" />' },
      },
    },
  }

  it('renders menubar for top position', () => {
    const store = useLayoutStore()
    store.navPosition = 'top'
    const wrapper = mount(AppLayout, mountOptions)
    expect(wrapper.find('.stub-menubar').exists()).toBe(true)
    expect(wrapper.find('.stub-sidebar').exists()).toBe(false)
  })

  it('renders sidebar for left position', () => {
    const store = useLayoutStore()
    store.navPosition = 'left'
    const wrapper = mount(AppLayout, mountOptions)
    expect(wrapper.find('.stub-sidebar').exists()).toBe(true)
    expect(wrapper.find('.stub-menubar').exists()).toBe(false)
  })

  it('renders content area', () => {
    const store = useLayoutStore()
    store.navPosition = 'top'
    const wrapper = mount(AppLayout, mountOptions)
    expect(wrapper.find('.stub-router-view').exists()).toBe(true)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm run test:unit -- --reporter=verbose`
Expected: FAIL — component not found

**Step 3: Implement the component**

```vue
<!-- src/components/AppLayout.vue -->
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
```

**Step 4: Run test to verify it passes**

Run: `npm run test:unit -- --reporter=verbose`
Expected: All 3 tests PASS

**Step 5: Commit**

```bash
git add src/components/AppLayout.vue src/components/__tests__/AppLayout.spec.ts
git commit -m "feat: add AppLayout component with position-aware rendering"
```

---

### Task 5: Wire AppLayout into App.vue and fix sidebar direction

**Files:**
- Modify: `src/App.vue`
- Modify: `src/components/AppSidebar.vue` (flip chevrons for right position)
- Delete: `src/components/__tests__/HomeView.spec.ts` (replaced by new tests)

**Step 1: Update App.vue**

Replace the current Menubar/RouterView with AppLayout:

```vue
<!-- src/App.vue -->
<script setup lang="ts">
import AppLayout from '@/components/AppLayout.vue'
</script>

<template>
  <AppLayout />
</template>
```

**Step 2: Fix sidebar chevron direction for right position**

In `src/components/AppSidebar.vue`, update the `toggleIcon` computed to account for right-side positioning:

```ts
const toggleIcon = computed(() => {
  const pos = layoutStore.navPosition
  if (pos === 'right') {
    return isExpanded.value ? 'pi pi-chevron-right' : 'pi pi-chevron-left'
  }
  return isExpanded.value ? 'pi pi-chevron-left' : 'pi pi-chevron-right'
})
```

Also change `border-r` to be dynamic:

```vue
<nav
  class="h-screen flex flex-col transition-all duration-200"
  :class="[
    isExpanded ? 'w-56' : 'w-16',
    layoutStore.navPosition === 'right' ? 'border-l border-gray-200' : 'border-r border-gray-200'
  ]"
  @mouseenter="isHovered = true"
  @mouseleave="isHovered = false"
>
```

**Step 3: Verify build, lint, tests**

```bash
npm run build
npm run lint
npm run test:unit -- --reporter=verbose
```

Expected: All pass.

**Step 4: Commit**

```bash
git add src/App.vue src/components/AppSidebar.vue
git commit -m "feat: wire AppLayout into App.vue, fix sidebar for right position"
```

---

### Task 6: Add nav position and collapse mode to Settings

**Files:**
- Modify: `src/views/SettingsView.vue`
- Test: `src/components/__tests__/SettingsNav.spec.ts` (optional, can test via existing Settings tests)

**Step 1: Update SettingsView.vue**

Add two new controls under the "Visual" section. Import `useLayoutStore` and bind the new Select dropdowns:

```vue
<!-- Add to <script setup> -->
import { useLayoutStore, type NavPosition, type CollapseMode } from '@/stores/layout'

const layoutStore = useLayoutStore()

const navPositionOptions = [
  { name: 'Auto (responsive)', value: 'auto' as NavPosition },
  { name: 'Top', value: 'top' as NavPosition },
  { name: 'Bottom', value: 'bottom' as NavPosition },
  { name: 'Left', value: 'left' as NavPosition },
  { name: 'Right', value: 'right' as NavPosition },
]

const collapseModeOptions = [
  { name: 'Always collapsed', value: 'always-collapsed' as CollapseMode },
  { name: 'Opens on hover', value: 'opens-on-hover' as CollapseMode },
  { name: 'Always expanded', value: 'always-expanded' as CollapseMode },
]

const selectedNavPosition = ref(
  navPositionOptions.find((o) => o.value === layoutStore.navPosition) ?? navPositionOptions[0]
)
const selectedCollapseMode = ref(
  collapseModeOptions.find((o) => o.value === layoutStore.collapseMode) ?? collapseModeOptions[1]
)

function onNavPositionChange() {
  if (selectedNavPosition.value) {
    layoutStore.navPosition = selectedNavPosition.value.value
  }
}

function onCollapseModeChange() {
  if (selectedCollapseMode.value) {
    layoutStore.collapseMode = selectedCollapseMode.value.value
  }
}

// Show collapse mode only when effective position is vertical
const showCollapseMode = computed(() => {
  const pos = layoutStore.navPosition
  return pos === 'left' || pos === 'right' || pos === 'auto'
})
```

```vue
<!-- Add to template, after the dark mode toggle, still inside the flex-col gap-4 div -->
<div class="flex items-center justify-between">
  <label for="nav-position">Nav position</label>
  <Select
    id="nav-position"
    v-model="selectedNavPosition"
    :options="navPositionOptions"
    optionLabel="name"
    @change="onNavPositionChange"
  />
</div>
<div v-if="showCollapseMode" class="flex items-center justify-between">
  <label for="collapse-mode">Sidebar mode</label>
  <Select
    id="collapse-mode"
    v-model="selectedCollapseMode"
    :options="collapseModeOptions"
    optionLabel="name"
    @change="onCollapseModeChange"
  />
</div>
```

**Step 2: Verify build, lint, tests**

```bash
npm run build
npm run lint
npm run test:unit -- --reporter=verbose
```

Expected: All pass.

**Step 3: Manual verification**

Run `npm run dev` and test:
1. Open Settings, change nav position to each option — layout should update immediately
2. For Left/Right, change collapse mode — sidebar should react
3. Click the toggle button at the bottom of the sidebar
4. Resize browser window with "Auto" selected — should switch between sidebar and top bar at 768px

**Step 4: Commit**

```bash
git add src/views/SettingsView.vue
git commit -m "feat: add nav position and sidebar mode settings"
```

---

### Summary

After all 6 tasks:
- Pinia store manages nav position, collapse mode, and nav items
- AppMenubar handles horizontal positions (top/bottom)
- AppSidebar handles vertical positions (left/right) with 3 collapse modes + toggle
- AppLayout orchestrates which component renders based on position
- Settings page lets user override position and collapse mode
- Responsive default: left sidebar on desktop, top bar on mobile
- No persistence — all in-memory, resets on refresh
