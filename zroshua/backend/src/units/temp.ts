/** Temperature unit preference. Engine storage and comparisons always use Celsius. */
export type TempUnit = 'C' | 'F';

export function cToF(c: number): number {
  return (c * 9) / 5 + 32;
}

export function fToC(f: number): number {
  return ((f - 32) * 5) / 9;
}

/** Normalize a raw HA temperature reading to °C using the entity unit string. */
export function haReadingToC(value: number, unitOfMeasurement?: string | null): number {
  const u = String(unitOfMeasurement ?? '').toLowerCase();
  if (u.includes('f')) return fToC(value);
  return value;
}

/** Format a Celsius value for logs / journal using the user preference. */
export function formatTempC(c: number, unit: TempUnit = 'C', digits = 1): string {
  const v = unit === 'F' ? cToF(c) : c;
  const n = digits === 0 ? Math.round(v) : Number(v.toFixed(digits));
  return `${n}°${unit}`;
}

export function isTempUnit(v: unknown): v is TempUnit {
  return v === 'C' || v === 'F';
}
