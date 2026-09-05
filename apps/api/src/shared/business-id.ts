const BUSINESS_ID_WEIGHTS = [1, 2, 1, 2, 1, 2, 4, 1] as const;

function sumProductDigits(value: number): number {
  return Math.floor(value / 10) + (value % 10);
}

/** Taiwan's expanded checksum (2023), including the seventh-digit 7 rule.
 * https://www.fia.gov.tw/singlehtml/3?cntId=c4d9cff38c8642ef8872774ee9987283
 */
export function isValidTaiwanBusinessId(value: string): boolean {
  if (!/^\d{8}$/.test(value)) return false;

  const digits = [...value].map(Number);
  const sum = digits.reduce((total, digit, index) => {
    const weight = BUSINESS_ID_WEIGHTS[index];
    return total + sumProductDigits(digit * (weight ?? 0));
  }, 0);

  return sum % 5 === 0 || (digits[6] === 7 && (sum + 1) % 5 === 0);
}
