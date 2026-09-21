// Linear GraphQL API client. This module deliberately uses the public GraphQL
// API directly instead of the Linear SDK so that the example shows the full
// pagination, pacing, and rate-limit behavior required by a production sync.

import { RateLimitError } from "@notionhq/workers"

const API_URL = "https://api.linear.app/graphql"
// Projects nest several connections. Keep both the outer page and nested
// pages small so a single request stays under Linear's 10k complexity cap.
const PROJECT_PAGE_SIZE = 20
const PROJECT_NESTED_PAGE_SIZE = 10
const PROJECT_INITIATIVE_PAGE_SIZE = 5
// Milestones are their own constant because they are the one project
// connection that routinely runs past the nested page size: a release project
// carries a milestone per dev workstream plus EA/GA. Kept at 10 so the base
// query's complexity is unchanged, with the follow-up pagination below
// fetching the rest.
const PROJECT_MILESTONE_PAGE_SIZE = 10
// Initiative rows embed contributing projects. A smaller outer page keeps the
// worst-case query comfortably below Linear's complexity cap.
const INITIATIVE_PAGE_SIZE = 20
const INITIATIVE_NESTED_PAGE_SIZE = 50
// Issues are the highest-volume resource, so the outer page is sized for
// throughput. Linear reports `x-complexity: 16` for this query at page sizes
// of 50, 100, and 250 alike, so the 10,000-per-query cap is irrelevant here
// and the request budget is the only thing that binds. 100 keeps the response
// near 280 KB and the change batch at the size the Workers runtime expects;
// 250 was measured at 584 KB, which is a large single execution.
//
// These are deliberately separate from the initiative sizes; one shared
// constant previously meant that tuning issues silently retuned initiatives.
const ISSUE_PAGE_SIZE = 100
const ISSUE_LABEL_PAGE_SIZE = 20
const ISSUE_RELEASE_PAGE_SIZE = 10
const RELEASE_PAGE_SIZE = 20
const RELEASE_ISSUE_PAGE_SIZE = 50
// Per issue *page* budget for label follow-up requests. Only issues carrying
// more than ISSUE_LABEL_PAGE_SIZE labels consume any of it.
const MAX_NESTED_LABEL_REQUESTS_PER_PAGE = 20
export const MAX_NESTED_INITIATIVE_PROJECT_REQUESTS_PER_PAGE = 20
// Per project *page* budget for milestone follow-up requests. One page holds
// PROJECT_PAGE_SIZE projects and only those carrying more than
// PROJECT_MILESTONE_PAGE_SIZE milestones spend any of it, so this leaves room
// for every project on a page to need a follow-up and still not fail.
export const MAX_NESTED_MILESTONE_REQUESTS_PER_PAGE = 40
// Per release *page* budget for issue-id follow-ups. A scheduled mobile
// train can carry more than RELEASE_ISSUE_PAGE_SIZE issues; this leaves
// room for every release on a page to need a couple of extra fetches.
export const MAX_NESTED_RELEASE_ISSUE_REQUESTS_PER_PAGE = 80

export type BeforeRequest = () => Promise<void>

export type LinearPageInfo = {
  hasNextPage: boolean
  endCursor: string | null
}

export type LinearConnection<T> = {
  nodes: T[]
  pageInfo: LinearPageInfo
}

export type LinearPage<T> = {
  resources: T[]
  hasMore: boolean
  nextCursor: string | undefined
}

export type LinearUser = {
  name: string | null
  displayName: string | null
  email: string | null
}

export type LinearStatusUpdate = {
  body: string
  createdAt: string
  updatedAt: string
  url: string
  user: LinearUser | null
}

export type LinearProjectStatus = {
  name: string
  type: string
}

export type LinearNamedLink = {
  url: string | null
  label?: string | null
  title?: string | null
}

export type LinearTeam = {
  name: string | null
  key: string | null
}

export type LinearLabel = {
  name: string
}

export type LinearMilestone = {
  name: string | null
  targetDate: string | null
}

export type LinearInitiativeRef = {
  id: string
  name: string | null
  archivedAt: string | null
}

export type LinearProject = {
  id: string
  name: string
  slugId: string
  url: string
  status: LinearProjectStatus | null
  health: string | null
  lastUpdate: LinearStatusUpdate | null
  lead: LinearUser | null
  teams: LinearConnection<LinearTeam>
  labels: LinearConnection<LinearLabel>
  projectMilestones: LinearConnection<LinearMilestone>
  initiatives: LinearConnection<LinearInitiativeRef>
  externalLinks: LinearConnection<LinearNamedLink>
  documents: LinearConnection<LinearNamedLink>
  priority: number | null
  priorityLabel: string | null
  progress: number | null
  startDate: string | null
  targetDate: string | null
  startedAt: string | null
  completedAt: string | null
  canceledAt: string | null
  createdAt: string
  updatedAt: string
  description: string | null
  content: string | null
  archivedAt: string | null
  trashed: boolean | null
}

