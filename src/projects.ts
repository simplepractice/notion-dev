// Linear projects — the strategic delivery view for PMs and stakeholders.
// Keep the schema and transform property order in sync.

import * as Schema from "@notionhq/workers/schema"
import * as Builder from "@notionhq/workers/builder"
import { notionIcon } from "@notionhq/workers"

import type { LinearProject } from "./linear.js"
import {
  dateOnly,
  dateTime,
  declaredSelectName,
  declaredSelectNames,
  healthLabel,
  labelSelectNames,
  latestTimestamp,
  linkedResourcesFromProject,
  longFormContent,
  milestoneSummary,
  personEmail,
  priorityLabel,
  projectStatusLabel,
  relatedInitiativeIds,
  resourcePageContent,
  teamSelectNames,
} from "./helpers.js"
import {
  PROJECT_LABEL_OPTIONS,
  PROJECT_STATUS_OPTIONS,
  TEAM_OPTIONS,
} from "./options.js"

const selectOptions = (names: readonly string[]) =>
  names.map((name) => ({ name }))

export const INITIAL_TITLE = "Linear Projects"
export const PRIMARY_KEY = "Linear Project ID"

export const projectSchema: Schema.Schema<typeof PRIMARY_KEY> = {
  databaseIcon: notionIcon("target"),
  properties: {
    Name: Schema.title(),

    // Workspace-defined values must be declared here; regenerate src/options.ts
    // via scripts/generate-options.mts when Linear adds new ones.
    Status: Schema.select(selectOptions(PROJECT_STATUS_OPTIONS)),

    Health: Schema.select([
      { name: "On Track" },
      { name: "At Risk" },
      { name: "Off Track" },
    ]),

    Lead: Schema.people(),

    Teams: Schema.multiSelect(selectOptions(TEAM_OPTIONS)),

    "Project Link": Schema.url(),

    "Linked Resources": Schema.file(),

    Summary: Schema.richText(),

    "Related Initiative": Schema.relation("initiatives", {
      twoWay: true,
      relatedPropertyName: "Projects",
    }),

    Labels: Schema.multiSelect(selectOptions(PROJECT_LABEL_OPTIONS)),

    Milestones: Schema.richText(),

    "Progress %": Schema.number(),

    "Target Date": Schema.date(),

    Updated: Schema.date(),

    "Last Update At": Schema.date(),

    "Last Update Link": Schema.url(),

    "Status Category": Schema.select([
      { name: "Backlog" },
      { name: "Planned" },
      { name: "Started" },
      { name: "Paused" },
      { name: "Completed" },
      { name: "Canceled" },
    ]),

    Priority: Schema.select([
      { name: "No Priority" },
      { name: "Urgent" },
      { name: "High" },
      { name: "Medium" },
      { name: "Low" },
    ]),

    "Start Date": Schema.date(),

    Started: Schema.date(),

    Completed: Schema.date(),

    Canceled: Schema.date(),

    Created: Schema.date(),

    Archived: Schema.checkbox(),

    "Slug ID": Schema.richText(),

    "Linear Project ID": Schema.richText(),
  },
}

function progressPercent(progress: number | null | undefined): number | null {
  if (progress == null || !Number.isFinite(progress)) return null
  return Math.min(100, Math.max(0, progress * 100))
}

