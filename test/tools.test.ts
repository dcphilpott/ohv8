import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { type Project, ReporterClient } from "../src/reporter.js";
import { buildCriteria, buildServer, DEFAULT_FIELDS, toCoreProjectNum } from "../src/tools.js";

function proj(over: Partial<Project> & { appl_id: number }): Project {
  return {
    fiscal_year: 2025,
    project_num: "5R01AI000001-02",
    core_project_num: "R01AI000001",
    project_title: "TB preventive therapy in children",
    organization: { org_name: "UNIVERSITY OF ILLINOIS AT CHICAGO", org_city: "CHICAGO", org_state: "IL", org_country: "UNITED STATES" },
    activity_code: "R01",
    award_amount: 500_000,
    agency_ic_admin: { abbreviation: "NIAID", name: "National Institute of Allergy and Infectious Diseases" },
    principal_investigators: [{ profile_id: 111, first_name: "Jane", last_name: "Smith", is_contact_pi: true }],
    project_start_date: "2024-04-01T00:00:00",
    project_end_date: "2029-03-31T00:00:00",
    is_active: true,
    ...over,
  };
}

type Handler = (path: string, body: any) => unknown;

function fakeApi(handler: Handler) {
  const calls: { path: string; body: any }[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace("https://api.reporter.nih.gov/v2", "");
    const body = JSON.parse(String(init?.body));
    calls.push({ path, body });
    const out = handler(path, body);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const client = new ReporterClient({ fetch: fetchFn as typeof fetch, minIntervalMs: 0, sleep: async () => {} });
  return { client, calls };
}

const page = (results: unknown[], total = results.length, offset = 0) => ({
  meta: { total, offset, limit: results.length },
  results,
});

async function connect(client: ReporterClient) {
  const server = buildServer(client);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), mcp.connect(b)]);
  return mcp;
}

async function call(mcp: Client, name: string, args: Record<string, unknown>) {
  const res: any = await mcp.callTool({ name, arguments: args });
  return { text: res.content[0].text as string, isError: !!res.isError };
}

describe("buildCriteria", () => {
  it("maps friendly filters to RePORTER criteria", () => {
    expect(
      buildCriteria({
        text: "pediatric tuberculosis",
        pi_name: "Smith",
        org_states: ["il"],
        agencies: ["niaid"],
        activity_codes: ["r01", "k23"],
        fiscal_years: [2024, 2025],
        funding_opportunities: ["par-21-123"],
        project_end_from: "2026-10-17",
        award_amount_min: 100000,
        exclude_subprojects: true,
      }),
    ).toEqual({
      advanced_text_search: { operator: "and", search_field: "projecttitle,terms,abstracttext", search_text: "pediatric tuberculosis" },
      pi_names: [{ any_name: "Smith" }],
      org_states: ["IL"],
      agencies: ["NIAID"],
      activity_codes: ["R01", "K23"],
      fiscal_years: [2024, 2025],
      foa: ["PAR-21-123"],
      project_end_date: { from_date: "2026-10-17" },
      award_amount_range: { min_amount: 100000, max_amount: 1e12 },
      exclude_subprojects: true,
    });
  });

  it("drops empty arrays and blank text", () => {
    expect(buildCriteria({ text: "  ", org_names: [], fiscal_years: [2025] })).toEqual({ fiscal_years: [2025] });
  });
});

describe("toCoreProjectNum", () => {
  it.each([
    ["5R01AI123456-03", "R01AI123456"],
    ["1K23HD098765-01A1", "K23HD098765"],
    ["r01ai123456", "R01AI123456"],
    ["ZIAAI000001", "ZIAAI000001"],
    ["1ZIAAI000883-22", "ZIAAI000883"],
  ])("%s -> %s", (input, out) => expect(toCoreProjectNum(input)).toBe(out));
});

