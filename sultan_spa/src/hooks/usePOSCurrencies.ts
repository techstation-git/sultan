import { useMemo } from "react"
import { usePOSDetails } from "./usePOSProfile"

export interface POSCurrencyConfig {
  enabled: boolean
  baseCurrency: string
  baseSymbol: string
  secondaryCurrency: string | null
  secondarySymbol: string | null
  exchangeRate: number          // secondary units per 1 base unit (e.g. 89500 LBP/USD)
}

export function usePOSCurrencies(): POSCurrencyConfig {
  const { posDetails } = usePOSDetails()

  return useMemo(() => {
    const enabled = !!(posDetails?.custom_enable_multi_currency &&
      posDetails?.custom_secondary_currency &&
      (posDetails?.custom_exchange_rate ?? 0) > 0)

    return {
      enabled,
      baseCurrency: posDetails?.currency ?? "USD",
      baseSymbol: posDetails?.currency_symbol ?? "$",
      secondaryCurrency: posDetails?.custom_secondary_currency ?? null,
      secondarySymbol: (posDetails as any)?.custom_secondary_currency_symbol ?? null,
      exchangeRate: (posDetails?.custom_exchange_rate as number) ?? 0,
    }
  }, [posDetails])
}
