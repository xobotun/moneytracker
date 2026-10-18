import { describe, it, expect, vi } from 'vitest'
import { showStartupError } from '../startupScreen'

describe('showStartupError', () => {
  it('explains the failure and offers a Reload button that reloads', () => {
    const container = document.createElement('div')
    const reload = vi.fn()
    showStartupError(container, new Error('IndexedDB is blocked'), reload)

    expect(container.textContent).toContain("couldn't start")
    expect(container.textContent).toContain('IndexedDB is blocked')
    const button = container.querySelector('button')
    expect(button?.textContent).toBe('Reload')
    button!.click()
    expect(reload).toHaveBeenCalledOnce()
  })

  it('shows the error as text, never as HTML', () => {
    const container = document.createElement('div')
    showStartupError(container, new Error('<img src=x onerror=alert(1)>'), () => {})
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('is announced to assistive technology', () => {
    const container = document.createElement('div')
    showStartupError(container, 'boom', () => {})
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
  })
})
