import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { icAbbrev, orgLine, personName, projectDetail, projectSummary, projectUrl, usd } from "./format.js";
import { MAX_LIMIT, MAX_OFFSET, type Project, ReporterClient, ReporterError } from "./reporter.js";

// Abstracts and term lists are most of each record's size; leave them out unless we show them.
const SLIM = ["AbstractText", "PhrText", "Terms", "PrefTerms"];

const INSTRUCTIONS = `NIH RePORTER: every NIH-funded grant, contract, and intramural project since 1985, with PIs, organizations, award amounts, abstracts, and linked PubMed IDs.

How the data is shaped:
- One record per project per fiscal year. A 5-year R01 shows up as 5 records with the same core_project_num (e.g. R01AI123456) and different project_nums (1R01AI123456-01, 5R01AI123456-02, ...).
- award_amount is that fiscal year's total cost (direct + indirect). Summing across fiscal years gives total funding over time.
- Multi-component awards (P01, U54, etc.) have a parent record plus subproject records; the parent's amount already includes the subprojects, so exclude subprojects when adding money up.
- NIH fiscal year N runs Oct 1 of N-1 through Sep 30 of N.

Picking a tool:
- search_projects: raw passthrough to the RePORTER search API. Returns the API's JSON ({meta, results}) for bulk pulls, e.g. many PIs per call via pi_names. Page with offset/limit (max 500) until offset + results.length >= meta.total.
- find_projects: find grants by topic, PI, organization, place, IC, mechanism, year, with readable output.
- get_project: full record (abstract, program officer, study section) plus year-by-year funding history.
- summarize_funding: dollar totals grouped by IC, organization, state, year, mechanism, PI, or project. Use this instead of adding up search results by hand.
- find_investigator: resolve a person's name to RePORTER profile IDs before searching by PI, so two people with the same name don't get merged.
- get_publications: PubMed IDs linked to a grant. Pass the PMIDs to a PubMed tool for titles and abstracts.

The API allows about 1 request per second, so large summaries take a few seconds per 500 records.`;

const filterShape = {
  text: z
    .string()
    .optional()
    .describe('Words to search for in titles, abstracts, and NIH terms. With text_operator "advanced" you can use AND/OR/NOT and "quoted phrases".'),
  text_operator: z.enum(["and", "or", "advanced"]).optional().describe('How to combine the words in `text`. Default "and".'),
  text_fields: z
    .array(z.enum(["projecttitle", "abstracttext", "terms"]))
    .optional()
    .describe("Which fields `text` searches. Default: title, abstract, and terms."),
  pi_name: z.string().optional().describe('Principal investigator name, e.g. "Philpott" or "Jane Smith". Matches any PI on the grant, not only the contact PI.'),
  pi_profile_ids: z.array(z.number().int()).optional().describe("RePORTER PI profile IDs (from find_investigator). More precise than pi_name."),
  org_names: z.array(z.string()).optional().describe('Organization names; partial matches count, e.g. "UNIVERSITY OF ILLINOIS".'),
  org_cities: z.array(z.string()).optional().describe('Organization cities, e.g. "CHICAGO".'),
  org_states: z.array(z.string()).optional().describe('Two-letter state codes, e.g. "IL".'),
  org_countries: z.array(z.string()).optional().describe('Organization countries spelled out, e.g. "UGANDA", "SOUTH AFRICA".'),
  fiscal_years: z.array(z.number().int()).optional().describe("NIH fiscal years, e.g. [2024, 2025]. Leave empty for all years since 1985."),
  include_active_projects: z
    .boolean()
    .optional()
    .describe("Also return projects that are currently active, in addition to those matching fiscal_years."),
  agencies: z
    .array(z.string())
    .optional()
    .describe('NIH institutes/centers by abbreviation, e.g. "NIAID", "NICHD", "NHLBI", "NIMH", "FIC", "NCI".'),
  activity_codes: z.array(z.string()).optional().describe('Grant mechanisms, e.g. "R01", "K23", "U01", "D43", "T32".'),
  award_types: z
    .array(z.string())
    .optional()
    .describe('Application types: "1" new, "2" competing renewal, "3" supplement, "4" extension, "5" non-competing continuation, "7" change of grantee, "9" change of IC.'),
  project_nums: z
    .array(z.string())
    .optional()
    .describe('Project numbers. Full ("5R01AI123456-03"), core ("R01AI123456", matches every year), or with a trailing * ("5R01AI123456*"). A leading * matches nothing.'),
  funding_opportunities: z.array(z.string()).optional().describe('Funding opportunity numbers, e.g. "PAR-21-123", "RFA-AI-22-045".'),
  project_start_from: z.string().optional().describe("Project start date on or after (YYYY-MM-DD)."),
  project_start_to: z.string().optional().describe("Project start date on or before (YYYY-MM-DD)."),
  project_end_from: z.string().optional().describe("Project end date on or after (YYYY-MM-DD). Use today's date to find projects still running."),
  project_end_to: z.string().optional().describe("Project end date on or before (YYYY-MM-DD)."),
  award_amount_min: z.number().optional().describe("Minimum fiscal-year award amount in dollars."),
  award_amount_max: z.number().optional().describe("Maximum fiscal-year award amount in dollars."),
  exclude_subprojects: z.boolean().optional().describe("Leave out subproject records of multi-component awards."),
};

