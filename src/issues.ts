// Linear issues — the core engineering work visible to cross-functional teams.
// Keep the schema and transform property order in sync.

import * as Schema from "@notionhq/workers/schema"
import * as Builder from "@notionhq/workers/builder"
import { notionIcon } from "@notionhq/workers"

import type { LinearIssue } from "./linear.js"
import {
  cycleDisplay,
  dateOnly,
  dateTime,
  declaredSelectName,
  labelSummary,
  latestTimestamp,
  personDisplay,
  pickCurrentRelease,
  priorityLabel,
  releaseDisplayName,
  selectName,
  teamSelectName,
  workflowCategoryLabel,
} from "./helpers.js"
import {
  ISSUE_STATUS_OPTIONS,
  RELEASE_STAGE_OPTIONS,
  TEAM_OPTIONS,
  WORKFLOW_CATEGORY_OPTIONS,
} from "./options.js"

const selectOptions = (names: readonly string[]) =>
  names.map((name) => ({ name }))

export const INITIAL_TITLE = "Linear Issues"
export const PRIMARY_KEY = "Linear Issue ID"

export const issueSchema: Schema.Schema<typeof PRIMARY_KEY> = {
  databaseIcon: notionIcon("checkmark-square"),
  properties: {
    Title: Schema.title(),

    "Issue Key": Schema.richText(),

    // Status, Workflow Category, Team, and Release stage are the only selects
    // here whose options are workspace-defined. Regenerate src/options.ts via
    // scripts/generate-options.mts when Linear adds new ones. Cycle, Labels,
    // and Release versions move too fast for that and are rich text instead.
    Status: Schema.select(selectOptions(ISSUE_STATUS_OPTIONS)),

    Priority: Schema.select([
      { name: "No Priority" },
      { name: "Urgent" },
      { name: "High" },
      { name: "Medium" },
      { name: "Low" },
    ]),

    Assignee: Schema.richText(),

    "Issue Link": Schema.url(),

    Updated: Schema.date(),

    // WorkflowState.type is an open string in Linear's schema, not an enum, so
    // this list is generated too. A hardcoded list missed "Duplicate".
    "Workflow Category": Schema.select(
      selectOptions(WORKFLOW_CATEGORY_OPTIONS)
    ),

    Team: Schema.select(selectOptions(TEAM_OPTIONS)),

    // A relation rather than a select: there are ~1,100 projects and the set
    // turns over weekly, so a baked option list would silently drop new ones.
    // Two-way so Project pages expose an Issues back-reference for product ops.
    // Large projects can accumulate hundreds of linked issues on that property.
    Project: Schema.relation("projects", {
      twoWay: true,
      relatedPropertyName: "Issues",
    }),

    // Rich text rather than a select. Cycles are per team and numbered, new
    // ones appear every fortnight forever, and "Cycle 46" means a different
    // fortnight on every team. Same reasoning as project Milestones.
    Cycle: Schema.richText(),

    // Rich text, for the same reason as Cycle. The workspace carries roughly
    // a thousand distinct label names and mints new ones by the hour (17 in
    // one half-hour window while this was being built), so a declared option
    // list is stale the moment it deploys and drops every label created
    // since. Filter with a `contains` text filter in Notion.
    Labels: Schema.richText(),

    // Version string (10.4.7). Rich text because trains turn over forever.
    Release: Schema.richText(),

    // Workspace-custom stage name: iOS Clinician uses "Released", not
    // "Completed". Generated from Linear releaseStages plus a small seed.
    "Release stage": Schema.select(selectOptions(RELEASE_STAGE_OPTIONS)),

    "Released at": Schema.date(),

    // Pipeline name (iOS Clinician). Rich text so a new mobile pipeline
    // does not need a redeploy.
    "Release pipeline": Schema.richText(),

    Estimate: Schema.number(),

    "Due Date": Schema.date(),

    Started: Schema.date(),

    Completed: Schema.date(),

    Canceled: Schema.date(),

    Created: Schema.date(),

    Archived: Schema.checkbox(),

    "Linear Issue ID": Schema.richText(),
  },
}

