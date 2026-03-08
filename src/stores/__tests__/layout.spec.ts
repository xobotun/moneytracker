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
