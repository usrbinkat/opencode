/** Coordinates focus restoration and actions that must run after menu content unmounts. */
export function createMenuDismissController(
  content: () => HTMLElement | undefined,
  trigger?: () => HTMLElement | undefined,
) {
  let restoreTrigger = true

  return {
    /** Allows the menu primitive to restore focus to its trigger when closing. */
    allowTriggerRestore() {
      restoreTrigger = true
    },
    /** Keeps focus at its current or next destination instead of returning it to the trigger. */
    preventTriggerRestore() {
      restoreTrigger = false
    },
    /**
     * Applies the current restoration policy during the menu primitive's close-focus event.
     * When restoring, explicitly focuses the trigger to avoid relying on Kobalte's deferred
     * focus-scope restoration, which is unreliable in headless environments where the browser
     * window lacks OS-level focus.
     */
    onCloseAutoFocus(event: Event) {
      if (!restoreTrigger) {
        event.preventDefault()
        return
      }
      if (trigger) {
        event.preventDefault()
        trigger()?.focus()
      }
    },
    /** Runs an action after the menu unmounts and its focus-close work has settled. */
    afterClose(callback: () => void) {
      const complete = () => {
        if (content()?.isConnected) {
          requestAnimationFrame(complete)
          return
        }
        requestAnimationFrame(() => requestAnimationFrame(callback))
      }
      requestAnimationFrame(complete)
    },
  }
}
