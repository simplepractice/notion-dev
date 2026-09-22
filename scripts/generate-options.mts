// Regenerates src/options.ts from the live Linear workspace.
//
// Notion sync schemas require select/multi-select options to be declared up
// front, so workspace-defined values have to be baked into the deploy. Values
// Linear returns that are not declared are silently dropped.
//
//   LINEAR_API_KEY=lin_api_... npx tsx scripts/generate-options.mts
//   LINEAR_API_KEY=lin_api_... npx tsx scripts/generate-options.mts --check
//
// `--check` fetches live, diffs against the committed src/options.ts, and
// exits non-zero on drift. Wired up as `npm run options:check`. Run it on a
// schedule: issue labels and workflow states churn weekly and nothing in the
// worker can self-heal a stale schema.
//
// Options come from Linear's root connections, not from walking resource
// pages. Walking projects (the previous approach) found 66 of 79 teams, 9 of
// 12 project statuses, and 73 of 95 project labels, because it only ever saw
// values attached to a project. Walking tens of thousands of issues to learn
// an option set is not viable at all.
//
// Teams are the one exception, and are the union of both directions — see
// projectTeamNames() below.
//
// Issue labels are deliberately absent: ~1,000 distinct names growing by the
// hour cannot be kept current in a deployed schema, so issues render them as
// rich text (see labelSummary in src/helpers.ts).
//
// After regenerating, redeploy with `ntn workers deploy`.

import { readFile, writeFile } from "node:fs/promises"

import {
  labelSelectNames,
  selectName,
  teamSelectNames,
  workflowCategoryLabel,
} from "../src/helpers.js"

const API_URL = "https://api.linear.app/graphql"
const PAGE_SIZE = 100

const OPTIONS_FILE = new URL("../src/options.ts", import.meta.url)

type PageInfo = { hasNextPage: boolean; endCursor: string | null }
type Connection<Node> = { nodes: Node[]; pageInfo: PageInfo }

type NamedNode = { name: string | null }
type TeamNode = { name: string | null; key: string | null }
type WorkflowStateNode = { name: string | null; type: string | null }
type ProjectTeamsNode = { teams: { nodes: TeamNode[] } }

async function request<Data>(
  query: string,
  variables: Record<string, unknown>
): Promise<Data> {
  const apiKey = process.env.LINEAR_API_KEY?.trim()
  if (!apiKey) throw new Error("LINEAR_API_KEY is not set.")

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  })

  const body = (await response.json()) as {
    data?: Data | null
    errors?: { message?: string }[]
  }

  if (body.errors?.length) {
    throw new Error(body.errors.map((error) => error.message).join("; "))
  }
  if (!body.data) {
    throw new Error(`Linear response is missing data (HTTP ${response.status})`)
  }
  return body.data
}

/**
 * Walk a root connection to exhaustion. Every cursor is recorded so a server
 * that loops returns an error instead of spinning forever.
 */
async function paginate<Node>(
  field: string,
  selection: string
): Promise<Node[]> {
  const query = /* GraphQL */ `
    query Options($after: String) {
      ${field}(first: ${PAGE_SIZE}, after: $after, includeArchived: true) {
        nodes { ${selection} }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `

  const nodes: Node[] = []
  const seenCursors = new Set<string>()
  let after: string | undefined

  for (;;) {
    const data = await request<Record<string, Connection<Node>>>(query, {
      after: after ?? null,
    })
    const page = data[field]
    if (!page) throw new Error(`Linear response is missing ${field}`)

    nodes.push(...page.nodes)
    if (!page.pageInfo.hasNextPage) return nodes

    const nextCursor = page.pageInfo.endCursor
    if (!nextCursor) {
      throw new Error(`Linear ${field} pagination is missing next cursor`)
    }
    if (seenCursors.has(nextCursor)) {
      throw new Error(`Linear ${field} pagination repeated cursor`)
    }
    seenCursors.add(nextCursor)
    after = nextCursor
  }
}

/**
 * Teams a project reports that the root `teams` connection does not return.
 *
 * Deleting a team in Linear does not clear it from the projects that
 * referenced it: this workspace has five such names ("Anton",
 * "Security Confidential", three "[OLD] …" teams) that live projects still
 * carry. Generating TEAM_OPTIONS from the root connection alone would drop
 * them from the projects database on the next deploy. Costs ~12 requests.
 */
