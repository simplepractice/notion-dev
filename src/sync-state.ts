// Pure, serializable sync-state helpers. Keeping these transitions separate
// makes the safety properties of a multi-page sync straightforward to test.

export type CursorSyncState = {
  after: string
  seenCursors: string[]
  pages: number
}

export type IncrementalSyncState = {
  since: string
  until?: string
  after?: string
  seenCursors?: string[]
  pages?: number
}

export const INITIAL_WATERMARK = new Date(0).toISOString()
export const CONSISTENCY_BUFFER_MS = 15_000
export const WATERMARK_OVERLAP_MS = 60_000

/**
 * `releasesSync` is a freshness path, not a population path. Issue rows get
 * their release fields from `issuesSync` / `issuesBackfill` via
 * `Issue.releases`. Starting this watermark at the epoch would refetch every
 * issue that ever sat on a release. Seven days covers an in-flight mobile
 * train without that cost.
 */
export const RELEASE_SYNC_LOOKBACK_MS = 7 * 24 * 60 * 60_000

/**
 * Only the most recent cursors are kept. An unbounded history was fine for the
 * ~56 pages a project sweep takes, but an issue cycle runs into the thousands
 * and every cursor is persisted between executions.
 */
export const RETAINED_CURSORS = 50

/**
 * Runaway guard, not a workload limit: a full issue backfill is expected to run
 * into the low thousands of pages. This only has to stop a cycle that will
 * never terminate, which bounded cursor history can no longer catch on its own.
 */
export const MAX_CYCLE_PAGES = 20_000

/**
 * Record recent cursors in persisted state so a short cycle such as A -> B -> A
 * fails instead of keeping a replacement run alive forever, and count pages so
 * a longer loop still terminates once the retained window has rolled past.
 */
export function nextCursorState(
  state: { after?: string; seenCursors?: string[]; pages?: number } | undefined,
  nextCursor: string | undefined,
  resourceName: string
): CursorSyncState {
  if (!nextCursor) {
    throw new Error(`Linear ${resourceName} pagination is missing next cursor`)
  }

  const seenCursors = new Set(state?.seenCursors ?? [])
  if (state?.after) seenCursors.add(state.after)
  if (seenCursors.has(nextCursor)) {
    throw new Error(`Linear ${resourceName} pagination repeated cursor`)
  }

  const pages = (state?.pages ?? 0) + 1
  if (pages > MAX_CYCLE_PAGES) {
    throw new Error(
      `Linear ${resourceName} pagination exceeded ${MAX_CYCLE_PAGES} pages in one cycle`
    )
  }

  return {
    after: nextCursor,
    seenCursors: [...seenCursors, nextCursor].slice(-RETAINED_CURSORS),
    pages,
  }
}

/**
 * Pin an incremental window until every cursor page has completed.
 *
 * `since` starts at the epoch on purpose. The first cycle of an incremental
 * sync is therefore one continuous chained walk of all upstream history, which
 * is how a database gets populated without a scheduled replace sweep. Do not
 * add an initial lookback here.
 */
export function incrementalWindow(
  state: IncrementalSyncState | undefined,
  now = Date.now(),
  initialSince = INITIAL_WATERMARK
): { since: string; until: string } {
  return {
    since: state?.since ?? initialSince,
    until:
      state?.until ??
      new Date(Math.max(0, now - CONSISTENCY_BUFFER_MS)).toISOString(),
  }
}

/** Advance the watermark with overlap after the final page succeeds. */
export function nextWatermark(until: string): string {
  const parsedUntil = Date.parse(until)
  if (!Number.isFinite(parsedUntil)) {
    throw new Error("Linear incremental window has an invalid end time")
  }

  return new Date(Math.max(0, parsedUntil - WATERMARK_OVERLAP_MS)).toISOString()
}
