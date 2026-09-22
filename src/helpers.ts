// Shared display helpers for Linear resource transforms.

const PROJECT_STATUS_LABELS: Record<string, string> = {
  backlog: "Backlog",
  planned: "Planned",
  started: "Started",
  paused: "Paused",
  completed: "Completed",
  canceled: "Canceled",
  cancelled: "Canceled",
}

const HEALTH_LABELS: Record<string, string> = {
  ontrack: "On Track",
  atrisk: "At Risk",
  offtrack: "Off Track",
}

const PRIORITY_LABELS: Record<number, string> = {
  0: "No Priority",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
}

export const MAX_PAGE_SECTION_CHARACTERS = 20_000
export const MAX_RENDERED_CONTRIBUTING_PROJECTS = 100

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "")
}

/** Turn an API enum or other machine label into readable title case. */
export function formatLinearLabel(value: string): string {
  const spaced = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")

  return spaced.replace(/\b\w/g, (character) => character.toUpperCase())
}

/** Map Linear's stable project status type, not a workspace-custom status name. */
export function projectStatusLabel(
  type: string | null | undefined
): string | null {
  const value = type?.trim()
  if (!value) return null

  return PROJECT_STATUS_LABELS[normalizedKey(value)] ?? formatLinearLabel(value)
}

export function healthLabel(health: string | null | undefined): string | null {
  const value = health?.trim()
  if (!value) return null

  return HEALTH_LABELS[normalizedKey(value)] ?? formatLinearLabel(value)
}

export function workflowCategoryLabel(
  type: string | null | undefined
): string | null {
  const value = type?.trim()
  return value ? formatLinearLabel(value) : null
}

/**
 * Prefer Linear's own display label, then fall back to its numeric priority.
 * Unknown values remain visible instead of being silently misclassified.
 */
export function priorityLabel(
  priority: number | string | null | undefined,
  suppliedLabel?: string | null
): string | null {
  const displayLabel = suppliedLabel?.trim()
  if (displayLabel) {
    const key = normalizedKey(displayLabel)
    if (key === "nopriority" || key === "none") return "No Priority"
    return formatLinearLabel(displayLabel)
  }

  if (typeof priority === "number") {
    return PRIORITY_LABELS[priority] ?? String(priority)
  }

  const raw = priority?.trim()
  if (!raw) return null

  const numericPriority = Number(raw)
  if (Number.isInteger(numericPriority) && raw !== "") {
    return PRIORITY_LABELS[numericPriority] ?? raw
  }

  const key = normalizedKey(raw)
  if (key === "nopriority" || key === "none") return "No Priority"
  return formatLinearLabel(raw)
}

export type LinearCycleDisplay = {
  name?: string | null
  number?: number | null
}

export function cycleDisplay(
  cycle: LinearCycleDisplay | null | undefined
): string | null {
  const name = cycle?.name?.trim()
  if (name) return name
  return cycle?.number == null ? null : `Cycle ${cycle.number}`
}

const OPEN_RELEASE_STAGE_TYPES = new Set(["planned", "started"])

export type LinearReleaseDisplay = {
  id?: string | null
  name?: string | null
  version?: string | null
  completedAt?: string | null
  updatedAt?: string | null
  archivedAt?: string | null
  trashed?: boolean | null
  stage?: { name?: string | null; type?: string | null } | null
  pipeline?: { name?: string | null } | null
}

function isVisibleRelease(release: LinearReleaseDisplay): boolean {
  return !release.trashed && !release.archivedAt
}

function isOpenRelease(release: LinearReleaseDisplay): boolean {
  const type = release.stage?.type?.trim()
  return Boolean(type && OPEN_RELEASE_STAGE_TYPES.has(normalizedKey(type)))
}

function releaseSortTime(release: LinearReleaseDisplay): number {
  const completed = Date.parse(release.completedAt ?? "")
  if (Number.isFinite(completed)) return completed
  const updated = Date.parse(release.updatedAt ?? "")
  return Number.isFinite(updated) ? updated : 0
}

/**
 * An issue can sit on more than one release (iOS + Android, or a leftover
 * planned row after a ship). Prefer an open (planned/started) release; if
 * none remain, take the most recently completed one.
 */