export type LinearIssueState = {
  name: string
  type: string
}

export type LinearReleaseStage = {
  name: string | null
  type: string | null
}

export type LinearReleaseRef = {
  id: string
  name: string | null
  version: string | null
  completedAt: string | null
  updatedAt: string
  archivedAt: string | null
  trashed: boolean | null
  stage: LinearReleaseStage | null
  pipeline: { name: string | null } | null
}

export type LinearRelease = {
  id: string
  updatedAt: string
  issues: LinearConnection<{ id: string }>
}

export type LinearIssue = {
  id: string
  identifier: string
  title: string
  url: string
  description: string | null
  state: LinearIssueState | null
  priority: number
  priorityLabel: string
  assignee: LinearUser | null
  team: { name: string; key: string } | null
  project: { id: string; name: string } | null
  cycle: { name: string; number: number } | null
  labels: LinearConnection<LinearLabel>
  releases: LinearConnection<LinearReleaseRef>
  estimate: number | null
  dueDate: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  completedAt: string | null
  canceledAt: string | null
  archivedAt: string | null
  trashed: boolean | null
}

export type LinearInitiative = {
  id: string
  name: string
  slugId: string
  url: string
  status: string | null
  health: string | null
  lastUpdate: LinearStatusUpdate | null
  owner: LinearUser | null
  projects: LinearConnection<LinearInitiativeProject>
  targetDate: string | null
  startedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
  description: string | null
  content: string | null
  archivedAt: string | null
  trashed: boolean | null
}

export type LinearInitiativeProject = {
  id: string
  name: string
  url: string
  updatedAt: string
  archivedAt: string | null
  trashed: boolean | null
}

export type FetchIssuesOptions = {
  after?: string
  updatedSince?: string
  updatedBefore?: string
  ids?: string[]
}

export type FetchReleasesOptions = {
  after?: string
  updatedSince?: string
  updatedBefore?: string
}

export type FetchProjectsOptions = {
  after?: string
  updatedSince?: string
  updatedBefore?: string
}

type GraphQLError = {
  message?: string
  type?: string
  extensions?: {
    code?: string
    type?: string
    [key: string]: unknown
  }
}

type GraphQLResponse<T> = {
  data?: T | null
  errors?: GraphQLError[]
}

function getApiKey(): string {
  const apiKey = process.env.LINEAR_API_KEY?.trim()
  if (!apiKey) {
    throw new Error("LINEAR_API_KEY is not set.")
  }
  return apiKey
}

/**
 * Parse the standard Retry-After header. It can be either delta-seconds or an
 * HTTP date. Workers' RateLimitError expects the resulting delay in seconds.
 */
export function parseRetryAfterSeconds(
  value: string | null,
  now = Date.now()
): number | undefined {
  if (!value?.trim()) return undefined

  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds)
  }

  const retryAt = Date.parse(value)
  if (!Number.isFinite(retryAt)) return undefined
  return Math.max(0, Math.ceil((retryAt - now) / 1_000))
}

type RateLimitHeaderPair = {
  remaining: string
  reset: string
}

// Linear has independent workspace request, endpoint request, and query
// complexity budgets. Header names have evolved, so accept the documented
// names plus the older endpoint aliases when calculating a retry delay.
const RATE_LIMIT_HEADER_PAIRS: RateLimitHeaderPair[] = [
  {
    remaining: "x-ratelimit-requests-remaining",
    reset: "x-ratelimit-requests-reset",
  },
  {
    remaining: "x-ratelimit-endpoint-requests-remaining",
    reset: "x-ratelimit-endpoint-requests-reset",
  },
  {
    remaining: "x-ratelimit-endpoint-remaining",
    reset: "x-ratelimit-endpoint-reset",
  },
  {
    remaining: "x-ratelimit-complexity-remaining",
    reset: "x-ratelimit-complexity-reset",
  },
  {
    remaining: "x-ratelimit-endpoint-complexity-remaining",
    reset: "x-ratelimit-endpoint-complexity-reset",
  },
]

