// Time rules for RecoveryLedger.
// Event timestamps arrive in UTC (ISO 8601). The business day runs
// 00:00:00–23:59:59.999 WAT (West Africa Time, UTC+1, no daylight saving).

const WAT_OFFSET_MS = 60 * 60 * 1000;

/** Parses an ISO 8601 timestamp that carries an explicit zone (Z or ±hh:mm). */
export function parseEventTime(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  // Reject zone-less timestamps: "2026-10-05T23:30:00" is ambiguous.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The WAT calendar date (YYYY-MM-DD) an instant falls on. */
export function watBusinessDate(instant: Date): string {
  return new Date(instant.getTime() + WAT_OFFSET_MS).toISOString().slice(0, 10);
}
