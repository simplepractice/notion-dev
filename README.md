# Linear → Notion worker (SimplePractice)

A Notion Worker that copies Linear projects, issues, and initiatives into
managed Notion databases for XFN stakeholders. This is a fork of Notion's
Linear cookbook template, not a self-hosted sync.

## Why projects use a nightly replacement

Milestone edits do not reliably bump their parent project's `updatedAt`.
An incremental project query can therefore miss milestone names and dates
even when the parent project otherwise looks unchanged.

Linear's per-request complexity cap forced the project GraphQL page size
down to 20 (from the cookbook's 50), so a complete sweep of ~1,100 projects
is about 56 paginated runs. That is too expensive hourly but reasonable
once per day. The project sync therefore uses one nightly replacement:

| Sync              | Mode    | Schedule | What it does                                                              |
| ----------------- | ------- | -------- | ------------------------------------------------------------------------- |
| `projectsSync`    | replace | Daily    | Full sweep: refresh nested milestone data and remove missing projects     |
| `issuesSync`      | incremental | Daily | Fetch issues whose `updatedAt` falls in a pinned window                   |
| `issuesBackfill`  | replace | Manual   | Full issue sweep, run on demand                                           |
| `releasesSync`    | incremental | Hourly | Refresh issues attached to recently updated Linear releases              |
| `initiativesSync` | replace | Daily    | Full sweep because contributing-project membership has no reliable clock |

Project upserts intentionally omit `upstreamUpdatedAt`. Only one sync writes
project rows, and nested milestone changes do not advance the parent project
clock. Omitting it ensures every nightly row reflects the complete Linear
response.

## Why issues have no scheduled sweep

Projects can afford a daily full sweep because there are ~1,100 of them.
Issues are two orders of magnitude larger, so a daily replace would
rewrite the entire database every 24 hours for no benefit.

The daily delta covers creates, updates, archives, and soft deletes on
its own: all of them move `updatedAt`, and a trashed issue emits an
explicit delete. The workspace produces roughly 120 issue updates an
hour, so a normal daily cycle is roughly 29 pages at the current rate.

`issuesSync` also performs the **initial population**. `since` starts at
the epoch and `until` is pinned across the cycle, so the first cycle is
one continuous chained walk of every issue in the workspace. Expect it to
run for hours. Do not add an initial lookback to `incrementalWindow`;
with a manual-only backfill, that would leave the database holding an
hour of activity and nothing else.

`issuesBackfill` is a repair tool, not a schedule. Run it after adding a
property or regenerating `src/options.ts`, so existing rows pick up the
new values, or to clear an issue hard-deleted outside a delta window:

```sh
ntn workers sync trigger issuesBackfill
```

**Trade-off:** an issue destroyed in Linear without passing through trash
lingers until someone runs the backfill.

## Why releases rewrite issues

Linear `Done` is a bad proxy for mobile. An iOS Clinician ticket can sit
in Done for weeks while its release is still **Planned** (10.4.8), then
move to **Released** (10.4.7 on Sep 11) when App Store review finishes.
That stage change lives on the release, not the issue, and may not bump
`issue.updatedAt`.

`issuesSync` and `issuesBackfill` already read `Issue.releases` and write
**Release**, **Release stage**, **Released at**, and **Release pipeline**.
`releasesSync` is the freshness path: each hour it fetches releases whose
`updatedAt` is in a pinned window and re-upserts the issues on those
releases. The first cycle looks back seven days, not the epoch, so it
does not refetch every issue that ever sat on a release.

After adding these properties, run the backfill once so existing mobile
rows pick up their current Planned/Released values:

```sh
ntn workers sync trigger issuesBackfill
```

## Quickstart

You need Node.js 22+ and a
[Linear personal API key](#getting-a-linear-personal-api-key) whose user
can read the work you want to copy. Create the key in **Linear >
Settings > Security & access > API keys** (read is sufficient).

```sh
npm install --global ntn
cd /Users/noah/dev/work/notion-dev
npm install
ntn login
# If `ntn workers` fails with "No workspace selected", unset NOTION_API_TOKEN.
# A bot token in the environment overrides user login and cannot manage Workers.
unset NOTION_API_TOKEN
ntn workers deploy
ntn workers env set LINEAR_API_KEY=lin_api_your-key-here
```

Populate immediately (bypass the schedule):

```sh
ntn workers sync trigger projectsSync
ntn workers sync trigger issuesSync
ntn workers sync trigger releasesSync
ntn workers sync trigger initiativesSync
```

`issuesSync`'s first cycle walks the whole workspace and takes hours.
Watch it with `ntn workers sync status`.

Everything visible to the API key is copied, including archived records.
Filter in Notion rather than in the worker.

## What you can answer

| Managed database       | Questions it helps answer                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Linear Projects**    | Which projects are at risk or approaching their target date? Who owns them, which teams, which initiative, which milestones? |
| **Linear Issues**      | What is in flight on a team or in a cycle, who owns it, how it rolls up to a project, and whether a mobile issue is Planned or Released. |
| **Linear Initiatives** | Which initiatives are at risk or approaching their target date? Which strategic initiatives have no contributing projects?  |

## Reference

### Synced databases and schedules

Three databases are maintained by five syncs:

| Database               | Sync                         | Mode        | Schedule |
| ---------------------- | ---------------------------- | ----------- | -------- |
| **Linear Projects**    | `projectsSync`               | replace     | Daily    |
| **Linear Issues**      | `issuesSync`                 | incremental | Daily    |
| **Linear Issues**      | `issuesBackfill`             | replace     | Manual   |
| **Linear Issues**      | `releasesSync`               | incremental | Hourly   |
| **Linear Initiatives** | `initiativesSync`            | replace     | Daily    |

Syncs that share a database target the same managed database.
Declaration order matters: initiatives first so projects can relate to
them, projects before issues so issues can relate to projects.

#### Linear Projects

| Notion property      | Linear field                                      | Type        |
| -------------------- | ------------------------------------------------- | ----------- |
| Name                 | `name`                                            | title       |
| Status               | workspace-specific `status.name`                  | select      |
| Health               | `health`                                          | select      |
| Lead                 | `lead.email`                                      | people      |
| Teams                | `teams.nodes[].name` (or `key`)                   | multiSelect |
| Project Link         | `url`                                             | url         |
| Linked Resources     | `externalLinks` and `documents`                   | file        |
| Summary              | short `description`                               | richText    |
| Related Initiative   | non-archived `initiatives.nodes[].id`             | relation    |
| Labels               | `labels.nodes[].name`                             | multiSelect |
| Milestones           | `projectMilestones` names with target dates       | richText    |
| Progress %           | `progress` converted from 0–1 to 0–100            | number      |
| Target Date          | `targetDate`                                      | date        |
| Updated              | `updatedAt`                                       | date        |
| Last Update At       | `lastUpdate.updatedAt`                            | date        |
| Last Update Link     | `lastUpdate.url`                                  | url         |
| Status Category      | canonical category from `status.type`             | select      |
| Priority             | `priorityLabel` or `priority`                     | select      |
| Start Date           | planned `startDate`                               | date        |
| Started              | timestamp the project entered a started status    | date        |
| Completed            | `completedAt`                                     | date        |
| Canceled             | `canceledAt`                                      | date        |
| Created              | `createdAt`                                       | date        |
| Archived             | whether `archivedAt` is set                       | checkbox    |
| Slug ID              | `slugId`                                          | richText    |
| Linear Project ID    | `id`                                              | richText    |

Each project page body starts with the latest status-update narrative,
then Linear's richer `content` (or `description` fallback), then linked
resources. **Status** preserves the team's custom name; **Status
Category** is the stable rollup. **Start Date** is the planned date;
**Started** is when Linear recorded the project actually starting.

**Linear Project ID**, the immutable UUID, is the primary key.

**Select options must be declared up front.** Notion silently drops
select and multi-select writes whose option is missing from the schema.
See [Generated select options](#generated-select-options).

**Milestones** are rich text, not multi-select. Milestone names are
freeform per project (hundreds of distinct values) and would not be a
usable dropdown. They render as `Beta (2026-06-01) · GA`.

Every milestone is synced, not just the first nested page. Milestones are
the one project connection that routinely runs past the nested page size —
a release project carries one per dev workstream and finishes with EA and
GA — so the client paginates `projectMilestones` to completion. Truncating
here would silently drop the trailing EA/GA dates that downstream launch
automations read, and a missing milestone is indistinguishable from one
that was never defined. The walk is bounded per project page and fails the
page rather than returning a short list.

**Related Initiative** is a two-way relation onto the initiatives
database (`Projects` on the initiative side).

#### Linear Initiatives

| Notion property      | Linear field                  | Type     |
| -------------------- | ----------------------------- | -------- |
| Name                 | `name`                        | title    |
| Status               | `status`                      | select   |
| Health               | `health`                      | select   |
| Owner                | `owner.email` when present    | people   |
| Initiative Link      | `url`                         | url      |
| Project Count        | all contributing `projects`   | number   |
| Target Date          | `targetDate`                  | date     |
| Last Update At       | `lastUpdate.updatedAt`        | date     |
| Last Update Link     | `lastUpdate.url`              | url      |
| Updated              | `updatedAt`                   | date     |
| Started              | `startedAt`                   | date     |
| Completed            | `completedAt`                 | date     |
| Created              | `createdAt`                   | date     |
| Archived             | whether `archivedAt` is set   | checkbox |
| Slug ID              | `slugId`                      | richText |
| Linear Initiative ID | `id`                          | richText |

Each initiative page body starts with its latest update, then lists
contributing projects (including inherited and archived), then the
overview. **Project Count** is exact for projects visible to the API
key. The body renders up to 100 alphabetized project links and points
at Linear when more exist.

**Linear Initiative ID** is the primary key.

Initiatives fail visibly if the Linear plan or the authenticated user
cannot read them, rather than replacing the database with an empty
snapshot.

#### Linear Issues

| Notion property    | Linear field                                | Type        |
| ------------------ | ------------------------------------------- | ----------- |
| Title              | `title`                                     | title       |
| Issue Key          | `identifier` (e.g. `ENG-321`)               | richText    |
| Status             | workspace-specific `state.name`             | select      |
| Priority           | `priorityLabel` or `priority`               | select      |
| Assignee           | `assignee.displayName` or `name`            | richText    |
| Issue Link         | `url`                                       | url         |
| Updated            | `updatedAt`                                 | date        |
| Workflow Category  | canonical category from `state.type`        | select      |
| Team               | `team.name` (or `key`)                      | select      |
| Project            | `project.id`                                | relation    |
| Cycle              | `cycle.name`, falling back to `Cycle {n}`   | richText    |
| Labels             | `labels.nodes[].name`                       | richText    |
| Release            | `releases` version or name (e.g. `10.4.7`)  | richText    |
| Release stage      | workspace-custom `stage.name`               | select      |
| Released at        | `release.completedAt`                       | date        |
| Release pipeline   | `release.pipeline.name`                     | richText    |
| Estimate           | `estimate`                                  | number      |
| Due Date           | `dueDate`                                   | date        |
| Started            | `startedAt`                                 | date        |
| Completed          | `completedAt`                               | date        |
| Canceled           | `canceledAt`                                | date        |
| Created            | `createdAt`                                 | date        |
| Archived           | whether `archivedAt` is set                 | checkbox    |
| Linear Issue ID    | `id`                                        | richText    |

Issue rows have **no page body**. Linear descriptions are arbitrary
markdown and have stalled both `issuesSync` and `issuesBackfill` on
Notion's markdown diff. Open the issue from **Issue Link**. Existing
bodies already written are left in place; later upserts do not send
`pageContentMarkdown`, so Notion does not rewrite them.

**Linear Issue ID**, the immutable UUID, is the primary key.

**Project is a relation**, one-way, into the Linear Projects database,
keyed on the Linear project UUID. It is not a select: there are ~1,100
projects and the set turns over weekly, so a baked option list would
silently drop new ones. One-way keeps an `Issues` property off the
projects schema, where it would fan out to thousands of back-references
per project.

**Cycle is rich text**, not a select, for the same reason Milestones are.
Cycles are per team and numbered, new ones appear every fortnight
forever, and `Cycle 46` means a different fortnight on every team.

**Labels are rich text too**, rendered as `bug · api · Tier 1`. The
workspace has roughly a thousand distinct label names and mints new ones
by the hour — 17 appeared during one half-hour window while this was
built, which is what an agent-driven triage workflow looks like from
here. A declared option list would be stale the moment it deployed and
would silently drop every label created since. Rich text is always
complete and needs no redeploy; filter with a `contains` text filter,
keeping in mind that `Low` also matches `Below`.

Label groups were considered as a stable low-cardinality facet and
rejected: 845 of 1,784 labels have no parent group, and there are still
82 distinct groups.

**Workflow Category is generated**, not hardcoded. `WorkflowState.type`
is an open string in Linear's schema rather than an enum. A hardcoded
list of six categories missed `duplicate`, so every duplicate-closed
issue lost its category.

If an issue is on more than one release, the worker prefers an open
(planned/started) release, otherwise the most recently completed one.

`Status`, `Team`, `Workflow Category`, and `Release stage` come from
`src/options.ts`.

### Generated select options

Notion sync schemas declare select and multi-select options up front, and
a value Linear returns that is not declared is dropped on write with no
error. `src/options.ts` holds every workspace-defined option list:

| Constant                    | Source (Linear root connection) | Used by                                   |
| --------------------------- | ------------------------------- | ----------------------------------------- |
| `PROJECT_STATUS_OPTIONS`    | `projectStatuses`               | projects `Status`                         |
| `PROJECT_LABEL_OPTIONS`     | `projectLabels`                 | projects `Labels`                         |
| `TEAM_OPTIONS`              | `teams`                         | projects `Teams`, issues `Team`           |
| `ISSUE_STATUS_OPTIONS`      | `workflowStates`                | issues `Status`                           |
| `WORKFLOW_CATEGORY_OPTIONS` | `workflowStates[].type`         | issues `Workflow Category`                |
| `RELEASE_STAGE_OPTIONS`     | `releaseStages` plus a seed     | issues `Release stage`                    |

Issue labels are deliberately not in that table — they are rich text on
the Issues database, so nothing about them has to be declared or kept
current.

Regenerate and redeploy whenever those change in Linear:

```sh
LINEAR_API_KEY=lin_api_... npm run options
ntn workers deploy
```

`npm run options:check` fetches live, diffs against the committed file,
and exits non-zero on drift. Run it on a schedule: issue labels and
workflow states churn weekly, and nothing in the worker can self-heal a
stale schema.

Options come from Linear's **root connections**, not by walking resource
pages. Walking projects — the original approach — found 66 of 79 teams,
9 of 12 project statuses, and 73 of 95 project labels, because it only
ever saw values attached to a project. Walking tens of thousands of
issues to learn an option set is not viable at all.

`TEAM_OPTIONS` is the one list generated from both directions. Deleting a
team in Linear does not clear it from the projects that referenced it:
five names live projects still carry (`Anton`, `Security Confidential`,
three `[OLD] …` teams) are absent from the root `teams` connection.
Generating from the root connection alone would drop them from the
projects database, so the generator unions in a project walk.

The lists that remain all churn slowly — project statuses, project
labels, teams, and workflow states change when someone reconfigures a
team, not continuously. Issue labels were the one fast-moving list, and
they are rich text precisely so this mechanism does not have to keep up
with them.

Notion's documented 100-option limit caps a multi-select *value* in one
request, not how many options a property may declare, and no issue
carries 100 labels. The schema payload is roughly 50 KB against a 500 KB
request limit. Still, ~994 declared options is well past anything this
has been tested at: watch the first `ntn workers deploy` after a
regeneration. If Notion rejects the Labels schema, the fallback is rich
text, the same way Cycle and Milestones are handled.

The generator imports `teamSelectNames`, `labelSelectNames`,
`selectName`, and `workflowCategoryLabel` from `src/helpers.ts`, the same
functions the transforms use. That is deliberate: whatever normalizes a
name for the schema has to be the thing that normalizes it for the write,
or the value is dropped. Commas are the usual culprit —
`Builder.multiSelect("A", "B")` serializes to `"A,B"`, so an option name
containing a comma cannot round-trip.

### Project structure

```text
src/
├── index.ts       — registers databases and syncs
├── linear.ts      — GraphQL client, cursor pagination, rate-limit handling
├── sync-state.ts  — serializable cursor and incremental-window transitions
├── options.ts     — generated select and multi-select option lists
├── projects.ts    — project schema and transform
├── issues.ts      — issue schema and transform
├── initiatives.ts — initiative schema and transform
└── helpers.ts     — shared labels, people, dates, and content helpers
scripts/
└── generate-options.mts — rewrite src/options.ts from live Linear
```

### How it works

1. **Projects (daily).** Cursor-paginated replacement in
   stable `createdAt` order, no `updatedAt` filter. Replace mode compares
   the complete key set and removes rows Linear no longer returns. Because
   project upserts have no `upstreamUpdatedAt`, milestone-only changes are
   rewritten even when the parent project's timestamp is unchanged.
2. **Issue delta (daily).** The first
   cycle starts at the epoch and therefore populates the database.
3. **Issue backfill (manual).** A full replacement triggered by hand.
4. **Release freshness (hourly).** Filter Linear `releases` on `updatedAt`
   and re-upsert the issues attached to those releases. The first cycle
   looks back seven days. This exists because moving a release from
   Planned to Released may not bump `issue.updatedAt`.
5. **Initiatives (daily).** Full replacement. Rows refresh each sweep
   because contributing-project
   membership is derived data without a safe monotonic timestamp for
   removals.
6. Pagination uses Linear's Relay connections (`after`,
   `pageInfo.hasNextPage`, `pageInfo.endCursor`). Projects request 20
   records per page; nested teams/labels/links request 10; nested
   milestones request 10 and are then paginated to completion; nested
   initiatives request 5. Issues request 100, with nested labels
   at 20 and nested releases at 10. Releases request 20, with nested
   issue ids at 50 then paginated to completion. The project limits exist to stay under Linear's per-request
   complexity cap (~10,000); the issue page size is about payload and
   batch size, not complexity (see below). The client rejects a missing cursor, and persisted
   cursor history detects repeats and longer cycles.
7. Cursor history is capped at the 50 most recent cursors, because an
   issue cycle runs into the thousands of pages and every cursor is
   persisted between executions. A page counter (20,000) is the backstop
   for a loop that outlives the retained window.
8. Initiative projects are independently cursor-paginated, including
   projects inherited through sub-initiatives. A shared 20-request bound
   fails the initiative page instead of returning a false count.
9. Project milestones are independently cursor-paginated the same way, so
   projects with more than 10 milestones keep their trailing EA/GA
   entries. A shared 40-request bound covers a follow-up for every project
   on a page and fails the page instead of writing a truncated list.
   `PROJECT_MILESTONE_PAGE_SIZE` stays at 10 so the base projects query's
   complexity is unchanged; raising it trades follow-up requests for
   complexity and needs an `x-complexity` measurement first.

All list queries pass `includeArchived: true`. Archived resources stay
available for history and are marked with the **Archived** checkbox.

### Suggested Notion views

- **Active projects:** filter Archived off and Status Category to
  Backlog, Planned, Started, or Paused; sort by Health and Target Date.
- **Team board:** filter Issues on Team and Workflow Category (Started,
  Unstarted), group by Status, sort by Priority. Labels are rich text,
  so narrow by label with a `contains` filter.
- **Project rollup:** group Issues by the Project relation to see
  everything in flight under a project alongside its Projects row.
- **Leadership initiatives:** filter Archived off, group by Health, and
  sort by Target Date. Use Project Count to find strategic goals with no
  associated projects.
- **History:** filter Archived on rather than mixing historical records
  into the default active view.

### Rate limits and query complexity

Every GraphQL request from every live sync shares one pacer set to
**2,000 requests per hour**. Linear documents 2,500 requests per
authenticated user per hour; the pacer leaves headroom. Multiple keys
belonging to the same user share that quota.

That budget is apportioned across every sync using the pacer, so adding
a sync dilutes the ones already there. A declared-but-idle manual sync
may still hold a share; if `projectsSync` throughput drops after a
deploy, `ntn workers capabilities disable issuesBackfill` between runs is
the mitigation.

Linear also applies a separate hourly query-complexity budget (3,000,000
points) and rejects an individual query above 10,000 points. Measured on
this workspace, the issues query costs **16 points** (`x-complexity`) at
page sizes of 50, 100, and 250 alike, so complexity is not what bounds
it — the **request budget binds first**.

`ISSUE_PAGE_SIZE` is therefore set by payload and batch size, not
complexity: 100 issues is a ~280 KB response and a change batch the
Workers runtime is comfortable with, where 250 measured at ~584 KB. The
projects query is a different story — its nested connections are why
`PROJECT_PAGE_SIZE` is 20 — so do not raise that one without measuring.
Read `x-complexity` off any response to get the real number.

Issues and initiatives no longer share a page-size constant.
`ISSUE_PAGE_SIZE` and `ISSUE_LABEL_PAGE_SIZE` are separate from
`INITIATIVE_PAGE_SIZE` and `INITIATIVE_NESTED_PAGE_SIZE`, because one
shared `PAGE_SIZE` meant that tuning issues silently retuned initiatives.
Nested labels dominate the per-request issue complexity, so shrink the
label page before shrinking the outer page.

The client treats HTTP 429 and GraphQL `RATELIMITED` as rate limits,
reads `Retry-After` and Linear's reset headers, and passes the longest
delay to the Workers runtime. Partial GraphQL responses are rejected so
missing fields cannot become incomplete Notion pages.

### Linear access and credentials

The key's Linear visibility defines what the worker can copy.

#### Getting a Linear personal API key

1. Open Linear and go to **Settings > Security & access > API keys**.
2. Create a new personal API key, give it a recognizable label, and copy it.
3. Store it as `LINEAR_API_KEY`; Linear only shows the secret when it is
   created.

The worker sends this value directly in Linear's `Authorization` header.
Do not add a `Bearer` prefix. You do not need to provide a
`NOTION_API_TOKEN` for Workers CLI commands; that env var overrides
`ntn login` and will break `ntn workers *`.

### Configuration reference

| Variable         | Description                                                |
| ---------------- | ---------------------------------------------------------- |
| `LINEAR_API_KEY` | Personal API key with access to the resources being synced |

For local execution, copy `.env.example` to `.env` and add your key.
`.env` is gitignored.

### Local verification

```sh
npm test
```

Run a sync locally against the Linear workspace accessible to the key in
`.env`:

```sh
ntn workers exec projectsSync --local
ntn workers exec issuesSync --local
ntn workers exec releasesSync --local
ntn workers exec initiativesSync --local
```

Use `--preview` when triggering a deployed sync whose returned fields you
want to inspect before writing to Notion.

### Operational notes

Linear recommends webhooks instead of polling for production
integrations that can receive events. Workers syncs currently use
scheduled execution, so this worker polls incrementally and keeps
replacement sweeps as a repair path. A webhook-capable deployment can
keep the same split.

**First run after deploying issues:**

1. `ntn workers deploy`.
2. `ntn workers sync trigger issuesSync`. The first cycle chains from the
   epoch through every issue in the workspace and runs for hours. Watch
   `ntn workers sync status`; it is done when the watermark leaves the
   epoch.
3. After that the daily schedule fetches only changes since the preceding
   watermark.

If the first cycle stalls, the levers are a larger `ISSUE_PAGE_SIZE`
and the bounded cursor state in `src/sync-state.ts`. Issue descriptions
are not written as page bodies.

Linear-hosted images embedded in Markdown may require Linear
authentication; Notion readers who are not signed into Linear may not
be able to render them.

Worker-managed databases are owned by the worker. They cannot currently
write into a pre-existing Notion database.

### Adapting the schema

| Resource    | File                 |
| ----------- | -------------------- |
| Projects    | `src/projects.ts`    |
| Issues      | `src/issues.ts`      |
| Initiatives | `src/initiatives.ts` |

Adding a property to an existing database does not backfill rows the
delta has not touched. Run the matching replacement sweep afterwards
(`issuesBackfill` for issues).

To add a Linear field:

1. Add it to the resource's GraphQL selection and TypeScript type in
   `src/linear.ts`.
2. Add a property with the appropriate `Schema.*` type in the resource
   file. Select and multi-select properties need a non-empty option
   list (`scripts/generate-options.mts` for workspace-defined values).
3. Add the matching `Builder.*` value in the resource transform,
   preserving schema order.
4. Add standard, minimal, and relevant edge-case assertions to `test.ts`.

Keep the immutable UUID property as each database's primary key.

## Learn more

- [Notion Workers documentation](https://developers.notion.com/docs/workers)
- [Linear GraphQL API — Getting started](https://linear.app/developers/graphql)
- [Linear GraphQL API — Pagination](https://linear.app/developers/pagination)
- [Linear GraphQL API — Filtering](https://linear.app/developers/filtering)
- [Linear GraphQL API — Rate limiting](https://linear.app/developers/rate-limiting)
- [Linear documentation — Delete and archive issues](https://linear.app/docs/delete-archive-issues)
- [Linear documentation — Initiatives](https://linear.app/docs/initiatives)
- [Linear documentation — Initiative and Project updates](https://linear.app/docs/initiative-and-project-updates)
- [Linear documentation — Sub-initiatives](https://linear.app/docs/sub-initiatives)
