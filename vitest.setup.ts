// Node >= 25 ships an experimental built-in `localStorage` global. Without
// `--localstorage-file` it is `undefined`, and because it is defined on
// globalThis it shadows the one jsdom provides — so every spec touching
// localStorage fails on newer Node while passing on Node 22 (CI).
// Re-expose jsdom's Storage objects explicitly. Vitest's jsdom environment
// publishes the JSDOM instance as `globalThis.jsdom`.
const dom = (globalThis as { jsdom?: { window: Window } }).jsdom
if (dom) {
  for (const key of ['localStorage', 'sessionStorage'] as const) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: dom.window[key],
    })
  }
}
