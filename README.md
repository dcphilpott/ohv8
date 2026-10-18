# NIH RePORTER connector

An MCP server that lets Claude search [NIH RePORTER](https://reporter.nih.gov): every NIH-funded grant since 1985, with PIs, organizations, dollars, abstracts, and linked PubMed IDs. It calls the public RePORTER v2 API, which needs no key.

## Tools

| Tool | What it answers |
|---|---|
| `search_projects` | Raw passthrough to `POST /v2/projects/search`. `criteria`, `include_fields`, `offset`, `limit` (max 500) and sort go to RePORTER as-is; the reply is RePORTER's JSON including `meta.total`. Default fields: ProjectNum, FiscalYear, ActivityCode, ProjectTitle, Organization, PrincipalInvestigators, ProjectStartDate, ProjectEndDate. Built for bulk pulls: ~20 people per call in `pi_names`. |
| `find_projects` | "Which NIAID R01s on pediatric TB are at Illinois institutions?" Filter by text, PI, org, city/state/country, fiscal year, IC, activity code, application type, FOA, dates, dollar range. |
| `get_project` | Full record for one grant (abstract, program officer, study section, IC split) plus every fiscal year's award amount. Takes an `appl_id` or a project number, full or core. |
| `summarize_funding` | Dollar totals grouped by IC, organization, state, country, fiscal year, mechanism, contact PI, or project. "How much did FIC put into Uganda by year?" |
| `find_investigator` | Turns a name into RePORTER profile IDs so two Jane Smiths don't get merged. |
| `get_publications` | PMIDs linked to a grant, or grants an article cites. Pair with the PubMed connector for titles. |

Things the tools account for, so the numbers come out right:

- RePORTER keeps one record per project per fiscal year. A 5-year R01 is 5 records.
- `summarize_funding` drops subproject records by default. A P01 or U54 parent already includes its subprojects' dollars, so counting both doubles the total.
- The API caps any search at 15,000 records. When a summary hits `max_records` before the end, the reply starts with `PARTIAL` and gives the share it covered.
- NIH asks for no more than 1 request per second. The client spaces requests 1 second apart and retries 429s and 5xx errors up to 3 times. A 5,000-record summary takes about 10 seconds.

## Run it

```bash
npm install
npm test          # 25 tests against a fake RePORTER API
npm run build
```

### As a claude.ai custom connector (Cloudflare Workers)

```bash
npx wrangler login
npm run deploy
```

Wrangler prints the URL. In claude.ai, go to Settings → Connectors → Add custom connector and enter `https://nih-reporter-mcp.<your-subdomain>.workers.dev/mcp`. No auth is needed because the data is public. Anyone with the URL can use it, and the only cost is Workers requests on your account (the free tier covers 100,000 per day).

### Locally, in Claude Desktop or Claude Code

```bash
npm run build
claude mcp add nih-reporter -- node /path/to/repo/dist/stdio.js
```

For Claude Desktop, add to `claude_desktop_config.json`:

```json
{ "mcpServers": { "nih-reporter": { "command": "node", "args": ["/path/to/repo/dist/stdio.js"] } } }
```

## Layout

- `src/reporter.ts`: API client, pacing, retries, paging
- `src/tools.ts`: the five tools and the filter-to-criteria mapping
- `src/format.ts`: how projects are written out for Claude
- `src/worker.ts`: Cloudflare Worker, stateless Streamable HTTP at `/mcp`
- `src/stdio.ts`: local stdio entry point

## Checked against the live API (2026-10-18)

Every tool was run against `api.reporter.nih.gov`:

- `search_projects`: a batch of 3 PIs (`pi_names` with first/last) returned 262 records in 3 pages of 100 in 2.3 seconds, with exactly the 8 default fields, `profile_id` and `is_contact_pi`. `project_end_date`, `include_active_projects`, `foa`, `exclude_fields`, and all four sort fields work as sent.
- `get_project` returned the abstract and a 3-year funding history for UH3DE032003.
- `find_investigator`, `summarize_funding` (102 Uganda project-years, FY2024 to FY2025), and `get_publications` returned data that matched the RePORTER website.

Two API quirks the code now handles:

1. A project number that starts with `*` matches nothing. A bare core number (`UH3DE032003`) matches every year, so `get_project` uses that.
2. `meta.properties.URL` comes back as `https:/reporter...`, one slash short. `find_projects` repairs it; `search_projects` passes it through untouched.

When matching people back from `search_projects`, one person can have more than one profile ID (Francis Collins has two), so match on profile ID first, then on name.
