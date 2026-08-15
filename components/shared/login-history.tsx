import { Globe, MonitorSmartphone, Smartphone } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { getManagerAuthState } from '@/lib/data'
import {
  listTrustedDevices,
  type TrustedDeviceInfo,
} from '@/lib/trusted-device'
import { LogoutOtherDevicesButton } from './logout-other-devices-button'
import { TrustedDeviceRevokeButton } from './trusted-device-revoke-button'

/**
 * Вкладка «Сессии» в настройках менеджера/куратора: кнопка «Разлогинить все
 * устройства» и доверенные устройства 2FA. Историю входов здесь НЕ показываем
 * (осознанное решение владельца — журнал остаётся только в audit-логе).
 * Server component; после разлогина клиентская кнопка делает router.refresh().
 */

/** Компактная выжимка из User-Agent: браузер + ОС, без сырого хвоста. */
function describeUa(ua: string | null): string {
  if (!ua) return 'Неизвестное устройство'
  const browser = /Firefox\//.test(ua)
    ? 'Firefox'
    : /Edg\//.test(ua)
      ? 'Edge'
      : /OPR\/|Opera/.test(ua)
        ? 'Opera'
        : /YaBrowser\//.test(ua)
          ? 'Яндекс Браузер'
          : /Chrome\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : 'Браузер'
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad/.test(ua)
        ? 'iOS'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : null
  return os ? `${browser} · ${os}` : browser
}

function isMobile(ua: string | null): boolean {
  return !!ua && /Android|iPhone|iPad|Mobile/.test(ua)
}

function TrustedDeviceRow({ device }: { device: TrustedDeviceInfo }) {
  const DeviceIcon = isMobile(device.userAgent) ? Smartphone : MonitorSmartphone
  return (
    <div className="flex items-center gap-3 py-3">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40">
        <DeviceIcon className="size-4 text-muted-foreground" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium">
          {describeUa(device.userAgent)}
        </span>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          {device.ip ? (
            <span className="flex items-center gap-1">
              <Globe className="size-3" />
              {device.ip}
            </span>
          ) : null}
          <span>
            {'до '}
            {new Date(device.expiresAt).toLocaleDateString('ru-RU', {
              day: 'numeric',
              month: 'long',
            })}
          </span>
        </div>
      </div>
      <TrustedDeviceRevokeButton deviceId={device.id} />
    </div>
  )
}

export async function LoginHistory({ managerId }: { managerId: string }) {
  const authState = await getManagerAuthState(managerId)
  const trusted = await listTrustedDevices(
    managerId,
    authState?.sessionVersion ?? 0,
  )
  // Мёртвые пропуски (выданные под старый session_version) не показываем —
  // они уже не работают и только путают список.
  const activeTrusted = trusted.filter((d) => d.active)

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="font-medium">Активные сессии</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Если вы заметили вход, который не совершали, — разлогиньте все
              устройства и смените пароль. Текущая сессия останется активной.
            </p>
          </div>
          <LogoutOtherDevicesButton />
        </div>
      </Card>

      {activeTrusted.length > 0 ? (
        <Card className="p-5">
          <h2 className="font-medium">Доверенные устройства</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Эти устройства не спрашивают код 2FA при входе (30 дней с момента
            подтверждения). «Забыть» — при следующем входе снова спросим код.
          </p>
          <div className="mt-2 divide-y divide-border">
            {activeTrusted.map((d) => (
              <TrustedDeviceRow key={d.id} device={d} />
            ))}
          </div>
        </Card>
      ) : null}

    </div>
  )
}