/** Return the longest applicable retry delay across all exhausted budgets. */
export function rateLimitRetryAfterSeconds(
  headers: Headers,
  now = Date.now()
): number | undefined {
  const delays: number[] = []
  const retryAfter = parseRetryAfterSeconds(headers.get("retry-after"), now)
  if (retryAfter !== undefined) delays.push(retryAfter)

  for (const pair of RATE_LIMIT_HEADER_PAIRS) {
    const remainingValue = headers.get(pair.remaining)
    if (remainingValue === null) continue

    const remaining = Number(remainingValue)
    if (!Number.isFinite(remaining) || remaining > 0) continue

    // Linear documents reset timestamps as epoch milliseconds.
    const resetAt = Number(headers.get(pair.reset))
    if (!Number.isFinite(resetAt) || resetAt < 0) continue
    delays.push(Math.max(0, Math.ceil((resetAt - now) / 1_000)))
  }

  return delays.length > 0 ? Math.max(...delays) : undefined
}

function isRateLimitError(error: GraphQLError): boolean {
  const classifications = [
    error.type,
    error.extensions?.code,
    error.extensions?.type,
  ]

  return classifications.some(
    (value) =>
      typeof value === "string" &&
      value.replace(/[\s_-]/g, "").toUpperCase() === "RATELIMITED"
  )
}

function graphQLErrorMessage(errors: GraphQLError[]): string {
  const messages = errors
    .map((error) => error.message?.trim())
    .filter((message): message is string => Boolean(message))
  return messages.length > 0 ? messages.join("; ") : "Unknown GraphQL error"
}

/**
 * Execute one GraphQL operation. The pacing callback is deliberately called
 * here, immediately before fetch, so it also covers follow-up label pages.
 * GraphQL partial responses are rejected: accepting data alongside errors can
 * silently create incomplete Notion rows.
 */
async function graphql<T>(
  query: string,
  variables: Record<string, unknown>,
  beforeRequest: BeforeRequest
): Promise<T> {
  const apiKey = getApiKey()

  await beforeRequest()
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    redirect: "error",
  })

  const text = await response.text()
  let body: GraphQLResponse<T> | undefined
  if (text) {
    try {
      body = JSON.parse(text) as GraphQLResponse<T>
    } catch {
      if (response.status === 429) {
        throw new RateLimitError({
          retryAfter: rateLimitRetryAfterSeconds(response.headers),
        })
      }
      throw new Error(
        `Linear API returned invalid JSON (${response.status}): ${text.slice(0, 500)}`
      )
    }
  }

  if (response.status === 429) {
    throw new RateLimitError({
      retryAfter: rateLimitRetryAfterSeconds(response.headers),
    })
  }

  const errors = Array.isArray(body?.errors) ? body.errors : []
  if (errors.some(isRateLimitError)) {
    throw new RateLimitError({
      retryAfter: rateLimitRetryAfterSeconds(response.headers),
    })
  }

  if (!response.ok) {
    const detail =
      errors.length > 0
        ? graphQLErrorMessage(errors)
        : text || "No response body"
    throw new Error(`Linear API error (${response.status}): ${detail}`)
  }

  if (errors.length > 0) {
    throw new Error(`Linear GraphQL error: ${graphQLErrorMessage(errors)}`)
  }
  if (!body || body.data === undefined || body.data === null) {
    throw new Error("Linear GraphQL response is missing data")
  }

  return body.data
}

function connectionToPage<T>(
  connection: LinearConnection<T>,
  after: string | undefined,
  resourceName: string
): LinearPage<T> {
  if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo) {
    throw new Error(`Linear ${resourceName} response has an invalid connection`)
  }

  const { hasNextPage, endCursor } = connection.pageInfo
  if (typeof hasNextPage !== "boolean") {
    throw new Error(
      `Linear ${resourceName} response is missing pageInfo.hasNextPage`
    )
  }
  if (hasNextPage && !endCursor) {
    throw new Error(
      `Linear ${resourceName} pagination response is missing endCursor`
    )
  }
  if (hasNextPage && endCursor === after) {
    throw new Error(`Linear ${resourceName} pagination repeated cursor`)
  }

  return {
    resources: connection.nodes,
    hasMore: hasNextPage,
    nextCursor: hasNextPage ? (endCursor ?? undefined) : undefined,
  }
}

