# GLance

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

## Shared Server (Read-Only)

To share a dashboard with your team, run the included proxy server. It keeps your GitLab token server-side, stores boards on the server, and supports LDAP or OIDC authentication.

**Requirements:** Node.js 18+

```bash
npm install
cp .env.example .env   # edit with your values
npm start
```

Configuration is read from a `.env` file (or environment variables). See `.env.example` for all options.

### Common configuration

| Variable | Description |
|----------|-------------|
| `GITLAB_URL` | GitLab instance URL |
| `GITLAB_TOKEN` | Personal access token (`api` scope for full functionality) |
| `SOURCE_TYPE` | `project` or `group` |
| `SOURCE_PATH` | Project/group path (e.g. `namespace/project`) |
| `AUTH_METHOD` | `ldap` or `oidc` (default: `ldap`) |
| `ADMIN_USERS` | Comma-separated usernames that get admin role |
| `PORT` | Listen port (default: `3000`) |

### LDAP configuration (`AUTH_METHOD=ldap`)

Users authenticate via the browser's Basic Auth dialog. The server binds to LDAP with their credentials. Successful binds are cached for 5 minutes.

| Variable | Description |
|----------|-------------|
| `LDAP_URL` | LDAP server URL (e.g. `ldap://ldap.example.com:389`) |
| `LDAP_BIND_DN` | DN template with `{{username}}` placeholder (e.g. `uid={{username}},ou=people,dc=example,dc=com`) |

### OIDC configuration (`AUTH_METHOD=oidc`)

Users are redirected to the OIDC provider's login page. After authentication, a session cookie is set (8 hours). The server uses OIDC discovery (`.well-known/openid-configuration`).

| Variable | Description |
|----------|-------------|
| `OIDC_ISSUER_URL` | Issuer URL (e.g. `https://auth.example.com/realms/myrealm`) |
| `OIDC_CLIENT_ID` | Client ID registered with the provider |
| `OIDC_CLIENT_SECRET` | Client secret |
| `OIDC_REDIRECT_URI` | Callback URL — must be `http(s)://<your-host>/auth/callback` |
| `OIDC_USERNAME_CLAIM` | ID token claim used as username (default: `preferred_username`) |
| `SESSION_SECRET` | Secret for signing session cookies (auto-generated if omitted, but sessions won't survive restarts) |

### Roles

Usernames in `ADMIN_USERS` get the admin role. All other authenticated users are viewers.

| | Admin | Viewer |
|---|---|---|
| View Gantt, Roadmap, Boards | Yes | Yes |
| Create / delete boards | Yes | No |
| Reorder columns and cards | Yes | No |
| Move issues between columns (GitLab label sync) | Yes | No |
| Edit issues (dates, labels, assignees, milestone) | Yes | No |
| Filter columns by label | Yes | Yes |

Boards are stored server-side in `boards.json`. The file is created automatically on first save.

### Migrating boards from local browser storage

If you have boards saved in your browser's localStorage from using `index.html` directly, you can export them and import them into the server:

1. Open your browser's developer console (F12) on the page where your boards are saved
2. Run:
   ```js
   copy(localStorage.getItem('gl-gantt-boards-v2:YOUR/PROJECT/PATH'))
   ```
   (replace `YOUR/PROJECT/PATH` with your actual project/group path)
3. Save the clipboard content to `boards.json` in the server directory
4. Restart the server

For production, put it behind a reverse proxy (nginx/Caddy) with HTTPS.

## Tech

Single HTML file with embedded CSS and JavaScript. No build step, no dependencies, no backend required for personal use. Fonts loaded from Google Fonts (Outfit + JetBrains Mono). The `server.js` proxy supports LDAP (`ldapts`) and OIDC (authorization code flow) authentication, and reads config from `.env`.
