// Entry point — syncs Linear projects, issues, and initiatives into managed
// Notion databases for cross-functional product and engineering visibility.
//
// Databases:
//   1. Projects     — strategic delivery view (daily full sweep)
//   2. Issues       — engineering work (daily delta + manual backfill + hourly release freshness)
//   3. Initiatives  — company-level goals and health (daily)

// Every API request shares one pacer. All pagination and incremental cursors
// are plain serializable state so executions never rely on module globals.

import { Worker } from "@notionhq/workers"

import {
  fetchInitiativesPage,
  fetchIssuesByIds,
  fetchIssuesPage,
  fetchProjectsPage,
  fetchReleasesPage,
} from "./linear.js"
import {
  INITIAL_TITLE as PROJECTS_TITLE,
  PRIMARY_KEY as PROJECTS_PK,
  projectSchema,
  projectToChange,
} from "./projects.js"
import {
  INITIAL_TITLE as ISSUES_TITLE,
  PRIMARY_KEY as ISSUES_PK,
  issueSchema,
  issueToChange,
  issueToSyncChange,
} from "./issues.js"
import {
  INITIAL_TITLE as INITIATIVES_TITLE,
  PRIMARY_KEY as INITIATIVES_PK,
  initiativeSchema,
  initiativeToChange,
} from "./initiatives.js"
import {
  incrementalWindow,
  nextCursorState,
  nextWatermark,
  RELEASE_SYNC_LOOKBACK_MS,
  type CursorSyncState,
  type IncrementalSyncState,
} from "./sync-state.js"

const worker = new Worker()

// Linear currently documents a lower API-key limit of 2,500 requests/hour
// alongside a separate query-complexity budget. Keep aggregate traffic below
// the lower request limit and keep each GraphQL query deliberately shallow.
//
// This budget is apportioned across every sync that uses the pacer, so adding
// syncs dilutes the ones already here.
const pacer = worker.pacer("linear", {
  allowedRequests: 2_000,
  intervalMs: 3_600_000,
})
const beforeLinearRequest = () => pacer.wait()

// ---------------------------------------------------------------------------
// Initiatives — declared first so projects can relate to them
// ---------------------------------------------------------------------------

const initiatives = worker.database("initiatives", {
  type: "managed",
  initialTitle: INITIATIVES_TITLE,
  primaryKeyProperty: INITIATIVES_PK,
  schema: initiativeSchema,
})

// ---------------------------------------------------------------------------
// Projects — strategic delivery view
// ---------------------------------------------------------------------------

const projects = worker.database("projects", {
  type: "managed",
  initialTitle: PROJECTS_TITLE,
  primaryKeyProperty: PROJECTS_PK,
  schema: projectSchema,
})

// Project milestone edits do not reliably bump the parent project's updatedAt,
// so an updatedAt delta can miss exactly the planning changes this database is
// meant to expose. Projects are small enough (~1,100 rows) for one daily full
// replacement, which also reconciles hard deletes.
worker.sync("projectsSync", {
  database: projects,
  mode: "replace",
  schedule: "1d",
  execute: async (state: CursorSyncState | undefined) => {
    const page = await fetchProjectsPage(beforeLinearRequest, {
      after: state?.after,
    })
    const changes = page.resources
      .filter((project) => !project.trashed)
      .map(projectToChange)

    return {
      changes,
      hasMore: page.hasMore,
      nextState: page.hasMore
        ? nextCursorState(state, page.nextCursor, "projects")
        : undefined,
    }
  },
})

// ---------------------------------------------------------------------------
// Issues — fast incremental updates with an overlapping, pinned time window
// ---------------------------------------------------------------------------

// Declared after projects: the Project property is a relation into the
// projects database, so that database handle has to exist first.
const issues = worker.database("issues", {
  type: "managed",
  initialTitle: ISSUES_TITLE,
  primaryKeyProperty: ISSUES_PK,
  schema: issueSchema,
})

