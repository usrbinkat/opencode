import Drawer from "@corvu/drawer"
import { Show, type ParentProps } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import "./mobile-drawer.css"

export function MobileDrawer(
  props: ParentProps<{
    open: boolean
    onOpenChange: (open: boolean) => void
    onContentPresentChange?: (present: boolean) => void
    returnFocus?: () => HTMLElement | undefined
    closeOnOutsideFocus?: boolean
  }>,
) {
  return (
    <Drawer
      open={props.open}
      onOpenChange={props.onOpenChange}
      onContentPresentChange={props.onContentPresentChange}
      side="bottom"
      finalFocusEl={props.returnFocus?.()}
      closeOnOutsideFocus={props.closeOnOutsideFocus}
    >
      {props.children}
    </Drawer>
  )
}

export const MobileDrawerTrigger = Drawer.Trigger

/**
 * Portal/Overlay/Content children of the drawer. The `mounted` prop controls
 * whether these elements exist in the DOM at all. When `mounted` is false the
 * children are removed immediately — no corvu presence animation runs. This
 * prevents orphaned overlay elements when the viewport crosses the mobile
 * breakpoint: the close animation is wasted work the user never sees (the
 * entire mobile layout is replaced by the desktop layout), and running it
 * creates a window where both mobile and desktop tab strips coexist in the
 * DOM. The Drawer root stays mounted so its reactive context survives.
 */
export function MobileDrawerContent(props: ParentProps<{ mounted?: boolean }>) {
  const language = useLanguage()
  return (
    <Show when={props.mounted !== false}>
      <Drawer.Portal>
        <Drawer.Overlay data-slot="mobile-drawer-overlay" />
        <Drawer.Content data-slot="mobile-drawer-content" dir={language.direction()}>
          <div data-slot="mobile-drawer-handle" aria-hidden="true">
            <span />
          </div>
          {props.children}
        </Drawer.Content>
      </Drawer.Portal>
    </Show>
  )
}

export const MobileDrawerLabel = Drawer.Label
export const MobileDrawerClose = Drawer.Close
