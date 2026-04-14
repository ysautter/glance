# GitLab Gantt & Roadmap

A single-file web application for visualizing GitLab milestones and issues as interactive Gantt charts, roadmaps, and Kanban boards. Connect to any GitLab instance (including self-hosted) with a personal access token.

## Getting Started

1. Open `index.html` in a browser
2. Enter your GitLab instance URL, personal access token, and project/group path
3. The app fetches all milestones, labels, and issues automatically

Your token needs the `api` scope (or `read_api` if you only need read access — board drag-and-drop requires `api`).

## Views

### Gantt Chart

Timeline visualization of milestones and their issues.

- **Three zoom levels**: week, month, quarter
- **Issue hierarchy**: parent-child relationships displayed as collapsible trees, detected via GitLab GraphQL API, `parent_id`, or description task lists
- **Date extraction**: reads `GanttStart: YYYY-MM-DD` / `GanttDue: YYYY-MM-DD` from issue descriptions, falls back to `due_date`, then milestone dates
- **Resizable split pane**: drag the divider between the issue list and the timeline
- **Today line**: red vertical indicator with a button to scroll to today
- **Rich tooltips**: hover any bar for full details — dates, state, labels, assignees, time tracking, parent/child info
- **Visual metadata on bars**: type badges (BUG, FEAT, DOCS, etc.), effort estimates (XS–XL), assignee avatars, milestone chips
- **Click any row or bar** to open it in GitLab

### Roadmap

Quarterly overview of milestones with progress indicators.

- Milestones grouped by quarter
- Progress bars showing closed/total issues
- Filter by milestone state: active, closed, or all

### Boards (Kanban)

Label-based issue boards with full GitLab sync.

- **Multiple boards**: create named boards by selecting which labels become columns
- **Unassigned column**: always shown first, catches issues without any column label
- **Drag-and-drop issues**: move cards between columns — the app calls the GitLab API to add/remove labels accordingly
- **Reorder cards**: drag within a column to set a custom order (persisted in localStorage)
- **Reorder columns**: drag column headers to rearrange
- **Per-column label filter**: click the filter button on any column header to show only issues matching specific labels
- **State filter**: toggle between open, closed, or all issues
- **Scroll position preserved** across re-renders

## Issue Metadata

The app recognizes labels matching these patterns and displays them as compact badges:

| Category | Labels | Display |
|----------|--------|---------|
| Type | `bug`, `feature`, `improvement`, `documentation`, `refactor`, `research` | BUG, FEAT, IMPROV, DOCS, REFAC, RESEARCH |
| Effort | `xs`, `s`, `m`, `l`, `xl` | XS, S, M, L, XL |
| Priority | `urgent`, `high`, `medium`, `low` | !!!, !!, !, ~ |
| Status | `in-progress`, `blocked`, `ready-for-dev`, `in-qa`, etc. | Colored status badges |

## Data & Storage

- **API**: GitLab REST API v4 with automatic pagination; GraphQL for hierarchy detection
- **Groups**: fetches issues from all subgroups and nested projects
- **Persistence**: board configuration and card order stored in `localStorage` per project/group
- **Refresh**: manual refresh button reloads all data from GitLab

## Tech

Single HTML file with embedded CSS and JavaScript. No build step, no dependencies, no backend. Fonts loaded from Google Fonts (Outfit + JetBrains Mono).
