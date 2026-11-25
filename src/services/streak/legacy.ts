// The old app's streaks, read as v3 reads them (docs/data/sync.md section 4g, "restore"). One difference found in its data (50 streaks): **a streak that failed has the day it failed on as its LAST entry** in
// `daily_logs`, a plain entry (steps below 80% of the goal, no protection), and its `duration` and its level progress do not count it (`duration` = valid days less that one; `end_date` is that day). v3 keeps the failed
// day out of the days (it is `end_date`, and the days are only the ones decided as kept, protected or without data), so a failed old streak is read with that last entry taken off.

export type DayLike = { s?: number; r?: number; r_t?: number; p?: true; n?: true };
export type LevelLogs = { level_id: string; logs: DayLike[] }[];

const KEEP_SHARE = 0.8;

/**
 * Whether the last entry of a failed streak is the day it failed on (the old app's way): the streak is `failed`, and the entry is neither protected nor without data and its steps are below 80% of the goal (a run
 * is not known: the old app had none). A v3 streak never ends in such an entry: it does not record the failed day.
 */
export function endsWithFailedDay(status: string, goal: number, logs: LevelLogs): boolean {
  if (status !== 'failed') {
    return false;
  }
  const last = [...logs].reverse().find(l => l.logs?.length)?.logs.at(-1);
  return !!last && !last.p && !last.n && (last.s ?? 0) < Math.round(goal * KEEP_SHARE);
}

/** The streak's days as v3 reads them: a failed old streak without its last entry (the day it failed on); anything else as it is. */
export function daysAsV3(status: string, goal: number, logs: LevelLogs): LevelLogs {
  if (!endsWithFailedDay(status, goal, logs)) {
    return logs;
  }
  const out = logs.map(l => ({ ...l, logs: [...l.logs] }));
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].logs.length) {
      out[i].logs.pop();
      break;
    }
  }
  return out.filter(l => l.logs.length > 0);
}
