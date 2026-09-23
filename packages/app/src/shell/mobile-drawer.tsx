import Drawer from "@corvu/drawer"
import type { ParentProps } from "solid-js"
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
      {(state: any) => (
        <div
          data-slot="mobile-drawer-state"
          data-drawer-open={state.open}
          data-drawer-transition-state={state.transitionState ?? "idle"}
          data-drawer-open-percentage={state.openPercentage?.toFixed(2)}
          data-drawer-translate={state.translate?.toFixed(1)}
          data-drawer-content-present={state.contentPresent}
        >
          {props.children}
        </div>
      )}
    </Drawer>
  )
}

export const MobileDrawerTrigger = Drawer.Trigger

export function MobileDrawerContent(props: ParentProps) {
  const language = useLanguage()
  return (
    <Drawer.Portal>
      <Drawer.Overlay data-slot="mobile-drawer-overlay" />
      <Drawer.Content data-slot="mobile-drawer-content" dir={language.direction()}>
        <div data-slot="mobile-drawer-handle" aria-hidden="true">
          <span />
        </div>
        {props.children}
      </Drawer.Content>
    </Drawer.Portal>
  )
}

export const MobileDrawerLabel = Drawer.Label
export const MobileDrawerClose = Drawer.Close