const PROJECTS_QUERY = /* GraphQL */ `
  query Projects(
    $after: String
    $filter: ProjectFilter
    $orderBy: PaginationOrderBy!
  ) {
    projects(
      first: ${PROJECT_PAGE_SIZE}
      after: $after
      orderBy: $orderBy
      includeArchived: true
      filter: $filter
    ) {
      nodes {
        id
        name
        slugId
        url
        status {
          name
          type
        }
        health
        lastUpdate {
          body
          createdAt
          updatedAt
          url
          user {
            name
            displayName
            email
          }
        }
        lead {
          name
          displayName
          email
        }
        teams(first: ${PROJECT_NESTED_PAGE_SIZE}) {
          nodes {
            name
            key
          }
        }
        labels(first: ${PROJECT_NESTED_PAGE_SIZE}) {
          nodes {
            name
          }
        }
        projectMilestones(first: ${PROJECT_MILESTONE_PAGE_SIZE}) {
          nodes {
            name
            targetDate
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
        initiatives(first: ${PROJECT_INITIATIVE_PAGE_SIZE}) {
          nodes {
            id
            name
            archivedAt
          }
        }
        externalLinks(first: ${PROJECT_NESTED_PAGE_SIZE}) {
          nodes {
            url
            label
          }
        }
        documents(first: ${PROJECT_NESTED_PAGE_SIZE}) {
          nodes {
            title
            url
          }
        }
        priority
        priorityLabel
        progress
        startDate
        targetDate
        startedAt
        completedAt
        canceledAt
        createdAt
        updatedAt
        description
        content
        archivedAt
        trashed
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`

const PROJECT_MILESTONES_QUERY = /* GraphQL */ `
  query ProjectMilestones($projectId: String!, $after: String!) {
    project(id: $projectId) {
      projectMilestones(first: ${PROJECT_MILESTONE_PAGE_SIZE}, after: $after) {
        nodes {
          name
          targetDate
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`

function assertMilestonesConnection(
  milestones: LinearConnection<LinearMilestone>,
  projectId: string
): void {
  if (!milestones || !Array.isArray(milestones.nodes) || !milestones.pageInfo) {
    throw new Error(
      `Linear project ${projectId} has an invalid projectMilestones connection`
    )
  }
  if (typeof milestones.pageInfo.hasNextPage !== "boolean") {
    throw new Error(
      `Linear project ${projectId} projectMilestones response is missing hasNextPage`
    )
  }
  if (milestones.pageInfo.hasNextPage && !milestones.pageInfo.endCursor) {
    throw new Error(
      `Linear project ${projectId} projectMilestones pagination is missing endCursor`
    )
  }
}

/**
 * Milestones drive downstream EA/GA automations, so a partial list is worse
 * than a failed page: a missing milestone is indistinguishable from one that
 * was never defined. Walk the connection to the end and fail loudly if the
 * budget runs out.
 */
async function fetchAllProjectMilestones(
  project: LinearProject,
  beforeRequest: BeforeRequest,
  requestBudget: { remaining: number }
): Promise<LinearProject> {
  assertMilestonesConnection(project.projectMilestones, project.id)
  if (!project.projectMilestones.pageInfo.hasNextPage) return project

  const milestones = [...project.projectMilestones.nodes]
  const seenCursors = new Set<string>()
  let pageInfo = project.projectMilestones.pageInfo

  while (pageInfo.hasNextPage) {
    if (requestBudget.remaining <= 0) {
      throw new Error(
        `Linear project milestones exceeded ${MAX_NESTED_MILESTONE_REQUESTS_PER_PAGE} follow-up requests for one project page`
      )
    }

    const after = pageInfo.endCursor
    if (!after) {
      throw new Error(
        `Linear project ${project.id} projectMilestones pagination is missing endCursor`
      )
    }
    if (seenCursors.has(after)) {
      throw new Error(
        `Linear project ${project.id} projectMilestones pagination repeated cursor`
      )
    }
    seenCursors.add(after)
    requestBudget.remaining -= 1

    const data = await graphql<{
      project: { projectMilestones: LinearConnection<LinearMilestone> } | null
    }>(
      PROJECT_MILESTONES_QUERY,
      { projectId: project.id, after },
      beforeRequest
    )
    if (!data.project) {
      throw new Error(
        `Linear project ${project.id} disappeared while paginating milestones`
      )
    }

    assertMilestonesConnection(data.project.projectMilestones, project.id)
    milestones.push(...data.project.projectMilestones.nodes)
    pageInfo = data.project.projectMilestones.pageInfo
  }

  return {
    ...project,
    projectMilestones: { nodes: milestones, pageInfo },
  }
}

