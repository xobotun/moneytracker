import { onBeforeUnmount } from 'vue'

// Drag and drop with a finger or pen, from a grip. Native HTML5 drag and drop
// does not work with touch on most mobile browsers, and a touch on the list
// must keep scrolling it — so only the grip (CSS `touch-action: none`) starts
// a drag. The dragged element follows the pointer; drop targets are the
// elements with a `data-drop-key` attribute.

export interface PointerDragOptions {
  /** Whether `key` is a valid drop target for what is being dragged. */
  accepts: (key: string) => boolean
  /** The accepted drop key under the pointer, as it moves (null: none). */
  onOver: (key: string | null) => void
  /** A started drag ended: dropped on `key`, or cancelled / dropped elsewhere (null). */
  onEnd: (key: string | null) => void
}

interface PointerState {
  pointerId: number
  element: HTMLElement
  activate: () => void
  /** False during the hold, before the drag has started. */
  active: boolean
  holdTimer: ReturnType<typeof setTimeout>
  scroller: Element
  startX: number
  startY: number
  startScroll: number
  x: number
  y: number
  key: string | null
  frame: number
}

/** The finger must rest this long on the grip before a drag starts. */
export const HOLD_MS = 100
/** How far it may wander meanwhile; more is a brush or a swipe, not a drag. */
const HOLD_SLOP = 8
const EDGE = 56 // px from the top or bottom edge where the list starts scrolling
const MAX_SCROLL_STEP = 14 // px per frame at the very edge

function scrollParent(element: Element): Element {
  for (let p = element.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p)
    if ((overflowY === 'auto' || overflowY === 'scroll') && p.scrollHeight > p.clientHeight) {
      return p
    }
  }
  return document.scrollingElement ?? document.documentElement
}

export function usePointerDrag(options: PointerDragOptions) {
  let state: PointerState | null = null

  /** The innermost accepted drop key under (x, y), walking out through nested targets. */
  function keyAt(x: number, y: number): string | null {
    let el = document.elementFromPoint?.(x, y)?.closest<HTMLElement>('[data-drop-key]') ?? null
    while (el) {
      const key = el.dataset.dropKey!
      if (options.accepts(key)) return key
      el = el.parentElement?.closest<HTMLElement>('[data-drop-key]') ?? null
    }
    return null
  }

  function update() {
    if (!state?.active) return
    // Keep the element under the finger while the list scrolls beneath it.
    const scrolled = state.scroller.scrollTop - state.startScroll
    state.element.style.transform = `translateY(${state.y - state.startY + scrolled}px)`
    const key = keyAt(state.x, state.y)
    if (key !== state.key) {
      state.key = key
      options.onOver(key)
    }
  }

  // While the pointer rests near the top or bottom edge, scroll that way.
  function autoScroll() {
    if (!state?.active) return
    const isPage = state.scroller === document.scrollingElement
    const rect = isPage
      ? { top: 0, bottom: window.innerHeight }
      : state.scroller.getBoundingClientRect()
    const top = Math.max(rect.top, 0)
    const bottom = Math.min(rect.bottom, window.innerHeight)
    let step = 0
    if (state.y < top + EDGE) step = -MAX_SCROLL_STEP * (1 - (state.y - top) / EDGE)
    else if (state.y > bottom - EDGE) step = MAX_SCROLL_STEP * (1 - (bottom - state.y) / EDGE)
    if (step !== 0) {
      state.scroller.scrollTop += step
      update()
    }
    state.frame = requestAnimationFrame(autoScroll)
  }

  function activate() {
    if (!state) return
    state.active = true
    // Lifted above its neighbours, and transparent to elementFromPoint so the
    // target underneath can be found.
    Object.assign(state.element.style, {
      position: 'relative',
      zIndex: '10',
      pointerEvents: 'none',
      boxShadow: '0 8px 24px rgb(0 0 0 / 0.2)',
    })
    state.activate()
    update()
    state.frame = requestAnimationFrame(autoScroll)
  }

  function onMove(event: PointerEvent) {
    if (!state || event.pointerId !== state.pointerId) return
    state.x = event.clientX
    state.y = event.clientY
    if (state.active) update()
    else if (Math.hypot(state.x - state.startX, state.y - state.startY) > HOLD_SLOP) finish(false)
  }

  function finish(dropped: boolean) {
    if (!state) return
    const { element, frame, key, active, holdTimer } = state
    state = null
    clearTimeout(holdTimer)
    cancelAnimationFrame(frame)
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    if (!active) return // released or moved during the hold: nothing started
    for (const prop of ['transform', 'position', 'zIndex', 'pointerEvents', 'boxShadow'] as const) {
      element.style[prop] = ''
    }
    options.onEnd(dropped ? key : null)
  }

  const onUp = (event: PointerEvent) => {
    if (state && event.pointerId === state.pointerId) finish(true)
  }
  const onCancel = (event: PointerEvent) => {
    if (state && event.pointerId === state.pointerId) finish(false)
  }

  /**
   * Handles a pointerdown on `element`'s grip: after a HOLD_MS rest, calls
   * `onActivate` and starts dragging. Ignores the mouse, which uses native
   * drag and drop; returns whether the pointer was taken.
   */
  function start(event: PointerEvent, element: HTMLElement, onActivate: () => void): boolean {
    if (state || event.pointerType === 'mouse') return false
    event.preventDefault()
    const scroller = scrollParent(element)
    state = {
      pointerId: event.pointerId,
      element,
      activate: onActivate,
      active: false,
      holdTimer: setTimeout(activate, HOLD_MS),
      scroller,
      startX: event.clientX,
      startY: event.clientY,
      startScroll: scroller.scrollTop,
      x: event.clientX,
      y: event.clientY,
      key: null,
      frame: 0,
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    return true
  }

  onBeforeUnmount(() => finish(false))

  return { start }
}
