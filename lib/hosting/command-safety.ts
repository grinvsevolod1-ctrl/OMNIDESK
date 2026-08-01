/**
 * Guardrails for the autonomous deploy agent. Pure and dependency-free so it can
 * be unit-tested in isolation and shared between the Next.js app and the worker.
 * The agent runs real shell commands over SSH as a privileged user, so before
 * executing ANY command we screen it against a denylist of catastrophic
 * operations, and the agent loop is bounded by step, per-command and total-time
 * limits plus a cooperative cancellation check.
 *
 * This is defence-in-depth, not a sandbox: it blocks the obvious foot-guns an
 * LLM might emit (wiping the disk, powering off the box, fork bombs) so a
 * confused model can't destroy the server. It is NOT a substitute for deploying
 * only to servers you control.
 */

/** Bounds for one autonomous deploy run. */
export const AGENT_LIMITS = {
  /** Max model/tool iterations before we stop and report. */
  maxSteps: 40,
  /** Hard cap on the whole run. */
  totalMs: 20 * 60_000,
  /** Cap on any single command. */
  perCommandMs: 8 * 60_000,
  /** How often to check for admin cancellation while a command runs. */
  cancelPollMs: 3_000,
  /** Max characters of a command's output fed back to the model per step. */
  maxOutputChars: 6000,
  /** LLM token budget per deploy — hard stop against runaway model loops. */
  maxTokens: 400_000,
} as const

/**
 * Patterns for commands that must never run. Matched against the normalized
 * command string (lowercased, collapsed whitespace). Deliberately broad — a
 * false positive just asks the model to try a safer command.
 */
const DENYLIST: Array<{ re: RegExp; reason: string }> = [
  { re: /\brm\s+(-[a-z]*\s+)*(-rf|-fr|-r\s+-f|-f\s+-r)\b[^\n]*\s\/(\s|$)/, reason: 'рекурсивное удаление корня (rm -rf /)' },
  { re: /\brm\s+-rf\s+\/(\s|$|\*)/, reason: 'рекурсивное удаление корня' },
  { re: /\brm\s+-rf\s+(--no-preserve-root|\/\*)/, reason: 'удаление всей файловой системы' },
  { re: /--no-preserve-root/, reason: 'обход защиты корня' },
  { re: /\bmkfs(\.[a-z0-9]+)?\b/, reason: 'форматирование файловой системы (mkfs)' },
  { re: /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|vd|hd|xvd)/, reason: 'запись поверх диска (dd of=/dev/…)' },
  { re: />\s*\/dev\/(sd|nvme|vd|hd|xvd)[a-z0-9]*/, reason: 'запись в блочное устройство' },
  { re: /\b(shutdown|poweroff|halt|reboot|init\s+0|init\s+6)\b/, reason: 'выключение/перезагрузка сервера' },
  { re: /(^|\s):\s*\(\s*\)\s*\{.*:\s*\|\s*:/, reason: 'форк-бомба' },
  { re: /\bchmod\s+-r?\s*0*\s+\/(\s|$)/, reason: 'сброс прав на корне' },
  { re: /\bchown\s+-r[^\n]*\s\/(\s|$)/, reason: 'смена владельца корня' },
  { re: /\b(iptables\s+-f|ufw\s+disable)\b/, reason: 'сброс фаервола (риск потери доступа)' },
  { re: /\buserdel\s+(-r\s+)?root\b/, reason: 'удаление root' },
  { re: />\s*\/etc\/(passwd|shadow)\b/, reason: 'перезапись системных учёток' },
  { re: /\bcrontab\s+-r\b/, reason: 'удаление всех cron-задач' },
]

export interface CommandScreen {
  blocked: boolean
  reason?: string
}

/** Normalize a command for matching: lowercase, collapse whitespace. */
function normalize(cmd: string): string {
  return cmd.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Screen a shell command against the denylist. Returns `{ blocked: true, reason }`
 * for a catastrophic command so the agent loop can refuse it and tell the model
 * to choose a safer approach.
 */
export function screenCommand(command: string): CommandScreen {
  const cmd = normalize(command)
  if (!cmd) return { blocked: true, reason: 'пустая команда' }
  for (const { re, reason } of DENYLIST) {
    if (re.test(cmd)) return { blocked: true, reason }
  }
  return { blocked: false }
}

/** Trim command output to the model-facing budget, keeping head and tail. */
export function clampOutput(
  output: string,
  max: number = AGENT_LIMITS.maxOutputChars,
): string {
  if (output.length <= max) return output
  const head = output.slice(0, Math.floor(max * 0.7))
  const tail = output.slice(-Math.floor(max * 0.25))
  return `${head}\n…[вывод обрезан, ${output.length - head.length - tail.length} символов пропущено]…\n${tail}`
}