export async function fetchProjectsPage(
  beforeRequest: BeforeRequest,
  options: FetchProjectsOptions = {}
): Promise<LinearPage<LinearProject>> {
  const hasUpdatedAtFilter =
    options.updatedSince !== undefined || options.updatedBefore !== undefined
  const variables: Record<string, unknown> = {
    // Replacement sweeps use stable creation order; bounded incremental
    // windows must use updated order so cursor traversal matches the filter.
    orderBy: hasUpdatedAtFilter ? "updatedAt" : "createdAt",
  }
  if (options.after) variables.after = options.after

  const updatedAt: { gte?: string; lt?: string } = {}
  if (options.updatedSince !== undefined) updatedAt.gte = options.updatedSince
  if (options.updatedBefore !== undefined) updatedAt.lt = options.updatedBefore
  if (Object.keys(updatedAt).length > 0) {
    variables.filter = { updatedAt }
  }

  const data = await graphql<{
    projects: LinearConnection<LinearProject>
  }>(PROJECTS_QUERY, variables, beforeRequest)
  const page = connectionToPage(data.projects, options.after, "projects")

  const resources: LinearProject[] = []
  const nestedRequestBudget = {
    remaining: MAX_NESTED_MILESTONE_REQUESTS_PER_PAGE,
  }
  for (const project of page.resources) {
    resources.push(
      await fetchAllProjectMilestones(
        project,
        beforeRequest,
        nestedRequestBudget
      )
    )
  }

  return { ...page, resources }
}

const ISSUES_QUERY = /* GraphQL */ `
  query Issues(
    $after: String
    $filter: IssueFilter
    $orderBy: PaginationOrderBy!
  ) {
    issues(
      first: ${ISSUE_PAGE_SIZE}
      after: $after
      orderBy: $orderBy
      includeArchived: true
      filter: $filter
    ) {
      nodes {
        id
        identifier
        title
        url
        description
        state {
          name
          type
        }
        priority
        priorityLabel
        assignee {
          name
          displayName
          email
        }
        team {
          name
          key
        }
        project {
          id
          name
        }
        cycle {
          name
          number
        }
        labels(first: ${ISSUE_LABEL_PAGE_SIZE}, includeArchived: true) {
          nodes {
            name
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
        releases(first: ${ISSUE_RELEASE_PAGE_SIZE}, orderBy: updatedAt, includeArchived: true) {
          nodes {
            id
            name
            version
            completedAt
            updatedAt
            archivedAt
            trashed
            stage {
              name
              type
            }
            pipeline {
              name
            }
          }
        }
        estimate
        dueDate
        createdAt
        updatedAt
        startedAt
        completedAt
        canceledAt
        archivedAt
        trashed
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`

const ISSUE_LABELS_QUERY = /* GraphQL */ `
  query IssueLabels($issueId: String!, $after: String!) {
    issue(id: $issueId) {
      labels(
        first: ${ISSUE_LABEL_PAGE_SIZE}
        after: $after
        includeArchived: true
      ) {
        nodes {
          name
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`

function assertLabelsConnection(
  labels: LinearConnection<LinearLabel>,
  issueId: string
): void {
  if (!labels || !Array.isArray(labels.nodes) || !labels.pageInfo) {
    throw new Error(`Linear issue ${issueId} has an invalid labels connection`)
  }
  if (typeof labels.pageInfo.hasNextPage !== "boolean") {
    throw new Error(
      `Linear issue ${issueId} labels response is missing hasNextPage`
    )
  }
  if (labels.pageInfo.hasNextPage && !labels.pageInfo.endCursor) {
    throw new Error(
      `Linear issue ${issueId} labels pagination is missing endCursor`
    )
  }
}

async function fetchAllIssueLabels(
  issue: LinearIssue,
  beforeRequest: BeforeRequest,
  requestBudget: { remaining: number }
): Promise<LinearIssue> {
  assertLabelsConnection(issue.labels, issue.id)
  if (!issue.labels.pageInfo.hasNextPage) {
    return {
      ...issue,
      labels: {
        ...issue.labels,
        nodes: dedupeLabels(issue.labels.nodes),
      },
    }
  }

  const labels = [...issue.labels.nodes]
  const seenCursors = new Set<string>()
  let pageInfo = issue.labels.pageInfo

  while (pageInfo.hasNextPage) {
    if (requestBudget.remaining <= 0) {
      throw new Error(
        `Linear issue labels exceeded ${MAX_NESTED_LABEL_REQUESTS_PER_PAGE} follow-up requests for one issue page`
      )
    }

    const after = pageInfo.endCursor
    if (!after) {
      throw new Error(
        `Linear issue ${issue.id} labels pagination is missing endCursor`
      )
    }
    if (seenCursors.has(after)) {
      throw new Error(
        `Linear issue ${issue.id} labels pagination repeated cursor`
      )
    }
    seenCursors.add(after)
    requestBudget.remaining -= 1

    const data = await graphql<{
      issue: { labels: LinearConnection<LinearLabel> } | null
    }>(ISSUE_LABELS_QUERY, { issueId: issue.id, after }, beforeRequest)
    if (!data.issue) {
      throw new Error(
        `Linear issue ${issue.id} disappeared while paginating labels`
      )
    }

    assertLabelsConnection(data.issue.labels, issue.id)
    labels.push(...data.issue.labels.nodes)
    pageInfo = data.issue.labels.pageInfo
  }

  return {
    ...issue,
    labels: {
      nodes: dedupeLabels(labels),
      pageInfo,
    },
  }
}

