// A day is a Baghdad day. Iraq keeps UTC+3 all year, with no clock changes.

const BAGHDAD_OFFSET_MS = 3 * 60 * 60 * 1000;

/** The Baghdad calendar date of an instant, as "YYYY-MM-DD". */
export function baghdadDay(instant: Date): string {
  return new Date(instant.getTime() + BAGHDAD_OFFSET_MS).toISOString().slice(0, 10);
}

/** The instant a Baghdad day begins. */
export function baghdadDayStart(day: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new TypeError(`day must be YYYY-MM-DD, got ${day}`);
  }
  return new Date(Date.parse(`${day}T00:00:00Z`) - BAGHDAD_OFFSET_MS);
}
