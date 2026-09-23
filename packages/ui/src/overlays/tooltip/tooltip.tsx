import { Content, Portal, Root, Trigger } from "@kobalte/core/tooltip"
import { createEffect, Match, onCleanup, splitProps, Switch, untrack, type JSX } from "solid-js"
import type { ComponentProps } from "solid-js"
import { createStore } from "solid-js/store"
import "./tooltip.css"

export interface TooltipProps extends ComponentProps<typeof Root> {
  value: JSX.Element
  appearance?: "standard" | "compact" | "large"
  class?: string
  contentClass?: string
  contentStyle?: JSX.CSSProperties
  inactive?: boolean
  forceOpen?: boolean
  triggerTabIndex?: number
}

export function Tooltip(props: TooltipProps) {
  let ref: HTMLDivElement | undefined
  const [state, setState] = createStore({
    open: false,
    block: false,
    expand: false,
  })
  const [local, others] = splitProps(props, [
    "children",
    "appearance",
    "class",
    "contentClass",
    "contentStyle",
    "inactive",
    "forceOpen",
    "triggerTabIndex",
    "ignoreSafeArea",
    "value",
  ])

  const debug = () => typeof window !== "undefined" && (window as any).__tooltipDebug
  const log = (method: string, detail: Record<string, unknown>) => {
    if (!debug()) return
    console.log(`[Tooltip] ${method}`, { ...detail, block: state.block, expand: state.expand, open: state.open })
  }

  const close = () => {
    log("close", {})
    setState("open", false)
  }
  const controlled = () => local.forceOpen !== undefined

  const inside = () => {
    const active = document.activeElement
    if (!ref || !active) return false
    return ref.contains(active)
  }

  const drop = (expand = state.expand) => {
    if (expand || !state.block) return
    const hover = ref?.matches(":hover") ?? false
    const focus = inside()
    log("drop", { expand, hover, focus, willClear: !hover && !focus })
    if (hover) return
    if (focus) return
    setState("block", false)
  }

  const sync = () => {
    const expand = !!ref?.querySelector('[aria-expanded="true"], [data-expanded]')
    log("sync", { expand, prevExpand: state.expand })
    setState("expand", expand)
    if (expand) {
      setState("block", true)
      close()
      return
    }
    drop(expand)
  }

  const arm = () => {
    log("arm", {})
    setState("block", true)
    close()
  }

  const leave = () => {
    const focus = inside()
    log("leave", { focus })
    if (!focus) close()
    drop()
  }

  createEffect(() => {
    if (!ref) return
    untrack(sync)
    const obs = new MutationObserver(sync)
    obs.observe(ref, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-expanded", "data-expanded"],
    })
    onCleanup(() => obs.disconnect())
  })

  let justClickedTrigger = false

  return (
    <Switch>
      <Match when={local.inactive}>{local.children}</Match>
      <Match when={true}>
        <Root
          gutter={4}
          openDelay={400}
          skipDelayDuration={300}
          {...others}
          closeDelay={0}
          ignoreSafeArea={local.ignoreSafeArea ?? true}
          open={controlled() ? local.forceOpen : state.open}
          onOpenChange={(open) => {
            if (controlled()) return
            if (state.block && open) {
              log("onOpenChange blocked", { requestedOpen: open })
              return
            }
            if (justClickedTrigger) {
              log("onOpenChange justClickedTrigger", { requestedOpen: open })
              justClickedTrigger = false
              return
            }
            log("onOpenChange", { requestedOpen: open })
            setState("open", open)
          }}
        >
          <Trigger
            ref={ref}
            as="div"
            tabIndex={local.triggerTabIndex}
            data-component="tooltip-v2-trigger"
            class={local.class}
            onPointerDownCapture={arm}
            onKeyDownCapture={(event: KeyboardEvent) => {
              if (event.key !== "Enter" && event.key !== " ") return
              arm()
            }}
            onPointerLeave={leave}
            onFocusOut={() => requestAnimationFrame(() => drop())}
          >
            {local.children}
          </Trigger>
          <Portal>
            <Content
              ref={(el) => {
                const theme = ref?.closest("[data-theme]")?.getAttribute("data-theme")
                if (theme) el.setAttribute("data-theme", theme)
              }}
              data-component="tooltip-v2"
              data-appearance={local.appearance ?? "compact"}
              data-placement={props.placement}
              data-force-open={local.forceOpen}
              class={local.contentClass}
              style={local.contentStyle}
              onPointerDownOutside={(e) => {
                if (ref === e.target || (e.target instanceof Node && ref?.contains(e.target))) {
                  justClickedTrigger = true
                }
                e.preventDefault()
              }}
            >
              {local.value}
            </Content>
          </Portal>
        </Root>
      </Match>
    </Switch>
  )
}