function dedupeLabels(labels: LinearLabel[]): LinearLabel[] {
  const names = new Set<string>()
  return labels.filter((label) => {
    if (names.has(label.name)) return false
    names.add(label.name)
    return true
  })
}

export async function fetchIssuesPage(
  beforeRequest: BeforeRequest,
  options: FetchIssuesOptions = {}
): Promise<LinearPage<LinearIssue>> {
  const hasUpdatedAtFilter =
    options.updatedSince !== undefined || options.updatedBefore !== undefined
  const variables: Record<string, unknown> = {
    // Replacement sweeps use stable creation order; bounded incremental
    // windows must use updated order so cursor traversal matches the filter.
    orderBy: hasUpdatedAtFilter ? "updatedAt" : "createdAt",
  }
  if (options.after) variables.after = options.after

  const filter: Record<string, unknown> = {}
  const updatedAt: { gte?: string; lt?: string } = {}
  if (options.updatedSince !== undefined) updatedAt.gte = options.updatedSince
  if (options.updatedBefore !== undefined) updatedAt.lt = options.updatedBefore
  if (Object.keys(updatedAt).length > 0) {
    filter.updatedAt = updatedAt
  }
  if (options.ids && options.ids.length > 0) {
    filter.id = { in: options.ids }
  }
  if (Object.keys(filter).length > 0) {
    variables.filter = filter
  }

  const data = await graphql<{
    issues: LinearConnection<LinearIssue>
  }>(ISSUES_QUERY, variables, beforeRequest)
  const page = connectionToPage(data.issues, options.after, "issues")

  // A nested connection only incurs extra API requests when an issue actually
  // has more than ISSUE_LABEL_PAGE_SIZE labels. Bound all label follow-ups for this issue
  // page so one pathological workspace cannot create an unbounded execution.
  const resources: LinearIssue[] = []
  const nestedRequestBudget = {
    remaining: MAX_NESTED_LABEL_REQUESTS_PER_PAGE,
  }
  for (const issue of page.resources) {
    resources.push(
      await fetchAllIssueLabels(issue, beforeRequest, nestedRequestBudget)
    )
  }

  return { ...page, resources }
}

export async function fetchIssuesByIds(
  beforeRequest: BeforeRequest,
  ids: string[]
): Promise<LinearIssue[]> {
  const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))]
  if (uniqueIds.length === 0) return []

  const issues: LinearIssue[] = []
  for (let index = 0; index < uniqueIds.length; index += ISSUE_PAGE_SIZE) {
    const chunk = uniqueIds.slice(index, index + ISSUE_PAGE_SIZE)
    let after: string | undefined
    for (;;) {
      const page = await fetchIssuesPage(beforeRequest, { ids: chunk, after })
      issues.push(...page.resources)
      if (!page.hasMore) break
      after = page.nextCursor
    }
  }
  return issues
}

const RELEASES_QUERY = /* GraphQL */ `
  query Releases(
    $after: String
    $filter: ReleaseFilter
    $orderBy: PaginationOrderBy!
  ) {
    releases(
      first: ${RELEASE_PAGE_SIZE}
      after: $after
      orderBy: $orderBy
      includeArchived: true
      filter: $filter
    ) {
      nodes {
        id
        updatedAt
        issues(first: ${RELEASE_ISSUE_PAGE_SIZE}, includeArchived: true) {
          nodes {
            id
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`

const RELEASE_ISSUES_QUERY = /* GraphQL */ `
  query ReleaseIssues($releaseId: String!, $after: String!) {
    release(id: $releaseId) {
      issues(
        first: ${RELEASE_ISSUE_PAGE_SIZE}
        after: $after
        includeArchived: true
      ) {
        nodes {
          id
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`

function assertReleaseIssuesConnection(
  issues: LinearConnection<{ id: string }>,
  releaseId: string
): void {
  if (!issues || !Array.isArray(issues.nodes) || !issues.pageInfo) {
    throw new Error(
      `Linear release ${releaseId} has an invalid issues connection`
    )
  }
  if (typeof issues.pageInfo.hasNextPage !== "boolean") {
    throw new Error(
      `Linear release ${releaseId} issues response is missing hasNextPage`
    )
  }
  if (issues.pageInfo.hasNextPage && !issues.pageInfo.endCursor) {
    throw new Error(
      `Linear release ${releaseId} issues pagination is missing endCursor`
    )
  }
}