export function pickCurrentRelease(
  releases: LinearReleaseDisplay[] | undefined
): LinearReleaseDisplay | null {
  const visible = (releases ?? []).filter(isVisibleRelease)
  if (visible.length === 0) return null

  const open = visible.filter(isOpenRelease)
  const pool = open.length > 0 ? open : visible
  return (
    [...pool].sort(
      (left, right) => releaseSortTime(right) - releaseSortTime(left)
    )[0] ?? null
  )
}

/** Prefer the version string the Linear UI shows (10.4.7) over the name. */
export function releaseDisplayName(
  release: LinearReleaseDisplay | null | undefined
): string | null {
  return release?.version?.trim() || release?.name?.trim() || null
}

/** Prefer Linear's richer document content and fall back to its description. */
export function longFormContent(
  content: unknown,
  description: string | null | undefined
): string {
  if (typeof content === "string" && content.trim()) return content
  return description?.trim() ? description : ""
}

export function dateOnly(value: string | null | undefined): string | null {
  const date = value?.trim()
  return date ? date.slice(0, 10) : null
}

export function dateTime(value: string | null | undefined): string | null {
  const date = value?.trim()
  return date || null
}

/** Include related status-update edits in the record freshness watermark. */
export function latestTimestamp(
  primary: string,
  ...candidates: Array<string | null | undefined>
): string {
  let latest = primary
  let latestTime = Date.parse(primary)

  for (const candidate of candidates) {
    const candidateValue = candidate?.trim()
    if (!candidateValue) continue

    const candidateTime = Date.parse(candidateValue)
    if (!Number.isFinite(candidateTime)) continue
    if (!Number.isFinite(latestTime) || candidateTime > latestTime) {
      latest = candidateValue
      latestTime = candidateTime
    }
  }

  return latest
}

export type LinearPersonDisplay = {
  displayName?: string | null
  name?: string | null
  email?: string | null
}

/** Resolve a related user to a human-readable value without exposing its ID. */
export function personDisplay(
  person: LinearPersonDisplay | null | undefined
): string | null {
  return (
    person?.displayName?.trim() ||
    person?.name?.trim() ||
    person?.email?.trim() ||
    null
  )
}

/** Notion people properties resolve workspace members by email. */
export function personEmail(
  person: LinearPersonDisplay | null | undefined
): string | null {
  const email = person?.email?.trim()
  return email && email.includes("@") ? email : null
}

/**
 * Normalize a value for a Notion select or multi-select option name. Commas
 * are not allowed in option names, so they are stripped here and in
 * scripts/generate-options.mts, which imports this function. Anything that
 * declares options and anything that emits them must agree, or the value is
 * silently dropped on write.
 */
export function selectName(value: string | null | undefined): string | null {
  const name = value?.replace(/,/g, "").trim()
  return name || null
}

/**
 * Match Linear's spelling to the canonical option declared in Notion.
 * Notion treats option names case-insensitively even though Linear permits
 * separate values such as "In progress" and "In Progress".
 */
export function declaredSelectName(
  value: string | null | undefined,
  options: readonly string[]
): string | null {
  const name = selectName(value)
  if (!name) return null
  const folded = name.toLocaleLowerCase()
  return (
    options.find((option) => option.toLocaleLowerCase() === folded) ?? name
  )
}

export function declaredSelectNames(
  values: readonly string[],
  options: readonly string[]
): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const name = declaredSelectName(value, options)
    const folded = name?.toLocaleLowerCase()
    if (!name || !folded || seen.has(folded)) continue
    seen.add(folded)
    names.push(name)
  }
  return names
}

export function teamSelectName(
  team: { name?: string | null; key?: string | null } | null | undefined
): string | null {
  return selectName(team?.name) ?? selectName(team?.key)
}

