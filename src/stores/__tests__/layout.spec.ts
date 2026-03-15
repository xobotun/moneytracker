import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useLayoutStore } from '../layout'

// Mock the db/init module
const mockStore = new Map<string, unknown>()
vi.mock('@/db/init', () => ({
  getSettingsRepository: () => ({
    get: async (key: string) => mockStore.get(key) ?? null,
    set: async (key: string, value: unknown) => {
      mockStore.set(key, value)
    },
    getAll: async () => Object.fromEntries(mockStore),
    delete: async (key: string) => {
      mockStore.delete(key)
    },
  }),
}))

describe('useLayoutStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockStore.clear()
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

  describe('hydrate', () => {
    it('loads saved navPosition from repository', async () => {
      mockStore.set('layout.navPosition', 'right')
      const store = useLayoutStore()
      await store.hydrate()
      expect(store.navPosition).toBe('right')
    })

    it('loads saved collapseMode from repository', async () => {
      mockStore.set('layout.collapseMode', 'always-collapsed')
      const store = useLayoutStore()
      await store.hydrate()
      expect(store.collapseMode).toBe('always-collapsed')
    })

    it('keeps defaults when repository has no values', async () => {
      const store = useLayoutStore()
      await store.hydrate()
      expect(store.navPosition).toBe('auto')
      expect(store.collapseMode).toBe('opens-on-hover')
    })
  })

  describe('setNavPosition', () => {
    it('persists and updates navPosition', async () => {
      const store = useLayoutStore()
      await store.setNavPosition('bottom')
      expect(store.navPosition).toBe('bottom')
      expect(mockStore.get('layout.navPosition')).toBe('bottom')
    })
  })

  describe('setCollapseMode', () => {
    it('persists and updates collapseMode', async () => {
      const store = useLayoutStore()
      await store.setCollapseMode('always-expanded')
      expect(store.collapseMode).toBe('always-expanded')
      expect(mockStore.get('layout.collapseMode')).toBe('always-expanded')
    })
  })
})
