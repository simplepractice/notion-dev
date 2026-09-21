// Offline tests for the Linear sync worker.
// Run from this directory with `npm test`.

import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import { RateLimitError } from "@notionhq/workers"

import {
  MAX_PAGE_SECTION_CHARACTERS,
  MAX_RENDERED_CONTRIBUTING_PROJECTS,
  cycleDisplay,
  dateOnly,
  dateTime,
  formatLinearLabel,
  healthLabel,
  labelSelectNames,
  latestTimestamp,
  linkedResourcesFromProject,
  longFormContent,
  milestoneSummary,
  personDisplay,
  personEmail,
  pickCurrentRelease,
  priorityLabel,
  projectStatusLabel,
  relatedInitiativeIds,
  releaseDisplayName,
  resourcePageContent,
  selectName,
  teamSelectName,
  teamSelectNames,
  workflowCategoryLabel,
} from "./src/helpers.js"
import worker from "./src/index.js"
import { initiativeToChange } from "./src/initiatives.js"
import { issueToChange, issueToSyncChange } from "./src/issues.js"
import {
  MAX_NESTED_INITIATIVE_PROJECT_REQUESTS_PER_PAGE,
  MAX_NESTED_MILESTONE_REQUESTS_PER_PAGE,
  MAX_NESTED_RELEASE_ISSUE_REQUESTS_PER_PAGE,
  fetchInitiativesPage,
  fetchIssuesByIds,
  fetchIssuesPage,
  fetchProjectsPage,
  fetchReleasesPage,
  parseRetryAfterSeconds,
  rateLimitRetryAfterSeconds,
} from "./src/linear.js"
import type {
  LinearInitiative,
  LinearInitiativeProject,
  LinearIssue,
  LinearProject,
  LinearRelease,
  LinearReleaseRef,
} from "./src/linear.js"
import {
  ISSUE_STATUS_OPTIONS,
  PROJECT_LABEL_OPTIONS,
  PROJECT_STATUS_OPTIONS,
  RELEASE_STAGE_OPTIONS,
  TEAM_OPTIONS,
  WORKFLOW_CATEGORY_OPTIONS,
} from "./src/options.js"
import { projectToChange, projectToSyncChange } from "./src/projects.js"
import {
  CONSISTENCY_BUFFER_MS,
  INITIAL_WATERMARK,
  MAX_CYCLE_PAGES,
  RELEASE_SYNC_LOOKBACK_MS,
  RETAINED_CURSORS,
  WATERMARK_OVERLAP_MS,
  incrementalWindow,
  nextCursorState,
  nextWatermark,
} from "./src/sync-state.js"

const originalFetch = globalThis.fetch
const originalApiKey = process.env.LINEAR_API_KEY
const originalDateNow = Date.now

afterEach(() => {
  globalThis.fetch = originalFetch
  Date.now = originalDateNow
  if (originalApiKey === undefined) {
    delete process.env.LINEAR_API_KEY
  } else {
    process.env.LINEAR_API_KEY = originalApiKey
  }
})

function propertyText(value: unknown): string {
  return JSON.stringify(value)
}

function assertPropertyContains(value: unknown, expected: string): void {
  assert.match(
    propertyText(value),
    new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  )
}

/**
 * Builder.select("A") serializes to [["A"]] and Builder.multiSelect("A", "B")
 * to [["A,B"]] — which is exactly why option names cannot contain commas.
 */
function selectValues(property: unknown): string[] {
  const raw = (property as unknown[][] | undefined)?.[0]?.[0]
  if (typeof raw !== "string") return []
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
}

/**
 * A select value the schema does not declare is dropped on write with no
 * error, so the only way to see it is to check the transform against the
 * schema it writes into.
 */
function assertSelectValuesAreDeclared(
  databaseKey: string,
  properties: Record<string, unknown>
): void {
  const schema =
    worker.manifest.databases.find((database) => database.key === databaseKey)
      ?.config.schema.properties ?? {}

  for (const [name, value] of Object.entries(properties)) {
    const declaration = schema[name] as
      | { type: string; options?: { name: string }[] }
      | undefined
    if (
      declaration?.type !== "select" &&
      declaration?.type !== "multi_select"
    ) {
      continue
    }

    const declared = new Set(
      (declaration.options ?? []).map((option) => option.name)
    )
    for (const emitted of selectValues(value)) {
      assert.ok(
        declared.has(emitted),
        `${databaseKey}.${name} emits "${emitted}", which src/options.ts does not declare`
      )
    }
  }
}

function emptyConnection<T>(): {
  nodes: T[]
  pageInfo: { hasNextPage: boolean; endCursor: null }
} {
  return { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }
}

