// Fill-snapshot retention for params/toSnapshots (create-to) — pure, unit-tested.
//
// Kept by DAY, not by count (2026-11): the TO tool raises a DS's restock as up to
// three group TOs a day (Bags / Ply / Bin Items), so a day can hold ~24 snapshots
// and the old "last 48 entries" would have covered only ~2 days.
//
// A snapshot's day is `day` (grouped snapshots: the operating day, 08:00→08:00 IST)
// else `date` (older Afternoon/Evening batches) — so the switch-over keeps both
// eras, counted on the same calendar. Entries arrive newest-first and keep their
// order. The hard cap only bounds the row if something writes far more than expected.
export const SNAPSHOT_HARD_CAP = 400

export function keepRecentDays<T>(entries: T[], days: number, cap = SNAPSHOT_HARD_CAP): T[] {
  const dayOf = (e: any) => String(e?.day ?? e?.date ?? '')
  const keep = new Set([...new Set(entries.map(dayOf))].filter(Boolean).sort().reverse().slice(0, days))
  return entries.filter((e) => keep.has(dayOf(e))).slice(0, cap)
}