const filterSchema = z.object(filterShape);
export type Filters = z.infer<typeof filterSchema>;

const upper = (xs?: string[]) => xs?.map((x) => x.trim().toUpperCase()).filter(Boolean);
const dateRange = (from?: string, to?: string) =>
  from || to ? { ...(from ? { from_date: from } : {}), ...(to ? { to_date: to } : {}) } : undefined;

export function buildCriteria(f: Filters): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  const set = (k: string, v: unknown) => {
    if (v === undefined || (Array.isArray(v) && v.length === 0)) return;
    c[k] = v;
  };
  if (f.text?.trim()) {
    c.advanced_text_search = {
      operator: f.text_operator ?? "and",
      search_field: f.text_fields?.length ? f.text_fields.join(",") : "projecttitle,terms,abstracttext",
      search_text: f.text.trim(),
    };
  }
  if (f.pi_name?.trim()) c.pi_names = [{ any_name: f.pi_name.trim() }];
  set("pi_profile_ids", f.pi_profile_ids);
  set("org_names", upper(f.org_names));
  set("org_cities", upper(f.org_cities));
  set("org_states", upper(f.org_states));
  set("org_countries", upper(f.org_countries));
  set("fiscal_years", f.fiscal_years);
  set("include_active_projects", f.include_active_projects);
  set("agencies", upper(f.agencies));
  set("activity_codes", upper(f.activity_codes));
  set("award_types", f.award_types);
  set("project_nums", f.project_nums?.map((s) => s.trim()));
  set("foa", upper(f.funding_opportunities));
  set("project_start_date", dateRange(f.project_start_from, f.project_start_to));
  set("project_end_date", dateRange(f.project_end_from, f.project_end_to));
  if (f.award_amount_min != null || f.award_amount_max != null) {
    c.award_amount_range = {
      min_amount: f.award_amount_min ?? 0,
      max_amount: f.award_amount_max ?? 1e12,
    };
  }
  set("exclude_subprojects", f.exclude_subprojects);
  return c;
}

// "5R01AI123456-03" -> "R01AI123456", "1ZIAAI000883-22" -> "ZIAAI000883"; leaves anything it doesn't recognize alone.
export function toCoreProjectNum(num: string): string {
  const m = num.trim().toUpperCase().match(/^\d?([A-Z][A-Z0-9]{2}[A-Z]{2}\d{6})(?:-.*)?$/);
  return m ? m[1] : num.trim().toUpperCase();
}

export const DEFAULT_FIELDS = [
  "ProjectNum",
  "FiscalYear",
  "ActivityCode",
  "ProjectTitle",
  "Organization",
  "PrincipalInvestigators",
  "ProjectStartDate",
  "ProjectEndDate",
];

const rawPiName = z
  .object({ first_name: z.string().optional(), last_name: z.string().optional(), any_name: z.string().optional() })
  .loose();
const rawDateRange = z.object({ from_date: z.string().optional(), to_date: z.string().optional() }).loose();