// The only scheduled issue sync. `since` starts at the epoch, so the very first
// cycle chains through every issue in the workspace — that is the initial
// population, and it runs for hours. Afterwards each daily cycle fetches only
// issues changed since the preceding watermark.
//
// Creates, updates, archives, and soft deletes all move updatedAt, so this
// covers everything except an issue destroyed outright between two windows.
worker.sync("issuesSync", {
  database: issues,
  mode: "incremental",
  schedule: "1d",
  execute: async (state: IncrementalSyncState | undefined) => {
    const { since, until } = incrementalWindow(state)

    const page = await fetchIssuesPage(beforeLinearRequest, {
      after: state?.after,
      updatedSince: since,
      updatedBefore: until,
    })
    const changes = page.resources.map(issueToSyncChange)

    if (page.hasMore) {
      return {
        changes,
        hasMore: true,
        nextState: {
          since,
          until,
          ...nextCursorState(state, page.nextCursor, "issues"),
        },
      }
    }

    // Keep an overlap so equal timestamps, indexing lag, and writes near the
    // window boundary are safely replayed. Upserts are idempotent by UUID.
    return {
      changes,
      hasMore: false,
      // Incremental sync state persists between scheduled runs even when the
      // current page finishes the cycle.
      nextState: { since: nextWatermark(until) },
    }
  },
})

// Repair tool, not a schedule. A replace-mode sweep of tens of thousands of
// issues rewrites the whole database and costs hours of paced requests, so it
// runs on demand: after adding a property or regenerating src/options.ts (so
// existing rows pick the new values up), or to clear hard-deleted issues the
// watermark cannot see.
//
//   ntn workers sync trigger issuesBackfill
//
// issueToChange sets upstreamUpdatedAt, which is what stops a slow backfill
// from overwriting a row the delta has already moved forward.
worker.sync("issuesBackfill", {
  database: issues,
  mode: "replace",
  schedule: "manual",
  execute: async (state: CursorSyncState | undefined) => {
    const page = await fetchIssuesPage(beforeLinearRequest, {
      after: state?.after,
    })
    const changes = page.resources
      .filter((issue) => !issue.trashed)
      .map(issueToChange)

    return {
      changes,
      hasMore: page.hasMore,
      nextState: page.hasMore
        ? nextCursorState(state, page.nextCursor, "issues")
        : undefined,
    }
  },
})

// Completing a Linear release (Planned → Released) may not bump the issue's
// updatedAt, so the daily issue delta can miss the exact event the TE board
// cares about. Walk recently updated releases and rewrite the related issue
// rows. First cycle looks back seven days, not the epoch — population is the
// issue syncs via Issue.releases.
worker.sync("releasesSync", {
  database: issues,
  mode: "incremental",
  schedule: "1h",
  execute: async (state: IncrementalSyncState | undefined) => {
    const now = Date.now()
    const { since, until } = incrementalWindow(
      state,
      now,
      new Date(Math.max(0, now - RELEASE_SYNC_LOOKBACK_MS)).toISOString()
    )

    const page = await fetchReleasesPage(beforeLinearRequest, {
      after: state?.after,
      updatedSince: since,
      updatedBefore: until,
    })
    const issueIds = [
      ...new Set(
        page.resources.flatMap((release) =>
          release.issues.nodes.map((issue) => issue.id)
        )
      ),
    ]
    const relatedIssues = await fetchIssuesByIds(beforeLinearRequest, issueIds)
    const changes = relatedIssues.map(issueToSyncChange)

    if (page.hasMore) {
      return {
        changes,
        hasMore: true,
        nextState: {
          since,
          until,
          ...nextCursorState(state, page.nextCursor, "releases"),
        },
      }
    }

    return {
      changes,
      hasMore: false,
      nextState: { since: nextWatermark(until) },
    }
  },
})

// ---------------------------------------------------------------------------
// Initiatives — leadership-level goals and health
// ---------------------------------------------------------------------------

worker.sync("initiativesSync", {
  database: initiatives,
  mode: "replace",
  schedule: "1d",
  execute: async (state: CursorSyncState | undefined) => {
    const page = await fetchInitiativesPage(beforeLinearRequest, state?.after)
    const changes = page.resources
      .filter((initiative) => !initiative.trashed)
      .map(initiativeToChange)

    return {
      changes,
      hasMore: page.hasMore,
      nextState: page.hasMore
        ? nextCursorState(state, page.nextCursor, "initiatives")
        : undefined,
    }
  },
})

export default worker
