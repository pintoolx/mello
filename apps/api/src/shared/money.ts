import { USDC_DECIMALS } from "./constants.js";

const USDC_INPUT_PATTERN = /^\d+(?:\.\d{1,6})?$/;

export function parseUsdcToAtomic(display: string): string {
  const normalized = display.trim();
  if (!USDC_INPUT_PATTERN.test(normalized)) {
    throw new Error("USDC amount must be a non-negative decimal with at most 6 places");
  }

  const [whole = "0", fraction = ""] = normalized.split(".");
  const atomic = BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) +
    BigInt(fraction.padEnd(USDC_DECIMALS, "0"));
  return atomic.toString();
}

export function formatUsdcAtomic(atomic: string | bigint): string {
  const value = typeof atomic === "bigint" ? atomic : BigInt(atomic);
  if (value < 0n) throw new Error("USDC amount cannot be negative");

  const divisor = 10n ** BigInt(USDC_DECIMALS);
  const whole = value / divisor;
  const fractional = (value % divisor)
    .toString()
    .padStart(USDC_DECIMALS, "0")
    .replace(/0+$/, "");
  return fractional.length > 0 ? `${whole}.${fractional}` : whole.toString();
}

export function calculateTwdMinorUnits(
  atomicUsdc: string,
  twdPerUsdc: string,
): string {
  if (!/^\d+(?:\.\d+)?$/.test(twdPerUsdc)) {
    throw new Error("FX rate must be a positive decimal string");
  }
  const [whole = "0", fraction = ""] = twdPerUsdc.split(".");
  const scale = 10n ** BigInt(fraction.length);
  const scaledRate = BigInt(whole) * scale + BigInt(fraction || "0");
  const numerator = BigInt(atomicUsdc) * scaledRate * 100n;
  const denominator = 10n ** BigInt(USDC_DECIMALS) * scale;
  return ((numerator + denominator / 2n) / denominator).toString();
}