describe("ReporterClient", () => {
  it("waits between requests to stay at 1 per second", async () => {
    const waits: number[] = [];
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(page([])), { status: 200 }));
    const client = new ReporterClient({ fetch: fetchFn as typeof fetch, sleep: async (ms) => void waits.push(ms) });
    await client.searchProjects({ criteria: { fiscal_years: [2025] } });
    await client.searchProjects({ criteria: { fiscal_years: [2025] } });
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(900);
  });

  it("retries a 429, then gives up on a 400 with the API's message", async () => {
    let n = 0;
    const { client } = fakeApi(() => (n++ === 0 ? new Response("slow down", { status: 429 }) : page([proj({ appl_id: 1 })])));
    expect((await client.searchProjects({ criteria: {} })).results).toHaveLength(1);

    const bad = fakeApi(() => new Response('{"error":"bad criteria"}', { status: 400 }));
    await expect(bad.client.searchProjects({ criteria: {} })).rejects.toThrow(/HTTP 400.*bad criteria/);
  });

  it("pages with offset until max records or the end", async () => {
    const all = Array.from({ length: 1200 }, (_, i) => proj({ appl_id: i + 1 }));
    const { client, calls } = fakeApi((_, b) => page(all.slice(b.offset, b.offset + b.limit), all.length, b.offset));
    const got = await client.collectProjects({ criteria: {} }, 5000);
    expect(got.results).toHaveLength(1200);
    expect(calls.map((c) => [c.body.offset, c.body.limit])).toEqual([
      [0, 500],
      [500, 500],
      [1000, 500],
    ]);
    const capped = await client.collectProjects({ criteria: {} }, 700);
    expect(capped.results).toHaveLength(700);
    expect(capped.total).toBe(1200);
  });
});

