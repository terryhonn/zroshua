/** Temperature unit preference. Thresholds in settings are always stored as °C. */
export type TempUnit = 'C' | 'F';

/**
 * Volume / flow unit preference. Storage and engine math always use liters
 * (and L/min). Gallons are US liquid gallons.
 */
export type VolumeUnit = 'L' | 'gal';

export const L_PER_US_GAL = 3.785411784;

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

export function lToGal(l: number): number {
  return l / L_PER_US_GAL;
}

export function galToL(g: number): number {
  return g * L_PER_US_GAL;
}

/** Convert a stored liter (or L/min) value to the display unit. */
export function fromStoredL(l: number | null | undefined, unit: VolumeUnit): number | null {
  if (l === null || l === undefined || Number.isNaN(Number(l))) return null;
  const n = Number(l);
  return unit === 'gal' ? lToGal(n) : n;
}

/** Convert a user-entered display value back to stored liters (or L/min). */
export function toStoredL(display: number | string | null | undefined, unit: VolumeUnit): number | null {
  if (display === null || display === undefined || display === '') return null;
  const n = Number(display);
  if (!Number.isFinite(n)) return null;
  return unit === 'gal' ? galToL(n) : n;
}

export function volumeSuffix(unit: VolumeUnit): string {
  return unit === 'gal' ? 'gal' : 'L';
}

export function flowSuffix(unit: VolumeUnit): string {
  return unit === 'gal' ? 'gal/min' : 'l/min';
}

/** Format a liter volume for display (dashboard tiles, stats). */
export function formatVolume(l: number | null | undefined, unit: VolumeUnit, digits?: number): string {
  if (l === null || l === undefined || Number.isNaN(Number(l))) return '—';
  const v = fromStoredL(Number(l), unit)!;
  const d = digits ?? (unit === 'gal' ? 1 : 0);
  const n = d === 0 ? Math.round(v) : Number(v.toFixed(d));
  return `${n} ${volumeSuffix(unit)}`;
}

/** Format a min–max volume range (stats). */
export function formatVolumeRange(minL: number, maxL: number, unit: VolumeUnit): string {
  if (minL === maxL) return formatVolume(minL, unit);
  const a = fromStoredL(minL, unit)!;
  const b = fromStoredL(maxL, unit)!;
  const d = unit === 'gal' ? 1 : 0;
  const fmt = (v: number) => (d === 0 ? Math.round(v) : Number(v.toFixed(d)));
  return `${fmt(a)}–${fmt(b)} ${volumeSuffix(unit)}`;
}

/** Round volume for NumberInput display. */
export function displayVolume(l: number | null | undefined, unit: VolumeUnit): number {
  const v = fromStoredL(l, unit);
  if (v === null) return 0;
  return unit === 'gal' ? Math.round(v * 10) / 10 : Math.round(v);
}

/** Round flow (L/min or gal/min) for NumberInput display. */
export function displayFlow(lpm: number | null | undefined, unit: VolumeUnit): number {
  const v = fromStoredL(lpm, unit);
  if (v === null) return 0;
  return unit === 'gal' ? Math.round(v * 100) / 100 : Math.round(v * 10) / 10;
}

/** Default zone flow rates in storage (L/min), shown converted in the UI. */
export const DEFAULT_FLOW_LPM = 10;
export const DEFAULT_FLOW_RANGE_LPM = { min: 5, max: 15 };
