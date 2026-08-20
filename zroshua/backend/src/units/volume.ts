/**
 * Volume unit preference. Engine storage and comparisons always use liters
 * (and L/min for flow). UI, journal, notifications and MQTT sensors convert
 * with the user's `volumeUnit` preference.
 *
 * Gallons are US liquid gallons (1 gal = 3.785411784 L).
 */
export type VolumeUnit = 'L' | 'gal';

export const L_PER_US_GAL = 3.785411784;

export function lToGal(l: number): number {
  return l / L_PER_US_GAL;
}

export function galToL(g: number): number {
  return g * L_PER_US_GAL;
}

/** Convert a stored liter value to the display unit. */
export function fromStoredL(l: number, unit: VolumeUnit = 'L'): number {
  return unit === 'gal' ? lToGal(l) : l;
}

/** Format a liter value for logs / journal / notifications. */
export function formatVolumeL(l: number, unit: VolumeUnit = 'L', digits?: number): string {
  const v = fromStoredL(l, unit);
  const d = digits ?? (unit === 'gal' ? 1 : 0);
  const n = d === 0 ? Math.round(v) : Number(v.toFixed(d));
  return `${n} ${unit === 'gal' ? 'gal' : 'L'}`;
}

/** Format a L/min flow value for logs / journal / notifications. */
export function formatFlowLpm(lpm: number, unit: VolumeUnit = 'L', digits?: number): string {
  const v = fromStoredL(lpm, unit);
  const d = digits ?? (unit === 'gal' ? 2 : 1);
  const n = Number(v.toFixed(d));
  return `${n} ${unit === 'gal' ? 'gal/min' : 'l/min'}`;
}

function normUnit(unitOfMeasurement?: string | null): string {
  return String(unitOfMeasurement ?? '')
    .toLowerCase()
    .replace(/\s+/g, '');
}

/** Instantaneous rate vs accumulating volume — HA/ESPHome expose both. */
export function haFlowSensorKind(
  unitOfMeasurement?: string | null,
  stateClass?: string | null,
): 'rate' | 'volume' {
  const sc = String(stateClass ?? '').toLowerCase();
  if (sc === 'total_increasing' || sc === 'total') return 'volume';
  const u = normUnit(unitOfMeasurement);
  if (!u) return 'rate';
  if (u.includes('gpm') || u.includes('lpm') || u.includes('/min') || u.includes('/h') || u.includes('/hr') || u.includes('/hour'))
    return 'rate';
  if (
    u === 'l' ||
    u === 'liter' ||
    u === 'litre' ||
    u === 'liters' ||
    u === 'litres' ||
    (u.includes('gal') && !u.includes('/')) ||
    u === 'm³' ||
    u === 'm3' ||
    u === 'm^3' ||
    u.includes('ft³') ||
    u.includes('ft3')
  )
    return 'volume';
  return 'rate';
}

/**
 * Normalize a raw HA flow-sensor reading to L/min using unit_of_measurement.
 * Supports L/min (default), gal/min / GPM, and m³/h.
 */
export function haFlowToLpm(value: number, unitOfMeasurement?: string | null): number {
  const u = normUnit(unitOfMeasurement);
  if (!u) return value;
  if (u.includes('gal') || u === 'gpm') return galToL(value);
  if (u.includes('m³/h') || u.includes('m3/h') || u.includes('m^3/h')) return (value * 1000) / 60;
  if (u.includes('m³/min') || u.includes('m3/min')) return value * 1000;
  // L/min, l/min, Lpm, etc. — already liters per minute
  return value;
}

/** Normalize a HA volume-counter reading to liters. */
export function haVolumeToL(value: number, unitOfMeasurement?: string | null): number {
  const u = normUnit(unitOfMeasurement);
  if (u.includes('gal')) return galToL(value);
  if (u.includes('m³') || u.includes('m3') || u.includes('m^3')) return value * 1000;
  if (u.includes('ft³') || u.includes('ft3') || u.includes('cuft')) return value * 28.316846592;
  return value;
}

export function isVolumeUnit(v: unknown): v is VolumeUnit {
  return v === 'L' || v === 'gal';
}