export function teamSelectNames(
  teams: { name?: string | null; key?: string | null }[] | undefined
): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const team of teams ?? []) {
    const name = teamSelectName(team)
    if (!name || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

export type LinkedResource = { label: string; url: string }

export function linkedResourcesFromProject(project: {
  externalLinks?: { nodes?: { url?: string | null; label?: string | null }[] }
  documents?: { nodes?: { url?: string | null; title?: string | null }[] }
}): LinkedResource[] {
  const resources: LinkedResource[] = []
  const seen = new Set<string>()

  const add = (url: string | null | undefined, label: string | null | undefined) => {
    const href = url?.trim()
    if (!href || seen.has(href)) return
    seen.add(href)
    resources.push({
      label: label?.trim() || href,
      url: href,
    })
  }

  for (const link of project.externalLinks?.nodes ?? []) {
    add(link.url, link.label)
  }
  for (const document of project.documents?.nodes ?? []) {
    add(document.url, document.title)
  }
  return resources
}

export function linkedResourcesPropertyText(resources: LinkedResource[]): string | null {
  if (resources.length === 0) return null
  return resources.map((resource) => `${resource.label}: ${resource.url}`).join(" · ")
}

export function labelSelectNames(
  labels: { name?: string | null }[] | undefined
): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const label of labels ?? []) {
    const name = selectName(label.name)
    if (!name || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

/**
 * Issue labels are rendered as rich text rather than multi-select options.
 * The workspace has roughly a thousand distinct label names and gains new
 * ones by the hour, so a declared option list would need a redeploy to stay
 * complete and would silently drop every label created since the last one.
 * Unlike labelSelectNames, this keeps the name exactly as Linear reports it.
 */
export function labelSummary(
  labels: { name?: string | null }[] | undefined
): string | null {
  const names: string[] = []
  const seen = new Set<string>()
  for (const label of labels ?? []) {
    const name = label.name?.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names.length > 0 ? names.join(" · ") : null
}

// Milestone names are per-project freeform text, so they are rendered as a
// single rich-text summary rather than select options.
export function milestoneSummary(
  milestones: { name?: string | null; targetDate?: string | null }[] | undefined
): string | null {
  const names: string[] = []
  const seen = new Set<string>()
  for (const milestone of milestones ?? []) {
    const raw = milestone.name?.trim()
    if (!raw) continue
    const target = dateOnly(milestone.targetDate)
    const name = target ? `${raw} (${target})` : raw
    if (seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names.length > 0 ? names.join(" · ") : null
}

export function relatedInitiativeIds(
  initiatives:
    | { id?: string | null; archivedAt?: string | null }[]
    | undefined
): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const initiative of initiatives ?? []) {
    const id = initiative.id?.trim()
    if (!id || initiative.archivedAt || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

export type LinearStatusUpdateContent = {
  body?: string | null
  createdAt?: string | null
  url?: string | null
  user?: LinearPersonDisplay | null
}

export type LinearContributingProjectContent = {
  id: string
  name: string
  url?: string | null
  archivedAt?: string | null
  trashed?: boolean | null
}

function escapeMarkdownText(value: string): string {
  return value.replace(/([\\`*_[\]<>])/g, "\\$1")
}

function escapeMarkdownExcerpt(value: string): string {
  return value.replace(/([\\`*_[\]{}()#+\-.!>|<>])/g, "\\$1")
}

function truncateMarkdownSection(
  value: string,
  fullContentUrl: string | null | undefined,
  sectionLabel: string
): string {
  const content = value.trim()
  const characters = Array.from(content)
  if (characters.length <= MAX_PAGE_SECTION_CHARACTERS) return content

  const initialExcerpt = characters
    .slice(0, MAX_PAGE_SECTION_CHARACTERS)
    .join("")
  const earliestPreferredBreak = Math.floor(initialExcerpt.length * 0.6)
  const breakCandidates = [
    initialExcerpt.lastIndexOf("\n\n"),
    initialExcerpt.lastIndexOf("\n"),
    initialExcerpt.lastIndexOf(" "),
  ]
  const preferredBreak = breakCandidates.find(
    (index) => index >= earliestPreferredBreak
  )
  const excerpt = initialExcerpt
    .slice(0, preferredBreak ?? initialExcerpt.length)
    .trimEnd()
  const url = fullContentUrl?.trim()
  const destination = url
    ? ` [Read the full ${sectionLabel} in Linear](${url}).`
    : " Open the source record in Linear to read the full text."

  return `> This ${sectionLabel} was shortened in Notion.${destination}\n\n${escapeMarkdownExcerpt(excerpt)}`
}

function latestUpdateSection(
  update: LinearStatusUpdateContent | null | undefined
): string | null {
  if (!update) return null

  const author = personDisplay(update.user)
  const postedOn = dateOnly(update.createdAt)
  const url = update.url?.trim()
  const metadata = [
    author ? `Updated by ${escapeMarkdownText(author)}` : null,
    postedOn,
    url ? `[Open update in Linear](${url})` : null,
  ].filter((value): value is string => Boolean(value))
  const body = truncateMarkdownSection(update.body ?? "", url, "latest update")
  const parts = [
    "## Latest update",
    metadata.length > 0 ? `_${metadata.join(" · ")}_` : null,
    body || null,
  ].filter((value): value is string => Boolean(value))

  return parts.join("\n\n")
}

export function uniqueVisibleProjects<
  T extends LinearContributingProjectContent,
>(projects: T[]): T[] {
  const seenIds = new Set<string>()
  return projects.filter((project) => {
    if (project.trashed || seenIds.has(project.id)) return false
    seenIds.add(project.id)
    return true
  })
}

function contributingProjectsSection(
  projects: LinearContributingProjectContent[],
  initiativeUrl: string
): string | null {
  if (projects.length === 0) {
    return "## Contributing projects (0)\n\nNo contributing projects visible to this Linear API key."
  }

  const sortedProjects = [...projects].sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
  )
  const renderedProjects = sortedProjects.slice(
    0,
    MAX_RENDERED_CONTRIBUTING_PROJECTS
  )
  const bullets = renderedProjects.map((project) => {
    const name = escapeMarkdownText(project.name.trim() || "Untitled project")
    const url = project.url?.trim()
    const label = url ? `[${name}](${url})` : name
    return `- ${label}${project.archivedAt ? " _(archived)_" : ""}`
  })
  const remaining = sortedProjects.length - renderedProjects.length
  if (remaining > 0) {
    const url = initiativeUrl.trim()
    const suffix = url
      ? `[View all projects in Linear](${url}).`
      : "Open the Initiative in Linear to view them."
    bullets.push(`- _…and ${remaining} more. ${suffix}_`)
  }

  return `## Contributing projects (${projects.length})\n\n${bullets.join("\n")}`
}

function linkedResourcesSection(resources: LinkedResource[]): string | null {
  if (resources.length === 0) return null
  const bullets = resources.map((resource) => {
    const label = escapeMarkdownText(resource.label)
    return `- [${label}](${resource.url})`
  })
  return `## Linked resources\n\n${bullets.join("\n")}`
}

export function resourcePageContent(options: {
  overview: string
  overviewHeading: "Project overview" | "Initiative overview"
  resourceUrl: string
  latestUpdate?: LinearStatusUpdateContent | null
  contributingProjects?: LinearContributingProjectContent[]
  linkedResources?: LinkedResource[]
}): string {
  const sections: string[] = []
  const update = latestUpdateSection(options.latestUpdate)
  if (update) sections.push(update)

  const linked = linkedResourcesSection(options.linkedResources ?? [])
  if (linked) sections.push(linked)

  if (options.contributingProjects) {
    const projects = contributingProjectsSection(
      options.contributingProjects,
      options.resourceUrl
    )
    if (projects) sections.push(projects)
  }

  const overview = truncateMarkdownSection(
    options.overview,
    options.resourceUrl,
    options.overviewHeading.toLowerCase()
  )
  if (overview) {
    sections.push(`## ${options.overviewHeading}\n\n${overview}`)
  }

  return sections.join("\n\n")
}

/**
 * Issues carry only a description, so they skip the section assembly projects
 * and initiatives need — but they must not skip the length cap. An unbounded
 * page body is both a Notion write hazard and the backfill's payload risk.
 *
 * Linear descriptions come back as arbitrary user-authored markdown, which
 * routinely contains raw HTML tags, pointy-bracket wrapped URLs alongside
 * `[label](<url>)` links, unbalanced code fences, and other constructs that
 * the platform's server-side markdown diff has rejected in the past —
 * blocking the sync cursor indefinitely once one such issue shows up. We do
 * not have visibility into which characters the parser rejects, so we treat
 * every description as untrusted and escape all CommonMark punctuation
 * before emitting it. The page body renders as plain, unformatted text with
 * a link back to the original in Linear at the top; that is a deliberate
 * tradeoff against silent multi-day sync stalls. Do not relax this without
 * a full parity test against production descriptions.
 */
export function issuePageContent(
  description: string | null | undefined,
  issueUrl: string | null | undefined
): string {
  const raw = description?.trim() ?? ""
  if (!raw) return ""

  const truncated = truncateMarkdownSection(raw, issueUrl, "description")
  // truncateMarkdownSection only escapes when it actually shortens the
  // content. When the description is short enough to pass through untouched
  // we escape it here so the parser can never trip on user content.
  if (truncated === raw) {
    return escapeMarkdownExcerpt(raw)
  }
  return truncated
}