function dedupeReleaseIssues(
  issues: Array<{ id: string }>
): Array<{ id: string }> {
  const seen = new Set<string>()
  return issues.filter((issue) => {
    const id = issue.id?.trim()
    if (!id || seen.has(id)) return false
    seen.add(id)
    return true
  })
}

async function fetchAllReleaseIssues(
  release: LinearRelease,
  beforeRequest: BeforeRequest,
  requestBudget: { remaining: number }
): Promise<LinearRelease> {
  assertReleaseIssuesConnection(release.issues, release.id)
  if (!release.issues.pageInfo.hasNextPage) {
    return {
      ...release,
      issues: {
        ...release.issues,
        nodes: dedupeReleaseIssues(release.issues.nodes),
      },
    }
  }

  const issues = [...release.issues.nodes]
  const seenCursors = new Set<string>()
  let pageInfo = release.issues.pageInfo

  while (pageInfo.hasNextPage) {
    if (requestBudget.remaining <= 0) {
      throw new Error(
        `Linear release issues exceeded ${MAX_NESTED_RELEASE_ISSUE_REQUESTS_PER_PAGE} follow-up requests for one release page`
      )
    }

    const after = pageInfo.endCursor
    if (!after) {
      throw new Error(
        `Linear release ${release.id} issues pagination is missing endCursor`
      )
    }
    if (seenCursors.has(after)) {
      throw new Error(
        `Linear release ${release.id} issues pagination repeated cursor`
      )
    }
    seenCursors.add(after)
    requestBudget.remaining -= 1

    const data = await graphql<{
      release: { issues: LinearConnection<{ id: string }> } | null
    }>(RELEASE_ISSUES_QUERY, { releaseId: release.id, after }, beforeRequest)
    if (!data.release) {
      throw new Error(
        `Linear release ${release.id} disappeared while paginating issues`
      )
    }

    assertReleaseIssuesConnection(data.release.issues, release.id)
    issues.push(...data.release.issues.nodes)
    pageInfo = data.release.issues.pageInfo
  }

  return {
    ...release,
    issues: {
      nodes: dedupeReleaseIssues(issues),
      pageInfo,
    },
  }
}

export async function fetchReleasesPage(
  beforeRequest: BeforeRequest,
  options: FetchReleasesOptions = {}
): Promise<LinearPage<LinearRelease>> {
  const hasUpdatedAtFilter =
    options.updatedSince !== undefined || options.updatedBefore !== undefined
  const variables: Record<string, unknown> = {
    orderBy: hasUpdatedAtFilter ? "updatedAt" : "createdAt",
  }
  if (options.after) variables.after = options.after

  const updatedAt: { gte?: string; lt?: string } = {}
  if (options.updatedSince !== undefined) updatedAt.gte = options.updatedSince
  if (options.updatedBefore !== undefined) updatedAt.lt = options.updatedBefore
  if (Object.keys(updatedAt).length > 0) {
    variables.filter = { updatedAt }
  }

  const data = await graphql<{
    releases: LinearConnection<LinearRelease>
  }>(RELEASES_QUERY, variables, beforeRequest)
  const page = connectionToPage(data.releases, options.after, "releases")

  const resources: LinearRelease[] = []
  const nestedRequestBudget = {
    remaining: MAX_NESTED_RELEASE_ISSUE_REQUESTS_PER_PAGE,
  }
  for (const release of page.resources) {
    resources.push(
      await fetchAllReleaseIssues(release, beforeRequest, nestedRequestBudget)
    )
  }

  return { ...page, resources }
}

const INITIATIVES_QUERY = /* GraphQL */ `
  query Initiatives($after: String) {
    initiatives(
      first: ${INITIATIVE_PAGE_SIZE}
      after: $after
      orderBy: createdAt
      includeArchived: true
    ) {
      nodes {
        id
        name
        slugId
        url
        status
        health
        lastUpdate {
          body
          createdAt
          updatedAt
          url
          user {
            name
            displayName
            email
          }
        }
        owner {
          name
          displayName
          email
        }
        projects(
          first: ${INITIATIVE_NESTED_PAGE_SIZE}
          orderBy: createdAt
          includeArchived: true
          includeSubInitiatives: true
        ) {
          nodes {
            id
            name
            url
            updatedAt
            archivedAt
            trashed
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
        targetDate
        startedAt
        completedAt
        createdAt
        updatedAt
        description
        content
        archivedAt
        trashed
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`

const INITIATIVE_PROJECTS_QUERY = /* GraphQL */ `
  query InitiativeProjects($initiativeId: String!, $after: String!) {
    initiative(id: $initiativeId) {
      projects(
        first: ${INITIATIVE_NESTED_PAGE_SIZE}
        after: $after
        orderBy: createdAt
        includeArchived: true
        includeSubInitiatives: true
      ) {
        nodes {
          id
          name
          url
          updatedAt
          archivedAt
          trashed
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`