const fullProject: LinearProject = {
  id: "f0d3f667-397d-4f29-a3bd-c34fcab57ffc",
  name: "Launch Enterprise",
  slugId: "launch-enterprise-42",
  url: "https://linear.app/acme/project/launch-enterprise-42",
  status: { name: "Custom delivery name", type: "started" },
  health: "atRisk",
  lastUpdate: {
    body: "Enterprise launch remains on track after the security review.",
    createdAt: "2026-07-01T15:16:17.654Z",
    updatedAt: "2026-07-01T16:17:18.654Z",
    url: "https://linear.app/acme/project/launch-enterprise-42/updates/last",
    user: { name: "Ada Lovelace", displayName: "Ada", email: "ada@example.com" },
  },
  lead: { name: "Ada Lovelace", displayName: "Ada", email: "ada@example.com" },
  teams: {
    nodes: [
      { name: "Platform", key: "PLT" },
      { name: "Product, Core", key: "PD" },
      { name: "Platform", key: "PLT" },
    ],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
  labels: {
    nodes: [{ name: "sdlc" }, { name: "platform,core" }, { name: "sdlc" }],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
  projectMilestones: {
    nodes: [
      { name: "Beta", targetDate: "2026-06-01" },
      { name: "GA", targetDate: null },
    ],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
  initiatives: {
    nodes: [
      {
        id: "33ac57a9-f846-44e8-9889-91f061409343",
        name: "Enterprise readiness",
        archivedAt: null,
      },
      {
        id: "archived-initiative",
        name: "Old initiative",
        archivedAt: "2026-01-01T00:00:00Z",
      },
    ],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
  externalLinks: {
    nodes: [
      { url: "https://www.notion.so/prd", label: "PRD" },
      { url: "https://www.notion.so/tdd", label: "Tech Design" },
    ],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
  documents: {
    nodes: [{ url: "https://linear.app/acme/document/brief", title: "Brief" }],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
  priority: 2,
  priorityLabel: null,
  progress: 1.25,
  startDate: "2026-02-03",
  targetDate: "2026-09-30",
  startedAt: "2026-02-03T14:15:16.789Z",
  completedAt: "2026-09-29T23:59:58.123Z",
  canceledAt: null,
  createdAt: "2025-12-01T08:09:10.456Z",
  updatedAt: "2026-06-30T17:18:19.987Z",
  description: "Fallback project description",
  content: "# Launch Enterprise\n\nFull project brief.",
  archivedAt: "2026-10-01T00:00:00Z",
  trashed: false,
}

const minimalProject: LinearProject = {
  id: "b3be6524-e989-410b-b0a4-98ed6b42dc40",
  name: "Unscheduled project",
  slugId: "",
  url: "https://linear.app/acme/project/unscheduled",
  status: null,
  health: null,
  lastUpdate: null,
  lead: null,
  teams: emptyConnection(),
  labels: emptyConnection(),
  projectMilestones: emptyConnection(),
  initiatives: emptyConnection(),
  externalLinks: emptyConnection(),
  documents: emptyConnection(),
  priority: null,
  priorityLabel: null,
  progress: null,
  startDate: null,
  targetDate: null,
  startedAt: null,
  completedAt: null,
  canceledAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T03:04:05Z",
  description: null,
  content: null,
  archivedAt: null,
  trashed: null,
}

const fullIssue: LinearIssue = {
  id: "2ec63b7f-8b80-4d4b-b19a-34ca621ba901",
  identifier: "ENG-321",
  title: "Make import resumable",
  url: "https://linear.app/acme/issue/ENG-321/make-import-resumable",
  description: "## Acceptance criteria\n\n- Resume from the saved cursor.",
  state: { name: "In Progress", type: "started" },
  priority: 1,
  priorityLabel: "",
  assignee: { name: "Grace Hopper", displayName: "Grace", email: "grace@example.com" },
  team: { name: "Engineering", key: "ENG" },
  project: {
    id: "0c0d1a3c-2f2f-4c6f-9b8a-1f3b6f5a2d10",
    name: "Launch Enterprise",
  },
  cycle: { name: "Cycle 27", number: 27 },
  labels: {
    // A comma and a double space, which the schema options do not contain.
    nodes: [
      { name: "backend" },
      { name: "api, internal" },
      { name: "needs  review" },
      { name: "backend" },
    ],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
  releases: {
    nodes: [
      {
        id: "rel-ios-1048",
        name: "10.4.8",
        version: "10.4.8",
        completedAt: null,
        updatedAt: "2026-06-30T21:00:00.000Z",
        archivedAt: null,
        trashed: false,
        stage: { name: "Planned", type: "planned" },
        pipeline: { name: "iOS Clinician" },
      },
    ],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
  estimate: 0,
  dueDate: "2026-07-15",
  createdAt: "2026-06-01T01:02:03.456Z",
  updatedAt: "2026-06-30T20:21:22.987Z",
  startedAt: "2026-06-03T04:05:06.789Z",
  completedAt: "2026-06-29T22:23:24.123Z",
  canceledAt: null,
  archivedAt: null,
  trashed: false,
}

const minimalIssue: LinearIssue = {
  id: "7ae26556-424d-488a-a8a5-5b38e9a28088",
  identifier: "ENG-1",
  title: "Triage me",
  url: "https://linear.app/acme/issue/ENG-1/triage-me",
  description: null,
  state: null,
  priority: 0,
  priorityLabel: "",
  assignee: null,
  team: null,
  project: null,
  cycle: { name: "", number: 12 },
  labels: {
    nodes: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
  releases: {
    nodes: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
  estimate: null,
  dueDate: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  startedAt: null,
  completedAt: null,
  canceledAt: null,
  archivedAt: null,
  trashed: null,
}

const fullInitiative: LinearInitiative = {
  id: "a4614236-8020-4eb7-8f50-cf088cc5f075",
  name: "Reach enterprise readiness",
  slugId: "enterprise-readiness-2026",
  url: "https://linear.app/acme/initiative/enterprise-readiness-2026",
  status: "Active",
  health: "offTrack",
  lastUpdate: {
    body: "The remaining enterprise blockers now have committed owners.",
    createdAt: "2026-07-02T17:18:19.321Z",
    updatedAt: "2026-07-02T18:19:20.321Z",
    url: "https://linear.app/acme/initiative/enterprise-readiness-2026/updates/last",
    user: { name: "Nan Yu", displayName: "Nan", email: "nan@example.com" },
  },
  owner: {
    name: "Katherine Johnson",
    displayName: "Katherine",
    email: "katherine@example.com",
  },
  projects: {
    nodes: [
      {
        id: "project-mobile",
        name: "Mobile Reliability",
        url: "https://linear.app/acme/project/mobile-reliability",
        updatedAt: "2026-06-29T10:00:00Z",
        archivedAt: null,
        trashed: false,
      },
      {
        id: "project-api",
        name: "API Foundations",
        url: "https://linear.app/acme/project/api-foundations",
        updatedAt: "2026-06-28T10:00:00Z",
        archivedAt: "2026-06-30T00:00:00Z",
        trashed: false,
      },
      {
        id: "project-api",
        name: "Duplicate API Foundations",
        url: "https://linear.app/acme/project/api-foundations",
        updatedAt: "2026-06-28T10:00:00Z",
        archivedAt: null,
        trashed: false,
      },
      {
        id: "project-trashed",
        name: "Discarded experiment",
        url: "https://linear.app/acme/project/discarded",
        updatedAt: "2026-07-03T10:00:00Z",
        archivedAt: null,
        trashed: true,
      },
    ],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
  targetDate: "2026-12-31",
  startedAt: "2026-01-15T11:12:13.456Z",
  completedAt: "2026-12-20T14:15:16.789Z",
  createdAt: "2025-11-01T17:18:19.123Z",
  updatedAt: "2026-06-30T20:21:22.987Z",
  description: "Fallback initiative description",
  content: "# Enterprise readiness\n\nCompany-level goal.",
  archivedAt: "2027-01-01T00:00:00Z",
  trashed: false,
}

const minimalInitiative: LinearInitiative = {
  id: "33ac57a9-f846-44e8-9889-91f061409343",
  name: "Explore a new market",
  slugId: "",
  url: "https://linear.app/acme/initiative/explore-market",
  status: null,
  health: null,
  lastUpdate: null,
  owner: null,
  projects: {
    nodes: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
  targetDate: null,
  startedAt: null,
  completedAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  description: null,
  content: null,
  archivedAt: null,
  trashed: null,
}

test("worker manifest preserves databases, sync schedules, and shared pacing", () => {
  // Issues are declared after projects because the issue Project property is a
  // relation into the projects database.
  assert.deepEqual(
    worker.manifest.databases.map((database) => ({
      key: database.key,
      title: database.config.initialTitle,
      primaryKey: database.config.primaryKeyProperty,
      icon: database.config.schema.databaseIcon,
    })),
    [
      {
        key: "initiatives",
        title: "Linear Initiatives",
        primaryKey: "Linear Initiative ID",
        icon: { type: "notion", icon: "trophy", color: "gray" },
      },
      {
        key: "projects",
        title: "Linear Projects",
        primaryKey: "Linear Project ID",
        icon: { type: "notion", icon: "target", color: "gray" },
      },
      {
        key: "issues",
        title: "Linear Issues",
        primaryKey: "Linear Issue ID",
        icon: { type: "notion", icon: "checkmark-square", color: "gray" },
      },
    ]
  )
  assert.deepEqual(
    worker.manifest.databases.map((database) => ({
      key: database.key,
      firstSixProperties: Object.keys(database.config.schema.properties).slice(
        0,
        6
      ),
    })),
    [
      {
        key: "initiatives",
        firstSixProperties: [
          "Name",
          "Status",
          "Health",
          "Owner",
          "Initiative Link",
          "Project Count",
        ],
      },
      {
        key: "projects",
        firstSixProperties: [
          "Name",
          "Status",
          "Health",
          "Lead",
          "Teams",
          "Project Link",
        ],
      },
      {
        key: "issues",
        firstSixProperties: [
          "Title",
          "Issue Key",
          "Status",
          "Priority",
          "Assignee",
          "Issue Link",
        ],
      },
    ]
  )

  const initiativeProperties =
    worker.manifest.databases.find((database) => database.key === "initiatives")
      ?.config.schema.properties ?? {}
  assert.equal("Priority" in initiativeProperties, false)
  assert.equal("Canceled" in initiativeProperties, false)

  // Select properties declared with an empty option list silently drop every
  // value they are given, which is how Status/Teams/Labels first shipped blank.
  for (const database of worker.manifest.databases) {
    for (const [name, property] of Object.entries(
      database.config.schema.properties
    )) {
      const configuration = property as { type: string; options?: unknown[] }
      if (
        configuration.type !== "select" &&
        configuration.type !== "multi_select"
      ) {
        continue
      }
      assert.ok(
        (configuration.options?.length ?? 0) > 0,
        `${database.key}.${name} declares no select options`
      )
      const foldedNames = new Set<string>()
      for (const option of configuration.options ?? []) {
        const optionName = (option as { name?: string }).name?.trim()
        assert.ok(
          optionName,
          `${database.key}.${name} declares an unnamed select option`
        )
        const folded = optionName.toLocaleLowerCase()
        assert.ok(
          !foldedNames.has(folded),
          `${database.key}.${name} declares duplicate option "${optionName}"`
        )
        foldedNames.add(folded)
      }
    }
  }

  type SyncManifestConfig = {
    databaseKey: string
    mode: string
    schedule: { type: string; intervalMs: number }
  }
  assert.deepEqual(
    worker.manifest.capabilities.map((capability) => {
      assert.equal(capability._tag, "sync")
      const config = capability.config as SyncManifestConfig
      return {
        key: capability.key,
        databaseKey: config.databaseKey,
        mode: config.mode,
        schedule: config.schedule,
      }
    }),
    [
      {
        key: "projectsSync",
        databaseKey: "projects",
        mode: "incremental",
        schedule: { type: "interval", intervalMs: 60 * 60_000 },
      },
      {
        key: "projectsReconciliationSync",
        databaseKey: "projects",
        mode: "replace",
        schedule: { type: "interval", intervalMs: 24 * 60 * 60_000 },
      },
      {
        key: "issuesSync",
        databaseKey: "issues",
        mode: "incremental",
        schedule: { type: "interval", intervalMs: 24 * 60 * 60_000 },
      },
      {
        key: "issuesBackfill",
        databaseKey: "issues",
        mode: "replace",
        schedule: { type: "manual" },
      },
      {
        key: "releasesSync",
        databaseKey: "issues",
        mode: "incremental",
        schedule: { type: "interval", intervalMs: 60 * 60_000 },
      },
      {
        key: "initiativesSync",
        databaseKey: "initiatives",
        mode: "replace",
        schedule: { type: "interval", intervalMs: 24 * 60 * 60_000 },
      },
    ]
  )

  assert.deepEqual(worker.manifest.pacers, [
    {
      key: "linear",
      config: { allowedRequests: 2_000, intervalMs: 60 * 60_000 },
    },
  ])
})

test("display helpers normalize Linear values without discarding unknowns", () => {
  assert.equal(formatLinearLabel("in_progress-now"), "In Progress Now")
  assert.equal(formatLinearLabel("offTrack"), "Off Track")

  assert.equal(projectStatusLabel("started"), "Started")
  assert.equal(projectStatusLabel("CANCELLED"), "Canceled")
  assert.equal(projectStatusLabel("custom_status"), "Custom Status")
  assert.equal(projectStatusLabel("  "), null)

  assert.equal(healthLabel("onTrack"), "On Track")
  assert.equal(healthLabel("at_risk"), "At Risk")
  assert.equal(healthLabel("custom_health"), "Custom Health")
  assert.equal(healthLabel(null), null)

  assert.equal(workflowCategoryLabel("started"), "Started")
  assert.equal(workflowCategoryLabel("auto_closed"), "Auto Closed")
  assert.equal(workflowCategoryLabel(null), null)

  assert.equal(priorityLabel(1, null), "Urgent")
  assert.equal(priorityLabel(2, ""), "High")
  assert.equal(priorityLabel(99, null), "99")
  assert.equal(priorityLabel(null, "no_priority"), "No Priority")
  assert.equal(priorityLabel("4"), "Low")
  assert.equal(priorityLabel("special_case"), "Special Case")
  assert.equal(priorityLabel(null), null)
})

test("content, person, cycle, and date helpers preserve useful values", () => {
  assert.equal(
    personDisplay({ displayName: "  Display Name " }),
    "Display Name"
  )
  assert.equal(
    personDisplay({ displayName: "", name: " API Name " }),
    "API Name"
  )
  assert.equal(
    personDisplay({ email: " person@example.com " }),
    "person@example.com"
  )
  assert.equal(personDisplay(null), null)

  assert.deepEqual(
    teamSelectNames([
      { name: "Platform", key: "PLT" },
      { name: "Product, Core", key: "PD" },
      { name: "Platform", key: "PLT" },
      { name: "  ", key: "" },
    ]),
    ["Platform", "Product Core"]
  )
  assert.equal(personEmail({ email: " ada@example.com " }), "ada@example.com")
  assert.equal(personEmail({ email: "Ada" }), null)
  assert.deepEqual(
    labelSelectNames([{ name: "sdlc" }, { name: "platform,core" }, { name: "sdlc" }]),
    ["sdlc", "platformcore"]
  )
  assert.equal(
    milestoneSummary([
      { name: "Beta", targetDate: "2026-06-01T00:00:00Z" },
      { name: "GA", targetDate: null },
      { name: "Beta", targetDate: "2026-06-01" },
    ]),
    "Beta (2026-06-01) · GA"
  )
  assert.equal(milestoneSummary([]), null)
  assert.deepEqual(
    relatedInitiativeIds([
      { id: "keep", archivedAt: null },
      { id: "drop", archivedAt: "2026-01-01T00:00:00Z" },
      { id: "keep", archivedAt: null },
    ]),
    ["keep"]
  )
  assert.deepEqual(
    linkedResourcesFromProject({
      externalLinks: {
        nodes: [
          { url: "https://www.notion.so/prd", label: "PRD" },
          { url: "https://www.notion.so/prd", label: "Duplicate" },
        ],
      },
      documents: {
        nodes: [{ url: "https://linear.app/doc", title: "Brief" }],
      },
    }).map((resource) => resource.label),
    ["PRD", "Brief"]
  )

  assert.equal(cycleDisplay({ name: " Sprint 20 ", number: 20 }), "Sprint 20")
  assert.equal(cycleDisplay({ name: "", number: 20 }), "Cycle 20")
  assert.equal(cycleDisplay(null), null)

  const planned: LinearReleaseRef = {
    id: "planned",
    name: "10.4.8",
    version: "10.4.8",
    completedAt: null,
    updatedAt: "2026-06-01T00:00:00Z",
    archivedAt: null,
    trashed: false,
    stage: { name: "Planned", type: "planned" },
    pipeline: { name: "iOS Clinician" },
  }
  const released: LinearReleaseRef = {
    id: "released",
    name: "10.4.7",
    version: "10.4.7",
    completedAt: "2026-06-11T00:00:00Z",
    updatedAt: "2026-06-11T00:00:00Z",
    archivedAt: null,
    trashed: false,
    stage: { name: "Released", type: "completed" },
    pipeline: { name: "iOS Clinician" },
  }
  assert.equal(
    pickCurrentRelease([released, planned])?.id,
    "planned",
    "an open train beats a shipped one"
  )
  assert.equal(pickCurrentRelease([released])?.id, "released")
  assert.equal(pickCurrentRelease([{ ...released, trashed: true }]), null)
  assert.equal(releaseDisplayName(planned), "10.4.8")
  assert.equal(
    releaseDisplayName({ ...planned, version: null, name: "Nightly" }),
    "Nightly"
  )
  assert.ok((RELEASE_STAGE_OPTIONS as readonly string[]).includes("Planned"))
  assert.ok((RELEASE_STAGE_OPTIONS as readonly string[]).includes("Released"))

  assert.equal(
    longFormContent("# Rich document", "description"),
    "# Rich document"
  )
  assert.equal(longFormContent(" ", "  description  "), "  description  ")
  assert.equal(longFormContent(null, null), "")
  assert.equal(dateOnly("2026-06-30T23:59:59Z"), "2026-06-30")
  assert.equal(dateOnly("  "), null)
  assert.equal(dateTime("2026-06-30T23:59:59.987Z"), "2026-06-30T23:59:59.987Z")
  assert.equal(dateTime(null), null)

  const primary = "2026-06-30T12:00:00.000Z"
  assert.equal(
    latestTimestamp(primary, "2026-07-01T12:00:00.000Z"),
    "2026-07-01T12:00:00.000Z"
  )
  assert.equal(latestTimestamp(primary, "2026-06-01T12:00:00.000Z"), primary)
  assert.equal(latestTimestamp(primary, null), primary)
  assert.equal(latestTimestamp(primary, "not-a-timestamp"), primary)
  assert.equal(
    latestTimestamp("invalid-primary", "2026-07-01T12:00:00.000Z"),
    "2026-07-01T12:00:00.000Z"
  )
})

test("page content keeps Unicode update excerpts bounded without splitting characters", () => {
  const rocket = "🚀"
  const content = resourcePageContent({
    overview: "",
    overviewHeading: "Project overview",
    resourceUrl: "https://linear.app/acme/project/unicode",
    latestUpdate: {
      body: rocket.repeat(MAX_PAGE_SECTION_CHARACTERS + 1),
    },
  })
  const [heading, notice, excerpt] = content.split("\n\n")

  assert.equal(heading, "## Latest update")
  assert.equal(Array.from(excerpt ?? "").length, MAX_PAGE_SECTION_CHARACTERS)
  assert.ok(
    Array.from(excerpt ?? "").every((character) => character === rocket)
  )
  assert.match(notice ?? "", /shortened in Notion/)
})

test("truncated Markdown cannot swallow later page-content sections", () => {
  const content = resourcePageContent({
    overview: "The overview remains visible.",
    overviewHeading: "Initiative overview",
    resourceUrl: "https://linear.app/acme/initiative/safe-markdown",
    latestUpdate: {
      body: `\`\`\`ts\n${"const value = 1\n".repeat(MAX_PAGE_SECTION_CHARACTERS)}`,
      url: "https://linear.app/acme/update/safe-markdown",
    },
    contributingProjects: [],
  })

  assert.match(content, /This latest update was shortened in Notion/)
  assert.doesNotMatch(content, /```/)
  assert.match(content, /## Contributing projects \(0\)/)
  assert.match(content, /## Initiative overview/)
  assert.match(content, /The overview remains visible\./)
})

test("page content bounds long contributing-project lists with an explicit link", () => {
  const projects = Array.from(
    { length: MAX_RENDERED_CONTRIBUTING_PROJECTS + 2 },
    (_, index) => ({
      id: `project-${index}`,
      name: `Project ${String(index).padStart(3, "0")}`,
      url: `https://linear.app/acme/project/${index}`,
    })
  )
  const content = resourcePageContent({
    overview: "",
    overviewHeading: "Initiative overview",
    resourceUrl: "https://linear.app/acme/initiative/roadmap",
    contributingProjects: projects,
  })

  assert.match(content, /## Contributing projects \(102\)/)
  assert.equal(
    content.match(/^- \[Project /gm)?.length,
    MAX_RENDERED_CONTRIBUTING_PROJECTS
  )
  assert.match(content, /…and 2 more/)
  assert.match(content, /View all projects in Linear/)
})

test("retry helpers handle delta seconds, dates, and exhausted Linear budgets", () => {
  const now = Date.parse("2026-06-30T12:00:00Z")
  assert.equal(parseRetryAfterSeconds("3.2", now), 4)
  assert.equal(parseRetryAfterSeconds("Tue, 30 Jun 2026 12:00:07 GMT", now), 7)
  assert.equal(parseRetryAfterSeconds("invalid", now), undefined)
  assert.equal(parseRetryAfterSeconds(null, now), undefined)

  const headers = new Headers({
    "retry-after": "2",
    "x-ratelimit-requests-remaining": "0",
    "x-ratelimit-requests-reset": String(now + 8_001),
    "x-ratelimit-complexity-remaining": "4",
    "x-ratelimit-complexity-reset": String(now + 60_000),
  })
  assert.equal(rateLimitRetryAfterSeconds(headers, now), 9)
  assert.equal(rateLimitRetryAfterSeconds(new Headers(), now), undefined)
})

test("project transform leads with its latest update and retains the overview", () => {
  const change = projectToChange(fullProject)

  assert.equal(change.type, "upsert")
  assert.equal(
    change.key,
    fullProject.id,
    "the immutable Linear UUID is the key"
  )
  assert.equal(change.upstreamUpdatedAt, fullProject.lastUpdate?.updatedAt)
  assert.match(change.pageContentMarkdown, /^## Latest update/)
  assert.match(change.pageContentMarkdown, /Updated by Ada · 2026-07-01/)
  assert.match(
    change.pageContentMarkdown,
    /Enterprise launch remains on track after the security review\./
  )
  assert.match(change.pageContentMarkdown, /Open update in Linear/)
  assert.match(change.pageContentMarkdown, /## Project overview/)
  assert.match(change.pageContentMarkdown, /Full project brief\./)
  assert.ok(
    change.pageContentMarkdown.indexOf("## Latest update") <
      change.pageContentMarkdown.indexOf("## Project overview")
  )
  assertPropertyContains(change.properties.Name, fullProject.name)
  assertPropertyContains(change.properties.Status, "Custom delivery name")
  assertPropertyContains(change.properties["Status Category"], "Started")
  assertPropertyContains(change.properties.Health, "At Risk")
  assertPropertyContains(change.properties.Lead, "ada@example.com")
  assertPropertyContains(change.properties.Teams, "Platform")
  assertPropertyContains(change.properties.Teams, "Product Core")
  assertPropertyContains(change.properties["Project Link"], fullProject.url)
  assertPropertyContains(change.properties["Linked Resources"], "PRD")
  assertPropertyContains(
    change.properties["Linked Resources"],
    "https://www.notion.so/prd"
  )
  assertPropertyContains(change.properties["Linked Resources"], "Brief")
  assertPropertyContains(
    change.properties.Summary,
    "Fallback project description"
  )
  assertPropertyContains(change.properties.Labels, "sdlc")
  assertPropertyContains(change.properties.Labels, "platformcore")
  assertPropertyContains(change.properties.Milestones, "Beta (2026-06-01)")
  assertPropertyContains(change.properties.Milestones, "GA")
  assert.deepEqual(change.properties["Related Initiative"], [
    { type: "primaryKey", value: "33ac57a9-f846-44e8-9889-91f061409343" },
  ])
  assert.match(change.pageContentMarkdown, /## Linked resources/)
  assert.match(change.pageContentMarkdown, /\[PRD\]\(https:\/\/www\.notion\.so\/prd\)/)
  assertPropertyContains(change.properties.Priority, "High")
  assertPropertyContains(change.properties["Progress %"], "100")
  assertPropertyContains(change.properties.Updated, "2026-06-30")
  assertPropertyContains(change.properties.Updated, "17:18")
  assertPropertyContains(change.properties["Last Update At"], "2026-07-01")
  assertPropertyContains(change.properties["Last Update At"], "16:17")
  assertPropertyContains(
    change.properties["Last Update Link"],
    fullProject.lastUpdate?.url ?? ""
  )
  assertPropertyContains(change.properties.Started, "14:15")
  assertPropertyContains(change.properties.Completed, "23:59")
  assertPropertyContains(change.properties["Start Date"], "2026-02-03")
  assertPropertyContains(change.properties["Target Date"], "2026-09-30")
  assertPropertyContains(change.properties.Archived, "Yes")
  assertPropertyContains(change.properties["Slug ID"], fullProject.slugId)
  assertPropertyContains(change.properties["Linear Project ID"], fullProject.id)
})

test("project transform omits absent optional values and keeps zero progress", () => {
  const minimal = projectToChange(minimalProject)
  assert.equal(minimal.key, minimalProject.id)
  assert.equal(minimal.upstreamUpdatedAt, minimalProject.updatedAt)
  assert.equal(minimal.pageContentMarkdown, "")
  assert.equal(minimal.properties.Status, undefined)
  assert.equal(minimal.properties["Status Category"], undefined)
  assert.equal(minimal.properties.Health, undefined)
  assert.equal(minimal.properties.Lead, undefined)
  assert.equal(minimal.properties.Teams, undefined)
  assert.equal(minimal.properties["Linked Resources"], undefined)
  assert.equal(minimal.properties.Summary, undefined)
  assert.equal(minimal.properties.Labels, undefined)
  assert.equal(minimal.properties.Milestones, undefined)
  assert.equal(minimal.properties["Related Initiative"], undefined)
  assert.equal(minimal.properties.Priority, undefined)
  assert.equal(minimal.properties["Progress %"], undefined)
  assert.equal(minimal.properties["Last Update At"], undefined)
  assert.equal(minimal.properties["Last Update Link"], undefined)
  assert.equal(minimal.properties["Start Date"], undefined)
  assert.equal(minimal.properties["Target Date"], undefined)
  assert.equal(minimal.properties.Started, undefined)
  assert.equal(minimal.properties.Completed, undefined)
  assert.equal(minimal.properties.Canceled, undefined)
  assert.equal(minimal.properties["Slug ID"], undefined)
  assertPropertyContains(minimal.properties.Archived, "No")

  const zero = projectToChange({ ...minimalProject, progress: 0 })
  assertPropertyContains(zero.properties["Progress %"], "0")
  const belowZero = projectToChange({ ...minimalProject, progress: -0.4 })
  assertPropertyContains(belowZero.properties["Progress %"], "0")
  const aboveOne = projectToChange({ ...minimalProject, progress: 3 })
  assertPropertyContains(aboveOne.properties["Progress %"], "100")
})

test("issue transform emits a full record, dedupes labels, and retains estimate zero", () => {
  const change = issueToChange(fullIssue)

  assert.equal(change.type, "upsert")
  assert.equal(change.key, fullIssue.id, "the immutable Linear UUID is the key")
  assert.equal(
    change.upstreamUpdatedAt,
    fullIssue.releases.nodes[0]?.updatedAt,
    "a newer release timestamp wins over issue.updatedAt"
  )
  assert.match(change.pageContentMarkdown, /Acceptance criteria/)
  assert.match(
    change.pageContentMarkdown,
    /Resume from the saved cursor/,
    "user markdown is escaped, not copied verbatim"
  )
  assertPropertyContains(change.properties.Title, fullIssue.title)
  assertPropertyContains(change.properties["Issue Key"], "ENG-321")
  assertPropertyContains(change.properties.Status, "In progress")
  assertPropertyContains(change.properties["Workflow Category"], "Started")
  assertPropertyContains(change.properties.Priority, "Urgent")
  assertPropertyContains(change.properties.Assignee, "Grace")
  assertPropertyContains(change.properties["Issue Link"], fullIssue.url)
  assertPropertyContains(change.properties.Team, "Engineering")
  assertPropertyContains(
    change.properties.Project,
    fullIssue.project?.id ?? "",
    // A relation reference, not the project name: the key is the projects
    // database primary key, which is the Linear project UUID.
  )
  assertPropertyContains(change.properties.Cycle, "Cycle 27")
  assert.equal(
    propertyText(change.properties.Labels).match(/backend/g)?.length,
    1,
    "duplicate labels collapse"
  )
  // Rich text keeps the name exactly as Linear reports it, commas and all,
  // because nothing has to match a declared option.
  assertPropertyContains(change.properties.Labels, "backend · api, internal · needs  review")
  assertPropertyContains(change.properties.Release, "10.4.8")
  assertPropertyContains(change.properties["Release stage"], "Planned")
  assert.equal(change.properties["Released at"], undefined)
  assertPropertyContains(change.properties["Release pipeline"], "iOS Clinician")
  assertPropertyContains(change.properties.Estimate, "0")
  assertPropertyContains(change.properties.Updated, "20:21")
  assertPropertyContains(change.properties.Started, "04:05")
  assertPropertyContains(change.properties.Completed, "22:23")
  assertPropertyContains(change.properties["Due Date"], "2026-07-15")
  assertPropertyContains(change.properties["Linear Issue ID"], fullIssue.id)
})

test("issue transform handles a minimal record and cycle-number fallback", () => {
  const change = issueToChange(minimalIssue)

  assert.equal(change.key, minimalIssue.id)
  assert.equal(change.upstreamUpdatedAt, minimalIssue.updatedAt)
  assert.equal(change.pageContentMarkdown, "")
  assert.equal(change.properties.Status, undefined)
  assert.equal(change.properties["Workflow Category"], undefined)
  assertPropertyContains(change.properties.Priority, "No Priority")
  assert.equal(change.properties.Assignee, undefined)
  assert.equal(change.properties.Team, undefined)
  assert.equal(change.properties.Project, undefined)
  assertPropertyContains(change.properties.Cycle, "Cycle 12")
  assert.equal(change.properties.Labels, undefined)
  assert.equal(change.properties.Release, undefined)
  assert.equal(change.properties["Release stage"], undefined)
  assert.equal(change.properties["Released at"], undefined)
  assert.equal(change.properties["Release pipeline"], undefined)
  assert.equal(change.properties.Estimate, undefined)
  assert.equal(change.properties["Due Date"], undefined)
  assert.equal(change.properties.Started, undefined)
  assert.equal(change.properties.Completed, undefined)
  assert.equal(change.properties.Canceled, undefined)
  assertPropertyContains(change.properties.Archived, "No")
})

test("every select value a transform emits is declared in the schema", () => {
  const issue = issueToChange({
    ...fullIssue,
    // "duplicate" is a real workflow state type in Linear and was missing from
    // the hardcoded category list this schema used to carry.
    state: { name: ISSUE_STATUS_OPTIONS[0]!, type: "duplicate" },
    team: { name: TEAM_OPTIONS[0]!, key: "T" },
  })
  assertSelectValuesAreDeclared("issues", issue.properties)

  assertPropertyContains(issue.properties["Workflow Category"], "Duplicate")

  const project = projectToChange({
    ...fullProject,
    status: { name: PROJECT_STATUS_OPTIONS[0]!, type: "started" },
    teams: {
      nodes: TEAM_OPTIONS.slice(0, 2).map((name) => ({ name, key: "T" })),
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    labels: {
      nodes: PROJECT_LABEL_OPTIONS.slice(0, 3).map((name) => ({ name })),
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  })
  assertSelectValuesAreDeclared("projects", project.properties)

  assertSelectValuesAreDeclared("projects", projectToChange(minimalProject).properties)
  assertSelectValuesAreDeclared("issues", issueToChange(minimalIssue).properties)
})

test("every Linear workflow state type maps to a declared category", () => {
  // WorkflowState.type is an open string in Linear's schema rather than an
  // enum, which is why this list is generated instead of hardcoded.
  const stateTypes = [
    "triage",
    "backlog",
    "unstarted",
    "started",
    "completed",
    "canceled",
    "duplicate",
  ]

  for (const type of stateTypes) {
    const category = workflowCategoryLabel(type)
    assert.ok(category, `${type} produced no category`)
    assert.ok(
      (WORKFLOW_CATEGORY_OPTIONS as readonly string[]).includes(category),
      `${type} maps to "${category}", which src/options.ts does not declare`
    )
  }
})

test("the option generator and the issue transform normalize names identically", () => {
  // scripts/generate-options.mts imports these same helpers, so whatever they
  // return is both what gets declared and what gets emitted.
  const rawTeam = "Growth,  EMEA"
  const rawStatus = "Ready, blocked"
  const rawProjectLabel = "Tier 1, internal"

  const change = issueToChange({
    ...fullIssue,
    state: { name: rawStatus, type: "started" },
    team: { name: rawTeam, key: "GRW" },
  })

  assert.deepEqual(selectValues(change.properties.Team), [
    teamSelectName({ name: rawTeam, key: "GRW" }),
  ])
  assert.deepEqual(selectValues(change.properties.Status), [
    selectName(rawStatus),
  ])

  const project = projectToChange({
    ...fullProject,
    teams: {
      nodes: [{ name: rawTeam, key: "GRW" }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    labels: {
      nodes: [{ name: rawProjectLabel }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  })

  assert.deepEqual(
    selectValues(project.properties.Labels),
    labelSelectNames([{ name: rawProjectLabel }])
  )
  assert.deepEqual(
    selectValues(project.properties.Teams),
    teamSelectNames([{ name: rawTeam, key: "GRW" }])
  )
})

test("case-only Linear statuses map to one Notion option", () => {
  for (const [linearName, notionName] of [
    ["In Progress", "In progress"],
    ["ToDo", "Todo"],
  ] as const) {
    const change = issueToChange({
      ...fullIssue,
      state: { name: linearName, type: "started" },
    })
    assert.deepEqual(selectValues(change.properties.Status), [notionName])
  }
})

test("issue page content is truncated like project page content", () => {
  const description = "d".repeat(MAX_PAGE_SECTION_CHARACTERS + 500)
  const change = issueToChange({ ...fullIssue, description })

  assert.ok(
    change.pageContentMarkdown.length < description.length,
    "an unbounded page body is a write hazard and a backfill payload risk"
  )
  assert.match(change.pageContentMarkdown, /was shortened in Notion/)
  assert.match(change.pageContentMarkdown, /Read the full description in Linear/)
})

test("issue sync changes turn soft-deleted records into immutable-key deletes", () => {
  assert.deepEqual(issueToSyncChange({ ...minimalIssue, trashed: true }), {
    type: "delete",
    key: minimalIssue.id,
  })

  const upsert = issueToSyncChange({ ...minimalIssue, trashed: false })
  assert.equal(upsert.type, "upsert")
  assert.equal(upsert.key, minimalIssue.id)
  assert.equal(upsert.upstreamUpdatedAt, minimalIssue.updatedAt)
})

test("first issue window starts at the epoch and leaves a consistency buffer", () => {
  const now = Date.parse("2026-06-30T12:00:00.000Z")

  assert.deepEqual(incrementalWindow(undefined, now), {
    since: INITIAL_WATERMARK,
    until: new Date(now - CONSISTENCY_BUFFER_MS).toISOString(),
  })
})

test("release freshness window starts at a lookback, not the epoch", () => {
  const now = Date.parse("2026-06-30T12:00:00.000Z")
  const lookback = new Date(now - RELEASE_SYNC_LOOKBACK_MS).toISOString()

  assert.deepEqual(incrementalWindow(undefined, now, lookback), {
    since: lookback,
    until: new Date(now - CONSISTENCY_BUFFER_MS).toISOString(),
  })
})

test("issue window remains pinned across every cursor page", () => {
  const state = {
    since: "2026-06-01T00:00:00.000Z",
    until: "2026-06-30T11:59:45.000Z",
    after: "issue-page-2",
    seenCursors: ["issue-page-2"],
  }

  assert.deepEqual(
    incrementalWindow(state, Date.parse("2027-01-01T00:00:00.000Z")),
    {
      since: state.since,
      until: state.until,
    }
  )
})

test("terminal issue watermark overlaps the completed window and validates it", () => {
  const until = "2026-06-30T12:00:00.000Z"
  assert.equal(
    nextWatermark(until),
    new Date(Date.parse(until) - WATERMARK_OVERLAP_MS).toISOString()
  )
  assert.equal(
    nextWatermark("1970-01-01T00:00:30.000Z"),
    INITIAL_WATERMARK,
    "the overlap clamps at the epoch"
  )
  assert.throws(() => nextWatermark("not-a-timestamp"), /invalid end time/)
})

test("cursor state rejects missing, immediate, and longer repeated cursors", () => {
  assert.throws(
    () => nextCursorState(undefined, undefined, "projects"),
    /Linear projects pagination is missing next cursor/
  )

  const first = nextCursorState(undefined, "cursor-a", "projects")
  assert.deepEqual(first, {
    after: "cursor-a",
    seenCursors: ["cursor-a"],
    pages: 1,
  })

  assert.throws(
    () => nextCursorState(first, "cursor-a", "projects"),
    /Linear projects pagination repeated cursor/
  )

  const second = nextCursorState(first, "cursor-b", "projects")
  assert.deepEqual(second, {
    after: "cursor-b",
    seenCursors: ["cursor-a", "cursor-b"],
    pages: 2,
  })
  assert.throws(
    () => nextCursorState(second, "cursor-a", "projects"),
    /Linear projects pagination repeated cursor/,
    "serialized cursor history catches A -> B -> A loops"
  )
})

test("cursor history is bounded and a runaway cycle still terminates", () => {
  // An issue backfill runs into the thousands of pages, and every cursor is
  // persisted between executions, so the history cannot grow without limit.
  let state = nextCursorState(undefined, "cursor-0", "issues")
  for (let page = 1; page < RETAINED_CURSORS + 25; page += 1) {
    state = nextCursorState(state, `cursor-${page}`, "issues")
  }

  assert.equal(state.seenCursors.length, RETAINED_CURSORS)
  assert.equal(state.pages, RETAINED_CURSORS + 25)
  assert.equal(
    state.seenCursors.includes("cursor-0"),
    false,
    "the oldest cursors roll out of the retained window"
  )
  assert.deepEqual(
    nextCursorState(state, "cursor-0", "issues").after,
    "cursor-0",
    "a cursor outside the window no longer trips repeat detection"
  )

  // Which is why the page counter is the backstop for a cycle that loops.
  assert.throws(
    () =>
      nextCursorState(
        { after: "cursor-x", seenCursors: [], pages: MAX_CYCLE_PAGES },
        "cursor-y",
        "issues"
      ),
    new RegExp(`exceeded ${MAX_CYCLE_PAGES} pages in one cycle`)
  )
})

test("initiative transform surfaces its update and contributing projects", () => {
  const change = initiativeToChange(fullInitiative)

  assert.equal(change.type, "upsert")
  assert.equal(
    change.key,
    fullInitiative.id,
    "the immutable Linear UUID is the key"
  )
  assert.equal(
    "upstreamUpdatedAt" in change,
    false,
    "derived project membership is always refreshed by the hourly replacement"
  )
  assert.match(change.pageContentMarkdown, /^## Latest update/)
  assert.match(change.pageContentMarkdown, /Updated by Nan · 2026-07-02/)
  assert.match(
    change.pageContentMarkdown,
    /The remaining enterprise blockers now have committed owners\./
  )
  assert.match(change.pageContentMarkdown, /## Contributing projects \(2\)/)
  assert.match(change.pageContentMarkdown, /API Foundations.*\(archived\)/)
  assert.match(change.pageContentMarkdown, /Mobile Reliability/)
  assert.doesNotMatch(change.pageContentMarkdown, /Duplicate API Foundations/)
  assert.doesNotMatch(change.pageContentMarkdown, /Discarded experiment/)
  assert.match(change.pageContentMarkdown, /## Initiative overview/)
  assert.ok(
    change.pageContentMarkdown.indexOf("## Latest update") <
      change.pageContentMarkdown.indexOf("## Contributing projects") &&
      change.pageContentMarkdown.indexOf("## Contributing projects") <
        change.pageContentMarkdown.indexOf("## Initiative overview")
  )
  assertPropertyContains(change.properties.Name, fullInitiative.name)
  assertPropertyContains(change.properties.Status, "Active")
  assertPropertyContains(change.properties.Health, "Off Track")
  assertPropertyContains(change.properties.Owner, "Katherine")
  assertPropertyContains(
    change.properties["Initiative Link"],
    fullInitiative.url
  )
  assertPropertyContains(change.properties.Updated, "20:21")
  assertPropertyContains(change.properties["Last Update At"], "2026-07-02")
  assertPropertyContains(change.properties["Last Update At"], "18:19")
  assertPropertyContains(
    change.properties["Last Update Link"],
    fullInitiative.lastUpdate?.url ?? ""
  )
  assertPropertyContains(change.properties["Project Count"], "2")
  assertPropertyContains(change.properties.Started, "11:12")
  assertPropertyContains(change.properties.Completed, "14:15")
  assertPropertyContains(change.properties["Target Date"], "2026-12-31")
  assertPropertyContains(change.properties["Slug ID"], fullInitiative.slugId)
  assertPropertyContains(
    change.properties["Linear Initiative ID"],
    fullInitiative.id
  )
  assertPropertyContains(change.properties.Archived, "Yes")
})

test("initiative transform omits absent optional values", () => {
  const change = initiativeToChange(minimalInitiative)

  assert.equal(change.key, minimalInitiative.id)
  assert.equal("upstreamUpdatedAt" in change, false)
  assert.match(change.pageContentMarkdown, /^## Contributing projects \(0\)/)
  assert.match(
    change.pageContentMarkdown,
    /No contributing projects visible to this Linear API key\./
  )
  assert.equal(change.properties.Status, undefined)
  assert.equal(change.properties.Health, undefined)
  assert.equal(change.properties.Owner, undefined)
  assertPropertyContains(change.properties["Project Count"], "0")
  assert.equal(change.properties["Last Update At"], undefined)
  assert.equal(change.properties["Last Update Link"], undefined)
  assert.equal(change.properties["Target Date"], undefined)
  assert.equal(change.properties.Started, undefined)
  assert.equal(change.properties.Completed, undefined)
  assert.equal(change.properties["Slug ID"], undefined)
  assertPropertyContains(change.properties.Archived, "No")
})

type GraphQLRequest = {
  query: string
  variables: Record<string, unknown>
}

type FetchCall = {
  url: string
  method: string | undefined
  authorization: string | null
  accept: string | null
  contentType: string | null
  redirect: RequestRedirect | undefined
  request: GraphQLRequest
}

function installQueuedGraphQLFetch(
  responses: Array<Response | (() => Response)>,
  calls: FetchCall[]
): void {
  globalThis.fetch = (async (input, init) => {
    const headers = new Headers(init?.headers)
    const request = JSON.parse(String(init?.body)) as GraphQLRequest
    calls.push({
      url: String(input),
      method: init?.method,
      authorization: headers.get("authorization"),
      accept: headers.get("accept"),
      contentType: headers.get("content-type"),
      redirect: init?.redirect,
      request,
    })

    const next = responses.shift()
    assert.ok(next, `unexpected GraphQL request: ${request.query}`)
    return typeof next === "function" ? next() : next
  }) as typeof fetch
}

const noPacing = async (): Promise<void> => {}

function projectConnection(
  nodes: LinearProject[],
  hasNextPage: boolean,
  endCursor: string | null
): Response {
  return Response.json({
    data: { projects: { nodes, pageInfo: { hasNextPage, endCursor } } },
  })
}

function projectMilestonesConnection(
  nodes: Array<{ name: string | null; targetDate: string | null }>,
  hasNextPage: boolean,
  endCursor: string | null
): Response {
  return Response.json({
    data: {
      project: {
        projectMilestones: { nodes, pageInfo: { hasNextPage, endCursor } },
      },
    },
  })
}

function initiativeConnection(
  nodes: LinearInitiative[],
  hasNextPage: boolean,
  endCursor: string | null
): Response {
  return Response.json({
    data: { initiatives: { nodes, pageInfo: { hasNextPage, endCursor } } },
  })
}

function initiativeProjectsConnection(
  nodes: LinearInitiativeProject[],
  hasNextPage: boolean,
  endCursor: string | null
): Response {
  return Response.json({
    data: {
      initiative: {
        projects: { nodes, pageInfo: { hasNextPage, endCursor } },
      },
    },
  })
}

function initiativeProject(
  id: string,
  name: string,
  overrides: Partial<LinearInitiativeProject> = {}
): LinearInitiativeProject {
  return {
    id,
    name,
    url: `https://linear.app/acme/project/${id}`,
    updatedAt: "2026-06-30T00:00:00Z",
    archivedAt: null,
    trashed: false,
    ...overrides,
  }
}

function issueConnection(
  nodes: LinearIssue[],
  hasNextPage: boolean,
  endCursor: string | null
): Response {
  return Response.json({
    data: { issues: { nodes, pageInfo: { hasNextPage, endCursor } } },
  })
}

function releaseConnection(
  nodes: LinearRelease[],
  hasNextPage: boolean,
  endCursor: string | null
): Response {
  return Response.json({
    data: { releases: { nodes, pageInfo: { hasNextPage, endCursor } } },
  })
}

function releaseIssuesConnection(
  nodes: Array<{ id: string }>,
  hasNextPage: boolean,
  endCursor: string | null
): Response {
  return Response.json({
    data: {
      release: {
        issues: { nodes, pageInfo: { hasNextPage, endCursor } },
      },
    },
  })
}

test("GraphQL client uses the endpoint, POST body, and direct API-key authorization", async () => {
  process.env.LINEAR_API_KEY = "lin_api_test-secret"
  const calls: FetchCall[] = []
  installQueuedGraphQLFetch(
    [projectConnection([fullProject], false, null)],
    calls
  )

  const page = await fetchProjectsPage(noPacing)

  assert.equal(page.resources[0]?.id, fullProject.id)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.url, "https://api.linear.app/graphql")
  assert.equal(calls[0]?.method, "POST")
  assert.equal(calls[0]?.authorization, "lin_api_test-secret")
  assert.doesNotMatch(calls[0]?.authorization ?? "", /^Bearer\s/i)
  assert.equal(calls[0]?.accept, "application/json")
  assert.equal(calls[0]?.contentType, "application/json")
  assert.equal(calls[0]?.redirect, "error")
  const projectQuery = calls[0]?.request.query ?? ""
  assert.match(projectQuery, /query Projects/)
  assert.match(projectQuery, /orderBy: \$orderBy/)
  assert.match(
    projectQuery,
    /lastUpdate\s*{[\s\S]*?body[\s\S]*?createdAt[\s\S]*?updatedAt[\s\S]*?url[\s\S]*?user\s*{[\s\S]*?name[\s\S]*?displayName/
  )
  assert.match(projectQuery, /teams\(first: 10\)/)
  assert.match(projectQuery, /labels\(first: 10\)/)
  assert.match(projectQuery, /projectMilestones\(first: 10\)/)
  assert.match(projectQuery, /initiatives\(first: 5\)/)
  assert.match(projectQuery, /externalLinks\(first: 10\)/)
  assert.match(projectQuery, /documents\(first: 10\)/)
  assert.match(projectQuery, /lead\s*{[\s\S]*?email/)
  assert.deepEqual(calls[0]?.request.variables, { orderBy: "createdAt" })
})

test("project and initiative connections expose durable cursor pages", async () => {
  process.env.LINEAR_API_KEY = "test-key"
  const calls: FetchCall[] = []
  installQueuedGraphQLFetch(
    [
      projectConnection([fullProject], true, "project-page-2"),
      projectConnection([minimalProject], false, null),
      initiativeConnection([fullInitiative], true, "initiative-page-2"),
      initiativeConnection([minimalInitiative], false, null),
    ],
    calls
  )

  const firstProjects = await fetchProjectsPage(noPacing)
  const finalProjects = await fetchProjectsPage(noPacing, {
    after: firstProjects.nextCursor,
  })
  const firstInitiatives = await fetchInitiativesPage(noPacing)
  const finalInitiatives = await fetchInitiativesPage(
    noPacing,
    firstInitiatives.nextCursor
  )

  assert.deepEqual(firstProjects, {
    resources: [fullProject],
    hasMore: true,
    nextCursor: "project-page-2",
  })
  assert.deepEqual(finalProjects, {
    resources: [minimalProject],
    hasMore: false,
    nextCursor: undefined,
  })
  assert.equal(firstInitiatives.resources[0]?.id, fullInitiative.id)
  assert.deepEqual(
    firstInitiatives.resources[0]?.projects.nodes.map((project) => project.id),
    ["project-mobile", "project-api", "project-trashed"]
  )
  assert.equal(firstInitiatives.hasMore, true)
  assert.equal(firstInitiatives.nextCursor, "initiative-page-2")
  assert.deepEqual(finalInitiatives, {
    resources: [minimalInitiative],
    hasMore: false,
    nextCursor: undefined,
  })
  assert.deepEqual(
    calls.map((call) => call.request.variables),
    [
      { orderBy: "createdAt" },
      { orderBy: "createdAt", after: "project-page-2" },
      {},
      { after: "initiative-page-2" },
    ]
  )
  assert.match(calls[0]?.request.query ?? "", /orderBy: \$orderBy/)
  const initiativeQuery = calls[2]?.request.query ?? ""
  assert.match(initiativeQuery, /orderBy: createdAt/)
  assert.match(initiativeQuery, /initiatives\([\s\S]*?first: 20/)
  assert.match(
    initiativeQuery,
    /lastUpdate\s*{[\s\S]*?body[\s\S]*?user\s*{[\s\S]*?name[\s\S]*?displayName/
  )
  assert.match(
    initiativeQuery,
    /projects\([\s\S]*?first: 50[\s\S]*?includeArchived: true[\s\S]*?includeSubInitiatives: true/
  )
  assert.doesNotMatch(initiativeQuery, /\bpriority\b/)
  assert.doesNotMatch(initiativeQuery, /\bcanceledAt\b/)
})

test("initiative projects paginate completely, dedupe by ID, and pace every request", async () => {
  process.env.LINEAR_API_KEY = "test-key"
  const calls: FetchCall[] = []
  let pacingCount = 0
  const alpha = initiativeProject("alpha", "Alpha")
  const beta = initiativeProject("beta", "Beta")
  const gamma = initiativeProject("gamma", "Gamma")
  const initiative: LinearInitiative = {
    ...minimalInitiative,
    projects: {
      nodes: [alpha],
      pageInfo: { hasNextPage: true, endCursor: "project-page-2" },
    },
  }

  installQueuedGraphQLFetch(
    [
      initiativeConnection([initiative], false, null),
      initiativeProjectsConnection(
        [beta, { ...alpha, name: "Duplicate Alpha" }],
        true,
        "project-page-3"
      ),
      initiativeProjectsConnection([gamma], false, null),
    ],
    calls
  )

  const page = await fetchInitiativesPage(async () => {
    pacingCount++
  })

  assert.equal(pacingCount, 3)
  assert.deepEqual(
    page.resources[0]?.projects.nodes.map((project) => project.id),
    ["alpha", "beta", "gamma"]
  )
  assert.deepEqual(
    calls.map((call) => call.request.variables),
    [
      {},
      { initiativeId: initiative.id, after: "project-page-2" },
      { initiativeId: initiative.id, after: "project-page-3" },
    ]
  )
  assert.match(calls[1]?.request.query ?? "", /query InitiativeProjects/)
  assert.match(
    calls[1]?.request.query ?? "",
    /includeArchived: true[\s\S]*includeSubInitiatives: true/
  )
})

test("initiative project pagination rejects missing and repeated cursors", async (t) => {
  process.env.LINEAR_API_KEY = "test-key"
  const project = initiativeProject("alpha", "Alpha")

  await t.test("missing cursor", async () => {
    process.env.LINEAR_API_KEY = "test-key"
    const initiative: LinearInitiative = {
      ...minimalInitiative,
      projects: {
        nodes: [project],
        pageInfo: { hasNextPage: true, endCursor: null },
      },
    }
    installQueuedGraphQLFetch(
      [initiativeConnection([initiative], false, null)],
      []
    )

    await assert.rejects(
      () => fetchInitiativesPage(noPacing),
      /projects pagination is missing endCursor/
    )
  })

  await t.test("repeated cursor", async () => {
    process.env.LINEAR_API_KEY = "test-key"
    let pacingCount = 0
    const initiative: LinearInitiative = {
      ...minimalInitiative,
      projects: {
        nodes: [project],
        pageInfo: { hasNextPage: true, endCursor: "project-page-2" },
      },
    }
    installQueuedGraphQLFetch(
      [
        initiativeConnection([initiative], false, null),
        initiativeProjectsConnection([], true, "project-page-2"),
      ],
      []
    )

    await assert.rejects(
      () =>
        fetchInitiativesPage(async () => {
          pacingCount++
        }),
      /projects pagination repeated cursor/
    )
    assert.equal(pacingCount, 2)
  })
})

test("nested initiative project safety bound rejects incomplete snapshots", async () => {
  process.env.LINEAR_API_KEY = "test-key"
  let pacingCount = 0
  const initiative: LinearInitiative = {
    ...minimalInitiative,
    projects: {
      nodes: [],
      pageInfo: { hasNextPage: true, endCursor: "project-page-1" },
    },
  }
  const followUpPages = Array.from(
    { length: MAX_NESTED_INITIATIVE_PROJECT_REQUESTS_PER_PAGE },
    (_, index) =>
      initiativeProjectsConnection(
        [initiativeProject(`project-${index + 1}`, `Project ${index + 1}`)],
        true,
        `project-page-${index + 2}`
      )
  )
  installQueuedGraphQLFetch(
    [initiativeConnection([initiative], false, null), ...followUpPages],
    []
  )

  await assert.rejects(
    () =>
      fetchInitiativesPage(async () => {
        pacingCount++
      }),
    new RegExp(
      `exceeded ${MAX_NESTED_INITIATIVE_PROJECT_REQUESTS_PER_PAGE} follow-up requests`
    )
  )
  assert.equal(pacingCount, 1 + MAX_NESTED_INITIATIVE_PROJECT_REQUESTS_PER_PAGE)
})

test("issue requests pin the incremental updatedAt window in GraphQL variables", async () => {
  process.env.LINEAR_API_KEY = "test-key"
  const calls: FetchCall[] = []
  installQueuedGraphQLFetch(
    [issueConnection([minimalIssue], false, null)],
    calls
  )

  const page = await fetchIssuesPage(noPacing, {
    after: "issue-page-3",
    updatedSince: "2026-06-01T00:00:00.000Z",
    updatedBefore: "2026-07-01T00:00:00.000Z",
  })

  assert.equal(page.resources[0]?.id, minimalIssue.id)
  assert.deepEqual(calls[0]?.request.variables, {
    orderBy: "updatedAt",
    after: "issue-page-3",
    filter: {
      updatedAt: {
        gte: "2026-06-01T00:00:00.000Z",
        lt: "2026-07-01T00:00:00.000Z",
      },
    },
  })
})

test("project requests pin the incremental updatedAt window in GraphQL variables", async () => {
  process.env.LINEAR_API_KEY = "test-key"
  const calls: FetchCall[] = []
  installQueuedGraphQLFetch(
    [projectConnection([minimalProject], false, null)],
    calls
  )

  const page = await fetchProjectsPage(noPacing, {
    after: "project-page-3",
    updatedSince: "2026-06-01T00:00:00.000Z",
    updatedBefore: "2026-07-01T00:00:00.000Z",
  })

  assert.equal(page.resources[0]?.id, minimalProject.id)
  assert.deepEqual(calls[0]?.request.variables, {
    orderBy: "updatedAt",
    after: "project-page-3",
    filter: {
      updatedAt: {
        gte: "2026-06-01T00:00:00.000Z",
        lt: "2026-07-01T00:00:00.000Z",
      },
    },
  })
})

test("project sync changes turn soft-deleted records into deletes", () => {
  assert.deepEqual(projectToSyncChange({ ...minimalProject, trashed: true }), {
    type: "delete",
    key: minimalProject.id,
  })

  const upsert = projectToSyncChange(minimalProject)
  assert.equal(upsert.type, "upsert")
  assert.equal(upsert.key, minimalProject.id)
})

test("connection pagination rejects a missing next cursor", async () => {
  process.env.LINEAR_API_KEY = "test-key"
  installQueuedGraphQLFetch([projectConnection([], true, null)], [])

  await assert.rejects(
    () => fetchProjectsPage(noPacing),
    /Linear projects pagination response is missing endCursor/
  )
})

test("connection pagination rejects a repeated cursor", async () => {
  process.env.LINEAR_API_KEY = "test-key"
  installQueuedGraphQLFetch([projectConnection([], true, "project-page-2")], [])

  await assert.rejects(
    () => fetchProjectsPage(noPacing, { after: "project-page-2" }),
    /Linear projects pagination repeated cursor/
  )
})

test("GraphQL errors are rejected", async () => {
  process.env.LINEAR_API_KEY = "test-key"
  installQueuedGraphQLFetch(
    [
      Response.json({
        errors: [{ message: "Projects are unavailable", type: "INTERNAL" }],
      }),
    ],
    []
  )

  await assert.rejects(
    () => fetchProjectsPage(noPacing),
    /Linear GraphQL error: Projects are unavailable/
  )
})

test("GraphQL partial data is rejected instead of silently syncing it", async () => {
  process.env.LINEAR_API_KEY = "test-key"
  installQueuedGraphQLFetch(
    [
      Response.json({
        data: {
          projects: {
            nodes: [fullProject],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
        errors: [{ message: "One project could not be resolved" }],
      }),
    ],
    []
  )

  await assert.rejects(
    () => fetchProjectsPage(noPacing),
    /Linear GraphQL error: One project could not be resolved/
  )
})

test("HTTP 429 preserves Retry-After in Workers RateLimitError", async () => {
  process.env.LINEAR_API_KEY = "test-key"
  installQueuedGraphQLFetch(
    [new Response("", { status: 429, headers: { "Retry-After": "7" } })],
    []
  )

  await assert.rejects(
    () => fetchProjectsPage(noPacing),
    (error: unknown) => {
      assert.ok(error instanceof RateLimitError)
      assert.equal(error.retryAfter, 7)
      return true
    }
  )
})

test("HTTP 400 GraphQL RATELIMITED uses Linear reset headers", async () => {
  process.env.LINEAR_API_KEY = "test-key"
  const now = Date.parse("2026-06-30T12:00:00Z")
  Date.now = () => now
  installQueuedGraphQLFetch(
    [
      Response.json(
        {
          errors: [
            {
              message: "Request budget exhausted",
              extensions: { code: "RATE_LIMITED" },
            },
          ],
        },
        {
          status: 400,
          headers: {
            "x-ratelimit-requests-remaining": "0",
            "x-ratelimit-requests-reset": String(now + 11_000),
          },
        }
      ),
    ],
    []
  )

  await assert.rejects(
    () => fetchProjectsPage(noPacing),
    (error: unknown) => {
      assert.ok(error instanceof RateLimitError)
      assert.equal(error.retryAfter, 11)
      return true
    }
  )
})

test("nested issue labels are fully paginated, deduped, and paced per request", async () => {
  process.env.LINEAR_API_KEY = "test-key"
  const calls: FetchCall[] = []
  let pacingCount = 0
  const issueWithManyLabels: LinearIssue = {
    ...minimalIssue,
    labels: {
      nodes: [{ name: "bug" }, { name: "api" }, { name: "bug" }],
      pageInfo: { hasNextPage: true, endCursor: "label-page-2" },
    },
  }

  installQueuedGraphQLFetch(
    [
      issueConnection([issueWithManyLabels], false, null),
      Response.json({
        data: {
          issue: {
            labels: {
              nodes: [{ name: "api" }, { name: "backend" }],
              pageInfo: {
                hasNextPage: true,
                endCursor: "label-page-3",
              },
            },
          },
        },
      }),
      Response.json({
        data: {
          issue: {
            labels: {
              nodes: [{ name: "backend" }, { name: "customer" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      }),
    ],
    calls
  )

  const page = await fetchIssuesPage(async () => {
    pacingCount++
  })

  assert.equal(pacingCount, 3, "the issue page and both label pages are paced")
  assert.deepEqual(
    page.resources[0]?.labels.nodes.map((label) => label.name),
    ["bug", "api", "backend", "customer"]
  )
  assert.equal(calls.length, 3)
  assert.match(calls[0]?.request.query ?? "", /query Issues/)
  assert.match(
    calls[0]?.request.query ?? "",
    // Issues and initiatives no longer share a page-size constant, so tuning
    // the issue label page cannot silently retune the initiative queries.
    /labels\(first: 20, includeArchived: true\)/
  )
  assert.match(
    calls[0]?.request.query ?? "",
    /releases\(first: 10, orderBy: updatedAt, includeArchived: true\)/
  )
  assert.deepEqual(calls[0]?.request.variables, { orderBy: "createdAt" })
  assert.match(calls[1]?.request.query ?? "", /query IssueLabels/)
  assert.match(calls[1]?.request.query ?? "", /includeArchived: true/)
  assert.match(calls[2]?.request.query ?? "", /query IssueLabels/)
  assert.deepEqual(calls[1]?.request.variables, {
    issueId: issueWithManyLabels.id,
    after: "label-page-2",
  })
  assert.deepEqual(calls[2]?.request.variables, {
    issueId: issueWithManyLabels.id,
    after: "label-page-3",
  })
})

test("nested label safety bound rejects instead of returning truncated labels", async () => {
  process.env.LINEAR_API_KEY = "test-key"
  let pacingCount = 0
  const issue: LinearIssue = {
    ...minimalIssue,
    labels: {
      nodes: [],
      pageInfo: { hasNextPage: true, endCursor: "label-page-1" },
    },
  }
  const followUpPages = Array.from({ length: 20 }, (_, index) =>
    Response.json({
      data: {
        issue: {
          labels: {
            nodes: [{ name: `label-${index + 1}` }],
            pageInfo: {
              hasNextPage: true,
              endCursor: `label-page-${index + 2}`,
            },
          },
        },
      },
    })
  )
  installQueuedGraphQLFetch(
    [issueConnection([issue], false, null), ...followUpPages],
    []
  )

  await assert.rejects(
    () =>
      fetchIssuesPage(async () => {
        pacingCount++
      }),
    /exceeded 20 follow-up requests/
  )
  assert.equal(
    pacingCount,
    21,
    "one issue request plus exactly 20 label requests"
  )
})

test("issue transform writes Released at when the train has shipped", () => {
  const change = issueToChange({
    ...fullIssue,
    releases: {
      nodes: [
        {
          id: "rel-ios-1047",
          name: "10.4.7",
          version: "10.4.7",
          completedAt: "2026-06-11T16:00:00.000Z",
          updatedAt: "2026-06-11T16:00:00.000Z",
          archivedAt: null,
          trashed: false,
          stage: { name: "Released", type: "completed" },
          pipeline: { name: "iOS Clinician" },
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  })

  assertPropertyContains(change.properties.Release, "10.4.7")
  assertPropertyContains(change.properties["Release stage"], "Released")
  assertPropertyContains(change.properties["Released at"], "2026-06-11")
  assert.deepEqual(selectValues(change.properties["Release stage"]), [
    "Released",
  ])
})

test("release issues paginate, then related issues are fetched by id", async () => {
  process.env.LINEAR_API_KEY = "test-key"
  const calls: FetchCall[] = []
  let pacingCount = 0
  const release: LinearRelease = {
    id: "rel-ios-1048",
    updatedAt: "2026-06-30T21:00:00.000Z",
    issues: {
      nodes: [{ id: "issue-1" }],
      pageInfo: { hasNextPage: true, endCursor: "release-issue-2" },
    },
  }

  installQueuedGraphQLFetch(
    [
      releaseConnection([release], false, null),
      releaseIssuesConnection([{ id: "issue-2" }, { id: "issue-1" }], false, null),
      issueConnection(
        [
          { ...minimalIssue, id: "issue-1" },
          { ...minimalIssue, id: "issue-2" },
        ],
        false,
        null
      ),
    ],
    calls
  )

  const page = await fetchReleasesPage(async () => {
    pacingCount++
  })
  assert.deepEqual(
    page.resources[0]?.issues.nodes.map((issue) => issue.id),
    ["issue-1", "issue-2"]
  )
  assert.equal(pacingCount, 2, "the release page and the issue-id page are paced")
  assert.match(calls[0]?.request.query ?? "", /query Releases/)
  assert.match(calls[0]?.request.query ?? "", /issues\(first: 50, includeArchived: true\)/)
  assert.match(calls[1]?.request.query ?? "", /query ReleaseIssues/)

  const related = await fetchIssuesByIds(async () => {
    pacingCount++
  }, ["issue-1", "issue-2", "issue-1"])
  assert.deepEqual(
    related.map((issue) => issue.id),
    ["issue-1", "issue-2"]
  )
  assert.equal(pacingCount, 3)
  assert.deepEqual(calls[2]?.request.variables, {
    orderBy: "createdAt",
    filter: { id: { in: ["issue-1", "issue-2"] } },
  })
})

test("nested release-issue safety bound rejects instead of returning a truncated train", async () => {
  process.env.LINEAR_API_KEY = "test-key"
  const release: LinearRelease = {
    id: "rel-huge",
    updatedAt: "2026-06-30T21:00:00.000Z",
    issues: {
      nodes: [],
      pageInfo: { hasNextPage: true, endCursor: "release-issue-1" },
    },
  }
  const followUpPages = Array.from(
    { length: MAX_NESTED_RELEASE_ISSUE_REQUESTS_PER_PAGE },
    (_, index) =>
      releaseIssuesConnection(
        [{ id: `issue-${index + 1}` }],
        true,
        `release-issue-${index + 2}`
      )
  )
  installQueuedGraphQLFetch(
    [releaseConnection([release], false, null), ...followUpPages],
    []
  )

  await assert.rejects(
    () => fetchReleasesPage(async () => {}),
    /exceeded 80 follow-up requests/
  )
})

test("fetchIssuesByIds is a no-op for an empty id list", async () => {
  process.env.LINEAR_API_KEY = "test-key"
  let called = false
  globalThis.fetch = (async () => {
    called = true
    return Response.json({ data: {} })
  }) as typeof fetch

  assert.deepEqual(await fetchIssuesByIds(async () => {}, []), [])
  assert.equal(called, false)
})

// A release project defines a milestone per dev workstream and finishes with
// EA and GA. Truncating at the nested page size drops exactly the two dates
// downstream launch automations read.
test("project milestones paginate past the nested page size", async () => {
  process.env.LINEAR_API_KEY = "test-key"
  let pacingCount = 0
  const calls: FetchCall[] = []
  const project: LinearProject = {
    ...minimalProject,
    projectMilestones: {
      nodes: Array.from({ length: 10 }, (_, index) => ({
        name: `Dev - Workstream ${index + 1}`,
        targetDate: "2026-08-31",
      })),
      pageInfo: { hasNextPage: true, endCursor: "milestone-page-2" },
    },
  }
  installQueuedGraphQLFetch(
    [
      projectConnection([project], false, null),
      projectMilestonesConnection(
        [{ name: "Dev Complete", targetDate: "2026-11-30" }],
        true,
        "milestone-page-3"
      ),
      projectMilestonesConnection(
        [
          { name: "Early Access (start)", targetDate: "2026-11-18" },
          { name: "General Availability (start)", targetDate: "2026-11-30" },
        ],
        false,
        null
      ),
    ],
    calls
  )

  const page = await fetchProjectsPage(async () => {
    pacingCount++
  })

  const milestones = page.resources[0]?.projectMilestones.nodes ?? []
  assert.equal(milestones.length, 13)
  assert.deepEqual(
    milestones.slice(-2).map((milestone) => milestone.name),
    ["Early Access (start)", "General Availability (start)"]
  )
  assert.equal(
    pacingCount,
    3,
    "the project page and both milestone pages are paced"
  )
  assert.equal(calls.length, 3)
  assert.match(calls[0]?.request.query ?? "", /query Projects/)
  assert.match(calls[1]?.request.query ?? "", /query ProjectMilestones/)
  assert.match(
    calls[1]?.request.query ?? "",
    /projectMilestones\(first: 10, after: \$after\)/
  )
  assert.deepEqual(calls[1]?.request.variables, {
    projectId: minimalProject.id,
    after: "milestone-page-2",
  })
  assert.deepEqual(calls[2]?.request.variables, {
    projectId: minimalProject.id,
    after: "milestone-page-3",
  })

  const change = projectToChange(page.resources[0] as LinearProject)
  assertPropertyContains(
    change.properties.Milestones,
    "Early Access (start) (2026-11-18)"
  )
  assertPropertyContains(
    change.properties.Milestones,
    "General Availability (start) (2026-11-30)"
  )
})

test("nested project milestone pagination rejects unusable cursors", async (t) => {
  await t.test("missing cursor", async () => {
    process.env.LINEAR_API_KEY = "test-key"
    const project: LinearProject = {
      ...minimalProject,
      projectMilestones: {
        nodes: [{ name: "Early Access", targetDate: "2026-11-18" }],
        pageInfo: { hasNextPage: true, endCursor: null },
      },
    }
    installQueuedGraphQLFetch([projectConnection([project], false, null)], [])

    await assert.rejects(
      () => fetchProjectsPage(noPacing),
      /projectMilestones pagination is missing endCursor/
    )
  })

  await t.test("repeated cursor", async () => {
    process.env.LINEAR_API_KEY = "test-key"
    const project: LinearProject = {
      ...minimalProject,
      projectMilestones: {
        nodes: [],
        pageInfo: { hasNextPage: true, endCursor: "milestone-page-2" },
      },
    }
    installQueuedGraphQLFetch(
      [
        projectConnection([project], false, null),
        projectMilestonesConnection([], true, "milestone-page-2"),
      ],
      []
    )

    await assert.rejects(
      () => fetchProjectsPage(noPacing),
      /projectMilestones pagination repeated cursor/
    )
  })
})

test("nested milestone safety bound rejects instead of returning truncated milestones", async () => {
  process.env.LINEAR_API_KEY = "test-key"
  let pacingCount = 0
  const project: LinearProject = {
    ...minimalProject,
    projectMilestones: {
      nodes: [],
      pageInfo: { hasNextPage: true, endCursor: "milestone-page-1" },
    },
  }
  const followUpPages = Array.from(
    { length: MAX_NESTED_MILESTONE_REQUESTS_PER_PAGE },
    (_, index) =>
      projectMilestonesConnection(
        [{ name: `Milestone ${index + 1}`, targetDate: null }],
        true,
        `milestone-page-${index + 2}`
      )
  )
  installQueuedGraphQLFetch(
    [projectConnection([project], false, null), ...followUpPages],
    []
  )

  await assert.rejects(
    () =>
      fetchProjectsPage(async () => {
        pacingCount++
      }),
    new RegExp(
      `exceeded ${MAX_NESTED_MILESTONE_REQUESTS_PER_PAGE} follow-up requests`
    )
  )
  assert.equal(pacingCount, 1 + MAX_NESTED_MILESTONE_REQUESTS_PER_PAGE)
})
