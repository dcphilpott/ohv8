// Thin client for the NIH RePORTER v2 API.
// Docs: https://api.reporter.nih.gov/  (no key required)
// NIH asks callers to stay at or under 1 request per second, so every call goes through `pace()`.

export const API_BASE = "https://api.reporter.nih.gov/v2";
export const MAX_LIMIT = 500; // per-request ceiling set by the API
export const MAX_OFFSET = 14_999; // the API refuses offsets past this

export interface Organization {
  org_name?: string | null;
  org_city?: string | null;
  org_state?: string | null;
  org_country?: string | null;
  dept_type?: string | null;
}

export interface Person {
  profile_id?: number | null;
  first_name?: string | null;
  middle_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  is_contact_pi?: boolean | null;
  email?: string | null;
}

export interface IcFunding {
  fy?: number | null;
  code?: string | null;
  abbreviation?: string | null;
  name?: string | null;
  total_cost?: number | null;
}

export interface Project {
  appl_id: number;
  subproject_id?: string | null;
  fiscal_year?: number | null;
  project_num?: string | null;
  core_project_num?: string | null;
  project_title?: string | null;
  abstract_text?: string | null;
  phr_text?: string | null;
  pref_terms?: string | null;
  organization?: Organization | null;
  activity_code?: string | null;
  award_type?: string | null;
  award_amount?: number | null;
  direct_cost_amt?: number | null;
  indirect_cost_amt?: number | null;
  is_active?: boolean | null;
  is_new?: boolean | null;
  principal_investigators?: Person[] | null;
  contact_pi_name?: string | null;
  program_officers?: Person[] | null;
  agency_ic_admin?: { code?: string | null; abbreviation?: string | null; name?: string | null } | null;
  agency_ic_fundings?: IcFunding[] | null;
  project_start_date?: string | null;
  project_end_date?: string | null;
  budget_start?: string | null;
  budget_end?: string | null;
  award_notice_date?: string | null;
  opportunity_number?: string | null;
  full_study_section?: { name?: string | null; srg_code?: string | null } | null;
  spending_categories_desc?: string | null;
  covid_response?: string[] | null;
  funding_mechanism?: string | null;
  cfda_code?: string | null;
  project_detail_url?: string | null;
}

export interface SearchMeta {
  total: number;
  offset: number;
  limit: number;
  sort_field?: string | null;
  sort_order?: string | null;
  properties?: { URL?: string } | null;
}

export interface SearchResponse<T> {
  meta: SearchMeta;
  results: T[];
}

export interface Publication {
  coreproject: string;
  pmid: number;
  applid: number;
}

export interface ProjectQuery {
  criteria: Record<string, unknown>;
  offset?: number;
  limit?: number;
  sort_field?: string;
  sort_order?: "asc" | "desc";
  include_fields?: string[];
  exclude_fields?: string[];
}

export class ReporterError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ReporterError";
  }
}

type FetchFn = typeof fetch;

export interface ReporterClientOptions {
  fetch?: FetchFn;
  minIntervalMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ReporterClient {
  private readonly fetchFn: FetchFn;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private nextSlot = 0;

  constructor(opts: ReporterClientOptions = {}) {
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
    this.minIntervalMs = opts.minIntervalMs ?? 1000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  // Reserve the next send slot so concurrent calls also queue at 1/sec.
  private async pace(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.minIntervalMs;
    if (slot > now) await this.sleep(slot - now);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    let attempt = 0;
    for (;;) {
      await this.pace();
      let res: Response;
      try {
        res = await this.fetchFn(`${API_BASE}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(body),
        });
      } catch (err) {
        if (attempt++ < this.maxRetries) {
          await this.sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new ReporterError(`Could not reach NIH RePORTER: ${(err as Error).message}`);
      }
      if (res.ok) return (await res.json()) as T;
      // 429 and 5xx are worth another try; 4xx means our request is wrong.
      if ((res.status === 429 || res.status >= 500) && attempt++ < this.maxRetries) {
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      const text = (await res.text().catch(() => "")).slice(0, 500);
      throw new ReporterError(`NIH RePORTER returned HTTP ${res.status}: ${text}`, res.status);
    }
  }

  searchProjects(q: ProjectQuery): Promise<SearchResponse<Project>> {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), MAX_LIMIT);
    const offset = Math.min(Math.max(q.offset ?? 0, 0), MAX_OFFSET);
    const body: Record<string, unknown> = { criteria: q.criteria, offset, limit };
    if (q.sort_field) {
      body.sort_field = q.sort_field;
      body.sort_order = q.sort_order ?? "desc";
    }
    if (q.include_fields?.length) body.include_fields = q.include_fields;
    if (q.exclude_fields?.length) body.exclude_fields = q.exclude_fields;
    return this.post("/projects/search", body);
  }

  searchPublications(
    criteria: { pmids?: number[]; appl_ids?: number[]; core_project_nums?: string[] },
    offset = 0,
    limit = MAX_LIMIT,
  ): Promise<SearchResponse<Publication>> {
    return this.post("/publications/search", {
      criteria,
      offset: Math.min(Math.max(offset, 0), MAX_OFFSET),
      limit: Math.min(Math.max(limit, 1), MAX_LIMIT),
    });
  }

  // Page through a project search, up to maxRecords. Returns what it saw plus the API's total.
  async collectProjects(
    q: Omit<ProjectQuery, "offset" | "limit">,
    maxRecords: number,
  ): Promise<{ total: number; results: Project[] }> {
    const cap = Math.min(maxRecords, MAX_OFFSET + 1);
    const results: Project[] = [];
    let total = 0;
    let offset = 0;
    while (results.length < cap) {
      const limit = Math.min(MAX_LIMIT, cap - results.length);
      const page = await this.searchProjects({ ...q, offset, limit });
      total = page.meta.total;
      results.push(...page.results);
      offset += page.results.length;
      if (page.results.length < limit || offset >= total) break;
    }
    return { total, results };
  }
}