async function projectTeamNames(): Promise<string[]> {
  const query = /* GraphQL */ `
    query ProjectTeams($after: String) {
      projects(first: ${PAGE_SIZE}, after: $after, includeArchived: true) {
        nodes {
          teams(first: 20) {
            nodes {
              name
              key
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

  const names: string[] = []
  const seenCursors = new Set<string>()
  let after: string | undefined

  for (;;) {
    const data = await request<{ projects: Connection<ProjectTeamsNode> }>(
      query,
      { after: after ?? null }
    )
    for (const project of data.projects.nodes) {
      names.push(...teamSelectNames(project.teams.nodes))
    }
    if (!data.projects.pageInfo.hasNextPage) return names

    const nextCursor = data.projects.pageInfo.endCursor
    if (!nextCursor) {
      throw new Error("Linear projects pagination is missing next cursor")
    }
    if (seenCursors.has(nextCursor)) {
      throw new Error("Linear projects pagination repeated cursor")
    }
    seenCursors.add(nextCursor)
    after = nextCursor
  }
}

function sorted(values: Iterable<string>): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const value of [...values].sort((left, right) =>
    left.localeCompare(right)
  )) {
    const folded = value.toLocaleLowerCase()
    if (seen.has(folded)) continue
    seen.add(folded)
    result.push(value)
  }
  return result
}

function renderList(values: string[]): string {
  return values.map((value) => `  ${JSON.stringify(value)},`).join("\n")
}

function renderConstant(name: string, values: string[]): string {
  return `export const ${name} = [\n${renderList(values)}\n] as const`
}

async function collectOptions(): Promise<string> {
  const [
    projectStatuses,
    projectLabels,
    teams,
    workflowStates,
    legacyTeams,
    releaseStages,
  ] = await Promise.all([
    paginate<NamedNode>("projectStatuses", "name"),
    paginate<NamedNode>("projectLabels", "name"),
    paginate<TeamNode>("teams", "name key"),
    paginate<WorkflowStateNode>("workflowStates", "name type"),
    projectTeamNames(),
    paginate<NamedNode>("releaseStages", "name"),
  ])

  // Every list goes through the same normalizer the transforms use, so the
  // generator and the transform cannot disagree about what a value looks like.
  const projectStatusOptions = sorted(
    projectStatuses.flatMap((status) => selectName(status.name) ?? [])
  )
  const projectLabelOptions = sorted(labelSelectNames(projectLabels))
  const teamOptions = sorted([...teamSelectNames(teams), ...legacyTeams])
  const issueStatusOptions = sorted(
    workflowStates.flatMap((state) => selectName(state.name) ?? [])
  )
  const workflowCategoryOptions = sorted(
    workflowStates.flatMap(
      (state) => selectName(workflowCategoryLabel(state.type)) ?? []
    )
  )
  // Seed the canonical Linear stage types plus "Released", the name this
  // workspace uses for completed mobile trains. Live releaseStages overlay
  // any additional custom names.
  const releaseStageOptions = sorted([
    "Canceled",
    "Completed",
    "Planned",
    "Released",
    "Started",
    ...releaseStages.flatMap((stage) => selectName(stage.name) ?? []),
  ])
  console.error(
    [
      `projectStatuses=${projectStatusOptions.length}`,
      `projectLabels=${projectLabelOptions.length}`,
      `teams=${teamOptions.length}`,
      `teamsOnlyOnProjects=${teamOptions.length - teamSelectNames(teams).length}`,
      `issueStatuses=${issueStatusOptions.length}`,
      `workflowCategories=${workflowCategoryOptions.length}`,
      `releaseStages=${releaseStageOptions.length}`,
    ].join(" ")
  )

  return `// Generated by scripts/generate-options.mts — do not edit by hand.
//
// Notion sync schemas must declare select and multi-select options up front.
// Values Linear returns that are absent here will not appear in Notion, so
// regenerate and redeploy when teams, labels, statuses, workflow states,
// or release stages change. \`npm run options:check\` fails when this file has drifted.

${renderConstant("PROJECT_STATUS_OPTIONS", projectStatusOptions)}

${renderConstant("PROJECT_LABEL_OPTIONS", projectLabelOptions)}

// Shared by projects (multi-select) and issues (select).
${renderConstant("TEAM_OPTIONS", teamOptions)}

${renderConstant("ISSUE_STATUS_OPTIONS", issueStatusOptions)}

// WorkflowState.type is an open string in Linear's schema, not an enum, so
// this is generated rather than hardcoded. "Duplicate" is the value the
// hardcoded list used to miss.
${renderConstant("WORKFLOW_CATEGORY_OPTIONS", workflowCategoryOptions)}

// Workspace-custom names (iOS Clinician uses "Released" for completed).
// Canonical type labels are seeded so a rename cannot blank the select.
${renderConstant("RELEASE_STAGE_OPTIONS", releaseStageOptions)}
`
}

const check = process.argv.includes("--check")
const generated = await collectOptions()

if (check) {
  const committed = await readFile(OPTIONS_FILE, "utf8").catch(() => "")
  if (committed === generated) {
    console.log("src/options.ts is up to date.")
  } else {
    console.error(
      "src/options.ts has drifted from Linear. Run `npx tsx scripts/generate-options.mts` and redeploy."
    )
    process.exitCode = 1
  }
} else {
  await writeFile(OPTIONS_FILE, generated)
  console.log("Wrote src/options.ts")
}
