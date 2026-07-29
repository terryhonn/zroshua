/** Temperature unit preference. Thresholds in settings are always stored as °C. */
export type TempUnit = 'C' | 'F';

export function cToF(c: number): number {
  return (c * 9) / 5 + 32;
}

export function fToC(f: number): number {
  return ((f - 32) * 5) / 9;
}

/** Convert a stored °C value to the display unit. */
export function fromStoredC(c: number | null | undefined, unit: TempUnit): number | null {
  if (c === null || c === undefined || Number.isNaN(Number(c))) return null;
  const n = Number(c);
  return unit === 'F' ? cToF(n) : n;
}

/** Convert a user-entered display value back to stored °C. */
export function toStoredC(display: number | string | null | undefined, unit: TempUnit): number | null {
  if (display === null || display === undefined || display === '') return null;
  const n = Number(display);
  if (!Number.isFinite(n)) return null;
  return unit === 'F' ? fToC(n) : n;
}

export function tempSuffix(unit: TempUnit): string {
  return unit === 'F' ? '°F' : '°C';
}

/** Format a Celsius value for display (e.g. dashboard). */
export function formatTemp(c: number | null | undefined, unit: TempUnit, digits = 0): string {
  if (c === null || c === undefined || Number.isNaN(Number(c))) return '—';
  const v = unit === 'F' ? cToF(Number(c)) : Number(c);
  const n = digits === 0 ? Math.round(v) : Number(v.toFixed(digits));
  return `${n}${tempSuffix(unit)}`;
}

/** Round display values nicely: whole °F, one decimal °C for inputs when needed. */
export function displayTemp(c: number | null | undefined, unit: TempUnit): number {
  const v = fromStoredC(c, unit);
  if (v === null) return 0;
  return unit === 'F' ? Math.round(v) : Math.round(v * 10) / 10;
}