export function projectToChange(project: LinearProject) {
  const status = declaredSelectName(
    project.status?.name,
    PROJECT_STATUS_OPTIONS
  )
  const statusCategory = projectStatusLabel(project.status?.type)
  const health = healthLabel(project.health)
  const leadEmail = personEmail(project.lead)
  const teams = declaredSelectNames(
    teamSelectNames(project.teams?.nodes),
    TEAM_OPTIONS
  )
  const labels = declaredSelectNames(
    labelSelectNames(project.labels?.nodes),
    PROJECT_LABEL_OPTIONS
  )
  const milestones = milestoneSummary(project.projectMilestones?.nodes)
  const initiativeIds = relatedInitiativeIds(project.initiatives?.nodes)
  const linkedResources = linkedResourcesFromProject(project)
  const summary = project.description?.trim()
  const url = project.url?.trim()
  const updated = dateTime(project.updatedAt)
  const lastUpdateAt = dateTime(project.lastUpdate?.updatedAt)
  const lastUpdateLink = project.lastUpdate?.url?.trim()
  const priority = priorityLabel(project.priority, project.priorityLabel)
  const progress = progressPercent(project.progress)
  const startDate = dateOnly(project.startDate)
  const targetDate = dateOnly(project.targetDate)
  const started = dateTime(project.startedAt)
  const completed = dateTime(project.completedAt)
  const canceled = dateTime(project.canceledAt)
  const created = dateTime(project.createdAt)
  const slugId = project.slugId?.trim()
  const upstreamUpdatedAt = latestTimestamp(
    project.updatedAt,
    project.lastUpdate?.updatedAt
  )

  return {
    type: "upsert" as const,
    key: project.id,
    upstreamUpdatedAt,
    pageContentMarkdown: resourcePageContent({
      overview: longFormContent(project.content, project.description),
      overviewHeading: "Project overview",
      resourceUrl: url ?? "",
      latestUpdate: project.lastUpdate,
      linkedResources,
    }),
    properties: {
      Name: Builder.title(project.name),
      ...(status ? { Status: Builder.select(status) } : {}),
      ...(health ? { Health: Builder.select(health) } : {}),
      ...(leadEmail ? { Lead: Builder.people(leadEmail) } : {}),
      ...(teams.length > 0 ? { Teams: Builder.multiSelect(...teams) } : {}),
      ...(url ? { "Project Link": Builder.url(url) } : {}),
      ...(linkedResources.length > 0
        ? {
            "Linked Resources": linkedResources.flatMap((resource) =>
              Builder.file(resource.url, resource.label)
            ),
          }
        : {}),
      ...(summary ? { Summary: Builder.richText(summary) } : {}),
      ...(initiativeIds.length > 0
        ? {
            "Related Initiative": initiativeIds.map((id) =>
              Builder.relation(id)
            ),
          }
        : {}),
      ...(labels.length > 0 ? { Labels: Builder.multiSelect(...labels) } : {}),
      ...(milestones ? { Milestones: Builder.richText(milestones) } : {}),
      ...(progress != null ? { "Progress %": Builder.number(progress) } : {}),
      ...(targetDate ? { "Target Date": Builder.date(targetDate) } : {}),
      ...(updated ? { Updated: Builder.dateTime(updated) } : {}),
      ...(lastUpdateAt
        ? { "Last Update At": Builder.dateTime(lastUpdateAt) }
        : {}),
      ...(lastUpdateLink
        ? { "Last Update Link": Builder.url(lastUpdateLink) }
        : {}),
      ...(statusCategory
        ? { "Status Category": Builder.select(statusCategory) }
        : {}),
      ...(priority ? { Priority: Builder.select(priority) } : {}),
      ...(startDate ? { "Start Date": Builder.date(startDate) } : {}),
      ...(started ? { Started: Builder.dateTime(started) } : {}),
      ...(completed ? { Completed: Builder.dateTime(completed) } : {}),
      ...(canceled ? { Canceled: Builder.dateTime(canceled) } : {}),
      ...(created ? { Created: Builder.dateTime(created) } : {}),
      Archived: Builder.checkbox(Boolean(project.archivedAt)),
      ...(slugId ? { "Slug ID": Builder.richText(slugId) } : {}),
      "Linear Project ID": Builder.richText(project.id),
    },
  }
}

export function projectToSyncChange(project: LinearProject) {
  return project.trashed
    ? { type: "delete" as const, key: project.id }
    : projectToChange(project)
}