// Named keys get schema hints; anything else RePORTER accepts passes through untouched.
const rawCriteria = z
  .object({
    pi_names: z.array(rawPiName).optional().describe("PIs to match, e.g. [{first_name: 'Jane', last_name: 'Smith'}, ...]. Entries are OR'd."),
    pi_profile_ids: z.array(z.number().int()).optional(),
    org_names: z.array(z.string()).optional(),
    fiscal_years: z.array(z.number().int()).optional(),
    project_end_date: rawDateRange.optional().describe("{from_date, to_date} as YYYY-MM-DD."),
    include_active_projects: z.boolean().optional(),
  })
  .loose()
  .describe("RePORTER criteria object, passed through as-is. Any other RePORTER criteria key is accepted too.");

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const fail = (s: string) => ({ content: [{ type: "text" as const, text: s }], isError: true });

async function guard<T>(fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ReporterError) return fail(err.message);
    throw err;
  }
}

function norm(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

const GROUPS = ["ic", "organization", "state", "country", "fiscal_year", "activity_code", "pi", "project"] as const;
type GroupBy = (typeof GROUPS)[number];

function groupKey(p: Project, by: GroupBy): string {
  switch (by) {
    case "ic":
      return icAbbrev(p);
    case "organization":
      return orgLine(p);
    case "state":
      return p.organization?.org_state ?? "(no state)";
    case "country":
      return p.organization?.org_country ?? "(no country)";
    case "fiscal_year":
      return `FY${p.fiscal_year ?? "?"}`;
    case "activity_code":
      return p.activity_code ?? "?";
    case "pi": {
      const pis = p.principal_investigators ?? [];
      const contact = pis.find((x) => x.is_contact_pi) ?? pis[0];
      return contact ? personName(contact) : p.contact_pi_name ?? "(no PI)";
    }
    case "project":
      return `${p.core_project_num ?? p.project_num ?? p.appl_id} — ${p.project_title ?? "untitled"}`;
  }
}

export function buildServer(client = new ReporterClient()): McpServer {
  const server = new McpServer({ name: "nih-reporter", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "search_projects",
    {
      title: "Search NIH RePORTER projects (raw)",
      description:
        "Wraps POST https://api.reporter.nih.gov/v2/projects/search. criteria, include_fields, offset, limit, and sort are passed through as-is; the reply is the API's JSON with meta.total. If include_fields is omitted it defaults to ProjectNum, FiscalYear, ActivityCode, ProjectTitle, Organization, PrincipalInvestigators, ProjectStartDate, ProjectEndDate. Pass include_fields: [] for all fields. pi_names takes many people per call; results include every PI on a matching project, so match people back by profile_id or name.",
      inputSchema: {
        criteria: rawCriteria,
        include_fields: z.array(z.string()).optional().describe("RePORTER field names in PascalCase, e.g. 'ProjectNum'."),
        exclude_fields: z.array(z.string()).optional(),
        offset: z.number().int().min(0).max(MAX_OFFSET).optional().describe("Default 0."),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe("Default 500 (the API maximum)."),
        sort_field: z.string().optional(),
        sort_order: z.enum(["asc", "desc"]).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        if (Object.keys(args.criteria).length === 0) {
          return fail("criteria is empty. That would return every NIH project since 1985; give at least one criterion.");
        }
        const offset = args.offset ?? 0;
        const limit = args.limit ?? MAX_LIMIT;
        if (offset + limit > MAX_OFFSET + 1) {
          return fail(`offset + limit is ${offset + limit}; RePORTER stops at 15,000. Narrow the criteria and page within each slice.`);
        }
        const res = await client.searchProjects({
          criteria: args.criteria,
          offset,
          limit,
          include_fields: args.include_fields ?? DEFAULT_FIELDS,
          exclude_fields: args.exclude_fields,
          sort_field: args.sort_field,
          sort_order: args.sort_order,
        });
        return text(JSON.stringify(res));
      }),
  );

  server.registerTool(
    "find_projects",
    {
      title: "Find NIH-funded projects",
      description:
        "Search NIH RePORTER for funded projects by topic, investigator, organization, location, institute, mechanism, or year. Returns one line-block per project-year with PI, organization, IC, mechanism, amount, dates, and a RePORTER link.",
      inputSchema: {
        ...filterShape,
        sort_by: z
          .enum(["fiscal_year", "award_amount", "project_start_date", "project_end_date"])
          .optional()
          .describe("Sort field. Default: RePORTER relevance order."),
        sort_order: z.enum(["asc", "desc"]).optional(),
        limit: z.number().int().min(1).max(100).optional().describe("Results to return (default 25, max 100)."),
        offset: z.number().int().min(0).max(MAX_OFFSET).optional().describe("Skip this many results, for paging."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const criteria = buildCriteria(args);
        if (Object.keys(criteria).length === 0) {
          return fail("Give at least one filter (text, PI, organization, fiscal year, IC, etc.). An empty search would return every NIH project since 1985.");
        }
        const res = await client.searchProjects({
          criteria,
          limit: args.limit ?? 25,
          offset: args.offset ?? 0,
          sort_field: args.sort_by,
          sort_order: args.sort_order,
          exclude_fields: SLIM,
        });
        const { total, offset } = res.meta;
        if (!res.results.length) return text(`No projects matched (total ${total}).`);
        const shown = `${offset + 1}–${offset + res.results.length}`;
        const header = `${total.toLocaleString("en-US")} matching project-year records; showing ${shown}.${
          offset + res.results.length < total ? " Use offset to see more, or summarize_funding for totals." : ""
        }`;
        // RePORTER sends this as "https:/reporter.nih.gov/...", one slash short.
        const site = res.meta.properties?.URL?.replace(/^https:\/(?!\/)/, "https://");
        const link = site ? `\nSame search on the RePORTER website: ${site}` : "";
        return text(`${header}${link}\n\n${res.results.map(projectSummary).join("\n\n")}`);
      }),
  );

  server.registerTool(
    "get_project",
    {
      title: "Get one NIH project",
      description:
        "Full detail for one project: abstract, public health relevance, PIs, program officer, study section, IC funding split, and its fiscal-year-by-year funding history. Look up by appl_id or project number (full like 5R01AI123456-03, or core like R01AI123456).",
      inputSchema: {
        appl_id: z.number().int().optional().describe("RePORTER application ID (appears in every search result)."),
        project_num: z.string().optional().describe("Project number, full or core."),
        include_history: z.boolean().optional().describe("List every fiscal year of the award with amounts. Default true."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ appl_id, project_num, include_history = true }) =>
      guard(async () => {
        if (appl_id == null && !project_num?.trim()) return fail("Give appl_id or project_num.");

        let record: Project | undefined;
        if (appl_id != null) {
          record = (await client.searchProjects({ criteria: { appl_ids: [appl_id] }, limit: 1 })).results[0];
        } else {
          const num = project_num!.trim().toUpperCase();
          const isCore = toCoreProjectNum(num) === num && !num.includes("*");
          // RePORTER matches a bare core number against every year; a leading * matches nothing.
          const patterns = isCore ? [num] : [num, toCoreProjectNum(num)];
          for (const pattern of patterns) {
            const res = await client.searchProjects({
              criteria: { project_nums: [pattern] },
              limit: 50,
              sort_field: "fiscal_year",
              sort_order: "desc",
            });
            // Prefer the parent record over subprojects.
            record = res.results.find((r) => !r.subproject_id) ?? res.results[0];
            if (record) break;
          }
        }
        if (!record) {
          return fail(`No project found for ${appl_id ?? project_num}. Try search_projects with a PI name or keywords.`);
        }

        let out = projectDetail(record);
        const core = record.core_project_num;
        if (include_history && core) {
          const { results } = await client.collectProjects(
            { criteria: { project_nums: [core] }, exclude_fields: SLIM, sort_field: "fiscal_year", sort_order: "asc" },
            200,
          );
          const years = results
            .filter((r) => r.core_project_num === core && !r.subproject_id)
            .sort((a, b) => (a.fiscal_year ?? 0) - (b.fiscal_year ?? 0) || a.appl_id - b.appl_id);
          if (years.length) {
            const total = years.reduce((s, r) => s + (r.award_amount ?? 0), 0);
            const rows = years.map(
              (r) => `- FY${r.fiscal_year}: ${r.project_num} | ${usd(r.award_amount)} | ${r.organization?.org_name ?? "?"} | appl_id ${r.appl_id}`,
            );
            out += `\n\n## Funding history for ${core} (${years.length} records, ${usd(total)} total)\n${rows.join("\n")}`;
          }
        }
        return text(out);
      }),
  );

  server.registerTool(
    "summarize_funding",
    {
      title: "Summarize NIH funding",
      description:
        "Add up NIH award dollars for every project matching the filters, grouped by IC, organization, state, country, fiscal year, mechanism (activity code), contact PI, or project. Pages through results at about 1 request per second, so 2,500 records takes about 5 seconds. Subprojects are excluded by default so multi-component awards are not double counted.",
      inputSchema: {
        ...filterShape,
        group_by: z.enum(GROUPS).describe("How to group the totals."),
        top_n: z.number().int().min(1).max(200).optional().describe("Groups to list, largest first (default 25)."),
        max_records: z
          .number()
          .int()
          .min(1)
          .max(15000)
          .optional()
          .describe("Stop after this many records (default 5,000; API maximum 15,000). If more records match, totals are partial and the reply says so."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const criteria = buildCriteria({ ...args, exclude_subprojects: args.exclude_subprojects ?? true });
        if (Object.keys(criteria).length <= 1) {
          return fail("Give at least one filter besides exclude_subprojects (e.g. fiscal_years, agencies, org_states, text).");
        }
        const maxRecords = args.max_records ?? 5000;
        const { total, results } = await client.collectProjects({ criteria, exclude_fields: SLIM }, maxRecords);
        if (!results.length) return text("No projects matched.");

        const groups = new Map<string, { amount: number; records: number; missing: number }>();
        let sum = 0;
        let missing = 0;
        for (const p of results) {
          const key = groupKey(p, args.group_by);
          const g = groups.get(key) ?? { amount: 0, records: 0, missing: 0 };
          g.records++;
          if (p.award_amount == null) {
            g.missing++;
            missing++;
          } else {
            g.amount += p.award_amount;
            sum += p.award_amount;
          }
          groups.set(key, g);
        }
        const sorted = [...groups.entries()].sort((a, b) =>
          args.group_by === "fiscal_year" ? a[0].localeCompare(b[0]) : b[1].amount - a[1].amount,
        );
        const topN = args.top_n ?? 25;
        const pct = (x: number) => (sum ? `${((100 * x) / sum).toFixed(1)}%` : "–");

        const lines: string[] = [];
        lines.push(`Total: ${usd(sum)} across ${results.length.toLocaleString("en-US")} project-year records.`);
        if (results.length < total) {
          lines.push(
            `PARTIAL: ${total.toLocaleString("en-US")} records match, only the first ${results.length.toLocaleString("en-US")} were added up (${((100 * results.length) / total).toFixed(1)}%). Narrow the filters or raise max_records.`,
          );
        }
        if (missing) lines.push(`${missing} records had no award amount and count as $0.`);
        lines.push(`Grouped by ${args.group_by}; ${groups.size} groups${groups.size > topN ? `, top ${topN} shown` : ""}:`, "");
        for (const [key, g] of sorted.slice(0, topN)) {
          lines.push(`- ${key}: ${usd(g.amount)} (${pct(g.amount)}), ${g.records} records`);
        }
        if (groups.size > topN) {
          const rest = sorted.slice(topN).reduce((s, [, g]) => s + g.amount, 0);
          lines.push(`- all other ${groups.size - topN} groups: ${usd(rest)} (${pct(rest)})`);
        }
        return text(lines.join("\n"));
      }),
  );

  server.registerTool(
    "find_investigator",
    {
      title: "Find an NIH investigator",
      description:
        "Look up a person in RePORTER by name and list each distinct PI profile that matches: profile ID, organizations, fiscal years active, number of project-years, and total dollars. Use the profile ID with search_projects or summarize_funding to avoid mixing up people with the same name.",
      inputSchema: {
        name: z.string().describe('Name to look up, e.g. "Philpott" or "Bisola Ojikutu".'),
        org_names: z.array(z.string()).optional().describe("Narrow to organizations (partial match)."),
        fiscal_years: z.array(z.number().int()).optional().describe("Narrow to fiscal years."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ name, org_names, fiscal_years }) =>
      guard(async () => {
        const tokens = norm(name).split(" ").filter(Boolean);
        if (!tokens.length) return fail("Give a name.");
        const criteria = buildCriteria({ pi_name: name, org_names, fiscal_years });
        const { total, results } = await client.collectProjects({ criteria, exclude_fields: SLIM }, 1000);
        type Agg = { name: string; orgs: Set<string>; years: Set<number>; records: number; amount: number; recent?: Project };
        const people = new Map<string, Agg>();
        for (const p of results) {
          for (const pi of p.principal_investigators ?? []) {
            const full = norm(`${pi.first_name ?? ""} ${pi.middle_name ?? ""} ${pi.last_name ?? ""} ${pi.full_name ?? ""}`);
            if (!tokens.every((t) => full.split(" ").some((w) => w.startsWith(t)))) continue;
            const key = pi.profile_id ? String(pi.profile_id) : `name:${full}`;
            const a = people.get(key) ?? { name: personName(pi), orgs: new Set(), years: new Set(), records: 0, amount: 0 };
            if (p.organization?.org_name) a.orgs.add(p.organization.org_name);
            if (p.fiscal_year) a.years.add(p.fiscal_year);
            a.records++;
            a.amount += p.award_amount ?? 0;
            if (!a.recent || (p.fiscal_year ?? 0) > (a.recent.fiscal_year ?? 0)) a.recent = p;
            people.set(key, a);
          }
        }
        if (!people.size) return text(`No investigators matching "${name}" (${total} project records searched).`);
        const sorted = [...people.entries()].sort((a, b) => b[1].records - a[1].records);
        const lines = sorted.slice(0, 25).map(([key, a]) => {
          const yrs = [...a.years].sort();
          const span = yrs.length ? `FY${yrs[0]}${yrs.length > 1 ? `–FY${yrs[yrs.length - 1]}` : ""}` : "?";
          const id = key.startsWith("name:") ? "no profile ID" : `profile ${key}`;
          const recent = a.recent ? `\n  Most recent: ${a.recent.project_num} — ${a.recent.project_title} (${projectUrl(a.recent.appl_id)})` : "";
          return `- ${a.name} (${id}) | ${[...a.orgs].slice(0, 4).join("; ")} | ${span} | ${a.records} project-years | ${usd(a.amount)}${recent}`;
        });
        const note = results.length < total ? `\n\nOnly the first ${results.length} of ${total} matching project records were scanned; add org_names or fiscal_years to narrow.` : "";
        return text(`${people.size} matching investigator profile(s):\n\n${lines.join("\n")}${note}`);
      }),
  );

  server.registerTool(
    "get_publications",
    {
      title: "Publications linked to NIH grants",
      description:
        "PubMed IDs that cite NIH grants, or the grants a PubMed article cites. Give core project numbers (R01AI123456; full numbers are trimmed to core), appl_ids, or PMIDs. Pass the PMIDs to a PubMed tool for titles and abstracts.",
      inputSchema: {
        project_nums: z.array(z.string()).optional().describe("Project numbers, full or core."),
        appl_ids: z.array(z.number().int()).optional(),
        pmids: z.array(z.number().int()).optional().describe("Find which grants these articles acknowledge."),
        limit: z.number().int().min(1).max(500).optional().describe("Default 200."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ project_nums, appl_ids, pmids, limit }) =>
      guard(async () => {
        const criteria: { core_project_nums?: string[]; appl_ids?: number[]; pmids?: number[] } = {};
        if (project_nums?.length) criteria.core_project_nums = [...new Set(project_nums.map(toCoreProjectNum))];
        if (appl_ids?.length) criteria.appl_ids = appl_ids;
        if (pmids?.length) criteria.pmids = pmids;
        if (!Object.keys(criteria).length) return fail("Give project_nums, appl_ids, or pmids.");
        const res = await client.searchPublications(criteria, 0, limit ?? 200);
        if (!res.results.length) return text("No linked publications found.");
        const byProject = new Map<string, Set<number>>();
        for (const r of res.results) {
          const s = byProject.get(r.coreproject) ?? new Set<number>();
          s.add(r.pmid);
          byProject.set(r.coreproject, s);
        }
        const lines = [...byProject.entries()].map(
          ([proj, ids]) => `- ${proj}: ${ids.size} PMIDs: ${[...ids].sort((a, b) => b - a).join(", ")}`,
        );
        const more = res.meta.total > res.results.length ? `\n\n${res.meta.total} links exist; showing ${res.results.length}. Raise limit to see more.` : "";
        return text(`${res.results.length} grant–publication links:\n\n${lines.join("\n")}${more}`);
      }),
  );

  return server;
}
