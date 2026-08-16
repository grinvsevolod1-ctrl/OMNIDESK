export interface SecretSystem {
  gateEnabled: boolean
  /** Remaining AI Gateway credit in USD (null when unavailable). */
  aiBalance: number | null
  /** Lifetime AI spend in USD (null when unavailable). */
  aiTotalUsed: number | null
  /** True when the balance figures are real (key present, request ok). */
  aiBalanceOk: boolean
  /** Why the balance is unavailable, if so. */
  aiBalanceMessage: string | null
  /** When true, admins & managers currently see the fake 502 screen. */
  fake502: boolean
}