function assertInitiativeProjectsConnection(
  projects: LinearConnection<LinearInitiativeProject>,
  initiativeId: string
): void {
  if (!projects || !Array.isArray(projects.nodes) || !projects.pageInfo) {
    throw new Error(
      `Linear initiative ${initiativeId} has an invalid projects connection`
    )
  }
  if (typeof projects.pageInfo.hasNextPage !== "boolean") {
    throw new Error(
      `Linear initiative ${initiativeId} projects response is missing hasNextPage`
    )
  }
  if (projects.pageInfo.hasNextPage && !projects.pageInfo.endCursor) {
    throw new Error(
      `Linear initiative ${initiativeId} projects pagination is missing endCursor`
    )
  }
}

function dedupeInitiativeProjects(
  projects: LinearInitiativeProject[]
): LinearInitiativeProject[] {
  const projectsById = new Map<string, LinearInitiativeProject>()
  for (const project of projects) {
    const existing = projectsById.get(project.id)
    const projectUpdatedAt = Date.parse(project.updatedAt)
    const existingUpdatedAt = existing
      ? Date.parse(existing.updatedAt)
      : Number.NaN
    if (
      !existing ||
      (Number.isFinite(projectUpdatedAt) &&
        (!Number.isFinite(existingUpdatedAt) ||
          projectUpdatedAt > existingUpdatedAt)) ||
      (projectUpdatedAt === existingUpdatedAt &&
        Boolean(existing.trashed) &&
        !project.trashed)
    ) {
      projectsById.set(project.id, project)
    }
  }
  return [...projectsById.values()]
}

async function fetchAllInitiativeProjects(
  initiative: LinearInitiative,
  beforeRequest: BeforeRequest,
  requestBudget: { remaining: number }
): Promise<LinearInitiative> {
  assertInitiativeProjectsConnection(initiative.projects, initiative.id)
  if (!initiative.projects.pageInfo.hasNextPage) {
    return {
      ...initiative,
      projects: {
        ...initiative.projects,
        nodes: dedupeInitiativeProjects(initiative.projects.nodes),
      },
    }
  }

  const projects = [...initiative.projects.nodes]
  const seenCursors = new Set<string>()
  let pageInfo = initiative.projects.pageInfo

  while (pageInfo.hasNextPage) {
    if (requestBudget.remaining <= 0) {
      throw new Error(
        `Linear initiative projects exceeded ${MAX_NESTED_INITIATIVE_PROJECT_REQUESTS_PER_PAGE} follow-up requests for one initiative page`
      )
    }

    const after = pageInfo.endCursor
    if (!after) {
      throw new Error(
        `Linear initiative ${initiative.id} projects pagination is missing endCursor`
      )
    }
    if (seenCursors.has(after)) {
      throw new Error(
        `Linear initiative ${initiative.id} projects pagination repeated cursor`
      )
    }
    seenCursors.add(after)
    requestBudget.remaining -= 1

    const data = await graphql<{
      initiative: {
        projects: LinearConnection<LinearInitiativeProject>
      } | null
    }>(
      INITIATIVE_PROJECTS_QUERY,
      { initiativeId: initiative.id, after },
      beforeRequest
    )
    if (!data.initiative) {
      throw new Error(
        `Linear initiative ${initiative.id} disappeared while paginating projects`
      )
    }

    assertInitiativeProjectsConnection(data.initiative.projects, initiative.id)
    projects.push(...data.initiative.projects.nodes)
    pageInfo = data.initiative.projects.pageInfo
  }

  return {
    ...initiative,
    projects: {
      nodes: dedupeInitiativeProjects(projects),
      pageInfo,
    },
  }
}

export async function fetchInitiativesPage(
  beforeRequest: BeforeRequest,
  after?: string
): Promise<LinearPage<LinearInitiative>> {
  const data = await graphql<{
    initiatives: LinearConnection<LinearInitiative>
  }>(INITIATIVES_QUERY, after ? { after } : {}, beforeRequest)
  const page = connectionToPage(data.initiatives, after, "initiatives")
  const nestedRequestBudget = {
    remaining: MAX_NESTED_INITIATIVE_PROJECT_REQUESTS_PER_PAGE,
  }
  const resources: LinearInitiative[] = []
  for (const initiative of page.resources) {
    resources.push(
      await fetchAllInitiativeProjects(
        initiative,
        beforeRequest,
        nestedRequestBudget
      )
    )
  }

  return { ...page, resources }
}