export function issueToChange(issue: LinearIssue) {
  const status = declaredSelectName(issue.state?.name, ISSUE_STATUS_OPTIONS)
  const workflowCategory = declaredSelectName(
    workflowCategoryLabel(issue.state?.type),
    WORKFLOW_CATEGORY_OPTIONS
  )
  const priority = priorityLabel(issue.priority, issue.priorityLabel)
  const assignee = personDisplay(issue.assignee)
  const url = issue.url?.trim()
  const updated = dateTime(issue.updatedAt)
  const team = declaredSelectName(teamSelectName(issue.team), TEAM_OPTIONS)
  const projectId = issue.project?.id?.trim()
  const cycle = cycleDisplay(issue.cycle)
  const labels = labelSummary(issue.labels.nodes)
  const releaseNodes = issue.releases?.nodes ?? []
  const release = pickCurrentRelease(releaseNodes)
  const releaseName = releaseDisplayName(release)
  const releaseStage = declaredSelectName(
    release?.stage?.name,
    RELEASE_STAGE_OPTIONS
  )
  const releasedAt = dateTime(release?.completedAt)
  const releasePipeline = selectName(release?.pipeline?.name)
  const dueDate = dateOnly(issue.dueDate)
  const started = dateTime(issue.startedAt)
  const completed = dateTime(issue.completedAt)
  const canceled = dateTime(issue.canceledAt)
  const created = dateTime(issue.createdAt)
  const identifier = issue.identifier?.trim()

  return {
    type: "upsert" as const,
    key: issue.id,
    // A release moving Planned → Released may not bump issue.updatedAt.
    // Fold release timestamps in so releasesSync can win over a stale
    // issuesBackfill that still has the older issue clock.
    upstreamUpdatedAt: latestTimestamp(
      issue.updatedAt,
      ...releaseNodes.map((item) => item.updatedAt)
    ),
    // Do not write issue descriptions as page bodies. Linear markdown
    // (HTML, autolinks, strikethrough, images) has stalled both the
    // incremental sync and the backfill on Notion's markdown diff, and
    // nothing in this database reads the body — Issue Link is the source.
    properties: {
      Title: Builder.title(issue.title),
      ...(identifier ? { "Issue Key": Builder.richText(identifier) } : {}),
      ...(status ? { Status: Builder.select(status) } : {}),
      ...(priority ? { Priority: Builder.select(priority) } : {}),
      ...(assignee ? { Assignee: Builder.richText(assignee) } : {}),
      ...(url ? { "Issue Link": Builder.url(url) } : {}),
      ...(updated ? { Updated: Builder.dateTime(updated) } : {}),
      ...(workflowCategory
        ? { "Workflow Category": Builder.select(workflowCategory) }
        : {}),
      ...(team ? { Team: Builder.select(team) } : {}),
      // The relation key is the projects database primary key, which is the
      // Linear project UUID.
      ...(projectId ? { Project: [Builder.relation(projectId)] } : {}),
      ...(cycle ? { Cycle: Builder.richText(cycle) } : {}),
      ...(labels ? { Labels: Builder.richText(labels) } : {}),
      ...(releaseName ? { Release: Builder.richText(releaseName) } : {}),
      ...(releaseStage
        ? { "Release stage": Builder.select(releaseStage) }
        : {}),
      ...(releasedAt ? { "Released at": Builder.dateTime(releasedAt) } : {}),
      ...(releasePipeline
        ? { "Release pipeline": Builder.richText(releasePipeline) }
        : {}),
      ...(issue.estimate != null && Number.isFinite(issue.estimate)
        ? { Estimate: Builder.number(issue.estimate) }
        : {}),
      ...(dueDate ? { "Due Date": Builder.date(dueDate) } : {}),
      ...(started ? { Started: Builder.dateTime(started) } : {}),
      ...(completed ? { Completed: Builder.dateTime(completed) } : {}),
      ...(canceled ? { Canceled: Builder.dateTime(canceled) } : {}),
      ...(created ? { Created: Builder.dateTime(created) } : {}),
      Archived: Builder.checkbox(Boolean(issue.archivedAt)),
      "Linear Issue ID": Builder.richText(issue.id),
    },
  }
}

/** Incremental polling can observe soft-deleted issues before reconciliation. */
export function issueToSyncChange(issue: LinearIssue) {
  return issue.trashed
    ? { type: "delete" as const, key: issue.id }
    : issueToChange(issue)
}
