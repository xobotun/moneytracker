/**
 * Replaces the app container with a startup-failure screen: what happened,
 * the error text, and a Reload button. Built with DOM APIs and textContent
 * (never innerHTML) so an error message cannot inject markup. Runs before Vue
 * is mounted — or instead of it — so it cannot use components or Tailwind
 * guarantees; the few inline styles keep it readable on its own.
 */
export function showStartupError(
  container: HTMLElement,
  error: unknown,
  reload: () => void = () => location.reload(),
): void {
  const box = document.createElement('div')
  box.setAttribute('role', 'alert')
  box.style.cssText =
    'max-width: 32rem; margin: 4rem auto; padding: 0 1rem; font-family: system-ui, sans-serif;'

  const title = document.createElement('h1')
  title.textContent = "Money Tracker couldn't start"
  title.style.cssText = 'font-size: 1.25rem; margin-bottom: 0.5rem;'

  const hint = document.createElement('p')
  hint.textContent =
    'Your data stays in this browser. Reloading often helps; if it keeps failing, check that site storage is allowed for this page (private windows may block it).'

  const details = document.createElement('pre')
  details.textContent = error instanceof Error ? error.message : String(error)
  details.style.cssText = 'white-space: pre-wrap; font-size: 0.875rem; opacity: 0.8;'

  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = 'Reload'
  button.style.cssText = 'margin-top: 1rem; padding: 0.5rem 1rem; cursor: pointer;'
  button.addEventListener('click', () => reload())

  box.append(title, hint, details, button)
  container.replaceChildren(box)
}