describe("MCP tools", () => {
  it("lists all six tools", async () => {
    const mcp = await connect(fakeApi(() => page([])).client);
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "find_investigator",
      "find_projects",
      "get_project",
      "get_publications",
      "search_projects",
      "summarize_funding",
    ]);
  });

  it("find_projects sends slim criteria and formats results", async () => {
    const { client, calls } = fakeApi(() => ({
      ...page([proj({ appl_id: 10901234 })], 37),
      meta: { total: 37, offset: 0, limit: 25, properties: { URL: "https:/reporter.nih.gov/search/abc/projects" } },
    }));
    const mcp = await connect(client);
    const { text, isError } = await call(mcp, "find_projects", { text: "tuberculosis", org_states: ["IL"], sort_by: "award_amount" });
    expect(isError).toBe(false);
    expect(calls[0].path).toBe("/projects/search");
    expect(calls[0].body).toMatchObject({
      criteria: { org_states: ["IL"] },
      limit: 25,
      sort_field: "award_amount",
      sort_order: "desc",
      exclude_fields: ["AbstractText", "PhrText", "Terms", "PrefTerms"],
    });
    expect(text).toContain("37 matching project-year records; showing 1–1.");
    expect(text).toContain("https://reporter.nih.gov/search/abc/projects");
    expect(text).toContain("5R01AI000001-02 (FY2025) — TB preventive therapy in children");
    expect(text).toContain("Smith, Jane [profile 111]");
    expect(text).toContain("$500,000");
    expect(text).toContain("https://reporter.nih.gov/project-details/10901234");
  });

  it("find_projects refuses an empty search", async () => {
    const { client, calls } = fakeApi(() => page([]));
    const { isError } = await call(await connect(client), "find_projects", {});
    expect(isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("surfaces API errors as tool errors, not crashes", async () => {
    const { client } = fakeApi(() => new Response("Invalid criteria", { status: 400 }));
    const { text, isError } = await call(await connect(client), "find_projects", { fiscal_years: [2025] });
    expect(isError).toBe(true);
    expect(text).toContain("HTTP 400");
  });

  it("summarize_funding totals by IC, excludes subprojects, and flags partial results", async () => {
    const rows = [
      proj({ appl_id: 1, award_amount: 300 }),
      proj({ appl_id: 2, award_amount: 100, agency_ic_admin: { abbreviation: "NICHD" } }),
      proj({ appl_id: 3, award_amount: null }),
    ];
    const { client, calls } = fakeApi((_, b) => page(rows.slice(b.offset, b.offset + b.limit), 10, b.offset));
    const { text } = await call(await connect(client), "summarize_funding", { org_states: ["IL"], group_by: "ic", max_records: 3 });
    expect(calls[0].body.criteria.exclude_subprojects).toBe(true);
    expect(text).toContain("Total: $400 across 3 project-year records.");
    expect(text).toContain("PARTIAL: 10 records match, only the first 3");
    expect(text).toContain("1 records had no award amount");
    expect(text).toMatch(/- NIAID: \$300 \(75\.0%\), 2 records\n- NICHD: \$100 \(25\.0%\), 1 records/);
  });

  it("summarize_funding by fiscal year sorts chronologically", async () => {
    const rows = [proj({ appl_id: 1, fiscal_year: 2025, award_amount: 1 }), proj({ appl_id: 2, fiscal_year: 2023, award_amount: 9 })];
    const { client } = fakeApi(() => page(rows));
    const { text } = await call(await connect(client), "summarize_funding", { agencies: ["FIC"], group_by: "fiscal_year" });
    expect(text.indexOf("FY2023")).toBeLessThan(text.indexOf("FY2025"));
  });

  it("find_investigator separates same-name people by profile and skips non-matching co-PIs", async () => {
    const rows = [
      proj({
        appl_id: 1,
        principal_investigators: [
          { profile_id: 111, first_name: "Jane", last_name: "Smith", is_contact_pi: true },
          { profile_id: 222, first_name: "Robert", last_name: "Jones" },
        ],
      }),
      proj({ appl_id: 2, fiscal_year: 2019, principal_investigators: [{ profile_id: 111, first_name: "Jane", last_name: "Smith" }] }),
      proj({
        appl_id: 3,
        organization: { org_name: "EMORY UNIVERSITY" },
        principal_investigators: [{ profile_id: 333, first_name: "Jane", middle_name: "A", last_name: "Smith" }],
      }),
    ];
    const { client, calls } = fakeApi(() => page(rows));
    const { text } = await call(await connect(client), "find_investigator", { name: "Jane Smith" });
    expect(calls[0].body.criteria.pi_names).toEqual([{ any_name: "Jane Smith" }]);
    expect(text).toContain("2 matching investigator profile(s)");
    expect(text).toContain("Smith, Jane (profile 111) | UNIVERSITY OF ILLINOIS AT CHICAGO | FY2019–FY2025 | 2 project-years | $1,000,000");
    expect(text).toContain("Smith, Jane A (profile 333) | EMORY UNIVERSITY");
    expect(text).not.toContain("Jones");
  });

  it("get_project resolves a full project number and adds funding history", async () => {
    const y1 = proj({ appl_id: 1, fiscal_year: 2024, project_num: "1R01AI000001-01", award_amount: 600_000 });
    const y2 = proj({ appl_id: 2, fiscal_year: 2025, abstract_text: "We will test 3HP in children.", program_officers: [{ first_name: "Pat", last_name: "Lee", email: "pat.lee@nih.gov" }] });
    const sub = proj({ appl_id: 3, fiscal_year: 2025, subproject_id: "7001", award_amount: 50_000 });
    const other = proj({ appl_id: 4, core_project_num: "R01AI000001X" });
    const { client, calls } = fakeApi((_, b) => {
      const pat = b.criteria.project_nums[0];
      if (pat === "5R01AI000001-02") return page([y2]);
      return page([y1, y2, sub, other]);
    });
    const { text } = await call(await connect(client), "get_project", { project_num: "5r01ai000001-02" });
    expect(calls.map((c) => c.body.criteria.project_nums[0])).toEqual(["5R01AI000001-02", "R01AI000001"]);
    expect(text).toContain("# TB preventive therapy in children");
    expect(text).toContain("Program officer: Lee, Pat <pat.lee@nih.gov>");
    expect(text).toContain("We will test 3HP in children.");
    expect(text).toContain("## Funding history for R01AI000001 (2 records, $1,100,000 total)");
    expect(text.indexOf("FY2024")).toBeLessThan(text.indexOf("FY2025: 5R01"));
  });

  it("get_project reports not found clearly", async () => {
    const { client } = fakeApi(() => page([]));
    const { text, isError } = await call(await connect(client), "get_project", { appl_id: 42 });
    expect(isError).toBe(true);
    expect(text).toContain("No project found for 42");
  });

  it("get_publications trims to core numbers and groups PMIDs", async () => {
    const { client, calls } = fakeApi(() =>
      page(
        [
          { coreproject: "R01AI000001", pmid: 35000001, applid: 1 },
          { coreproject: "R01AI000001", pmid: 36000002, applid: 2 },
        ],
        2,
      ),
    );
    const { text } = await call(await connect(client), "get_publications", { project_nums: ["5R01AI000001-02", "R01AI000001"] });
    expect(calls[0].path).toBe("/publications/search");
    expect(calls[0].body.criteria).toEqual({ core_project_nums: ["R01AI000001"] });
    expect(text).toContain("R01AI000001: 2 PMIDs: 36000002, 35000001");
  });
});

async function callRaw(mcp: Client, args: Record<string, unknown>) {
  const res: any = await mcp.callTool({ name: "search_projects", arguments: args });
  return { text: res.content[0].text as string, isError: !!res.isError };
}

const rawFake = (handler: (body: any) => unknown) => fakeApi((_path, body) => handler(body));

const record = {
  project_num: "5R01AI000001-02",
  fiscal_year: 2025,
  activity_code: "R01",
  project_title: "TB preventive therapy in children",
  organization: { org_name: "UNIVERSITY OF ILLINOIS AT CHICAGO" },
  principal_investigators: [{ profile_id: 111, first_name: "Jane", last_name: "Smith", is_contact_pi: true }],
  project_start_date: "2024-04-01T00:00:00",
  project_end_date: "2029-03-31T00:00:00",
};

describe("search_projects (raw passthrough)", () => {
  it("passes criteria through as-is, including keys the schema doesn't name", async () => {
    const reply = { meta: { total: 1234, offset: 500, limit: 500 }, results: [record] };
    const { client, calls } = rawFake(() => reply);
    const criteria = {
      pi_names: [
        { first_name: "Jane", last_name: "Smith" },
        { first_name: "Ravi", last_name: "Patel" },
      ],
      pi_profile_ids: [111, 222],
      org_names: ["UNIVERSITY OF ILLINOIS"],
      fiscal_years: [2024, 2025],
      project_end_date: { from_date: "2026-10-17", to_date: "2031-12-31" },
      include_active_projects: true,
      activity_codes: ["R01"],
    };
    const { text, isError } = await callRaw(await connect(client), { criteria, offset: 500 });
    expect(isError).toBe(false);
    expect(calls[0].path).toBe("/projects/search");
    expect(calls[0].body).toEqual({ criteria, offset: 500, limit: 500, include_fields: DEFAULT_FIELDS });
    expect(JSON.parse(text)).toEqual(reply);
  });

  it("passes include_fields, sort, and limit through; [] means all fields", async () => {
    const { client, calls } = rawFake(() => ({ meta: { total: 0, offset: 0, limit: 10 }, results: [] }));
    const mcp = await connect(client);
    await callRaw(mcp, { criteria: { fiscal_years: [2025] }, include_fields: ["ProjectNum", "IsActive"], limit: 10, sort_field: "fiscal_year", sort_order: "asc" });
    expect(calls[0].body).toEqual({
      criteria: { fiscal_years: [2025] },
      offset: 0,
      limit: 10,
      include_fields: ["ProjectNum", "IsActive"],
      sort_field: "fiscal_year",
      sort_order: "asc",
    });
    await callRaw(mcp, { criteria: { fiscal_years: [2025] }, include_fields: [] });
    expect(calls[1].body).not.toHaveProperty("include_fields");
  });

  it("rejects limit over 500, empty criteria, and paging past 15,000 without calling the API", async () => {
    const { client, calls } = rawFake(() => ({}));
    const mcp = await connect(client);
    expect((await callRaw(mcp, { criteria: { fiscal_years: [2025] }, limit: 501 })).isError).toBe(true);
    expect((await callRaw(mcp, { criteria: {} })).isError).toBe(true);
    expect((await callRaw(mcp, { criteria: { fiscal_years: [2025] }, offset: 14_800, limit: 500 })).text).toContain("15,000");
    expect(calls).toHaveLength(0);
  });

  it("returns RePORTER's error text as a tool error", async () => {
    const { client } = rawFake(() => new Response('{"error":"pi_names invalid"}', { status: 400 }));
    const { text, isError } = await callRaw(await connect(client), { criteria: { pi_names: [{ last_name: "Smith" }] } });
    expect(isError).toBe(true);
    expect(text).toContain("HTTP 400");
    expect(text).toContain("pi_names invalid");
  });
});

