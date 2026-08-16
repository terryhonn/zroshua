/** Local calendar helpers. `toISOString().slice(0, 10)` is UTC and flips
 *  the date all evening west of Greenwich — never use it as a day key. */

export function localDateKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Local midnight of the given instant. */
export function localDayStart(d: Date = new Date()): Date {
  const start = new Date(d);
  start.setHours(0, 0, 0, 0);
  return start;
}

/**
 * Start of the local calendar window covering `days` days including today.
 * `days=1` → today 00:00; `days=7` → midnight six days ago.
 */
export function localDaysAgoStart(days: number, now: Date = new Date()): Date {
  const start = localDayStart(now);
  start.setDate(start.getDate() - (Math.max(1, Math.floor(days)) - 1));
  return start;
}
