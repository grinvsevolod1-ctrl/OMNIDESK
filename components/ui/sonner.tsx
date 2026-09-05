"use client"

import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      position="top-right"
      closeButton
      // В standalone-PWA (viewport-fit=cover) верх экрана занят Dynamic Island /
      // статус-баром: без отступа тосты появляются ПОД ним и по ним нельзя
      // кликнуть. Смещаем на величину выреза (min — базовый отступ на «плоских»
      // экранах), чтобы уведомления всегда были видимы и кликабельны.
      offset={{
        top: "max(1rem, env(safe-area-inset-top))",
        right: "max(1rem, env(safe-area-inset-right))",
        bottom: "max(1rem, env(safe-area-inset-bottom))",
        left: "max(1rem, env(safe-area-inset-left))",
      }}
      mobileOffset={{
        top: "max(0.75rem, env(safe-area-inset-top))",
        right: "max(0.75rem, env(safe-area-inset-right))",
        bottom: "max(0.75rem, env(safe-area-inset-bottom))",
        left: "max(0.75rem, env(safe-area-inset-left))",
      }}
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
