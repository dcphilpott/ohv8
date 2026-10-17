import type { Person, Project } from "./reporter.js";

export const projectUrl = (applId: number) => `https://reporter.nih.gov/project-details/${applId}`;

export function usd(n: number | null | undefined): string {
  if (n == null) return "amount not reported";
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

const day = (s: string | null | undefined) => (s ? s.slice(0, 10) : "?");

export function personName(p: Person): string {
  if (p.last_name) {
    const first = [p.first_name, p.middle_name].filter(Boolean).join(" ");
    return first ? `${p.last_name}, ${first}` : p.last_name;
  }
  return p.full_name ?? "unknown";
}

export function piList(p: Project): string {
  const pis = p.principal_investigators ?? [];
  if (!pis.length) return p.contact_pi_name ?? "none listed";
  return pis
    .map((x) => `${personName(x)}${x.is_contact_pi && pis.length > 1 ? " (contact)" : ""}${x.profile_id ? ` [profile ${x.profile_id}]` : ""}`)
    .join("; ");
}

export function orgLine(p: Project): string {
  const o = p.organization;
  if (!o?.org_name) return "organization not listed";
  const place = [o.org_city, o.org_state, o.org_country && o.org_country !== "UNITED STATES" ? o.org_country : null]
    .filter(Boolean)
    .join(", ");
  return place ? `${o.org_name} (${place})` : o.org_name;
}

export const icAbbrev = (p: Project) => p.agency_ic_admin?.abbreviation ?? p.agency_ic_admin?.code ?? "IC?";

// One compact block per project for search results.
export function projectSummary(p: Project): string {
  const lines = [
    `${p.project_num ?? "no project number"} (FY${p.fiscal_year ?? "?"}) — ${p.project_title ?? "untitled"}`,
    `  PI: ${piList(p)}`,
    `  ${orgLine(p)} | ${icAbbrev(p)} | ${p.activity_code ?? "?"} | ${usd(p.award_amount)} | ${day(p.project_start_date)} to ${day(p.project_end_date)}${p.is_active ? " | active" : ""}`,
    `  appl_id ${p.appl_id} | ${projectUrl(p.appl_id)}`,
  ];
  return lines.join("\n");
}

export function projectDetail(p: Project): string {
  const out: string[] = [];
  out.push(`# ${p.project_title ?? "Untitled"}`);
  out.push(`Project: ${p.project_num ?? "?"} (core ${p.core_project_num ?? "?"}), FY${p.fiscal_year ?? "?"}, appl_id ${p.appl_id}`);
  out.push(`RePORTER page: ${projectUrl(p.appl_id)}`);
  out.push(`PI(s): ${piList(p)}`);
  const pos = (p.program_officers ?? []).map((po) => `${personName(po)}${po.email ? ` <${po.email}>` : ""}`);
  if (pos.length) out.push(`Program officer: ${pos.join("; ")}`);
  out.push(`Organization: ${orgLine(p)}${p.organization?.dept_type ? `, dept type ${p.organization.dept_type}` : ""}`);
  out.push(
    `Administering IC: ${p.agency_ic_admin?.name ?? "?"} (${icAbbrev(p)}); activity ${p.activity_code ?? "?"}, award type ${p.award_type ?? "?"}${p.funding_mechanism ? `, mechanism: ${p.funding_mechanism}` : ""}`,
  );
  out.push(
    `This fiscal year: ${usd(p.award_amount)} total (direct ${usd(p.direct_cost_amt)}, indirect ${usd(p.indirect_cost_amt)}); budget period ${day(p.budget_start)} to ${day(p.budget_end)}`,
  );
  const fundings = (p.agency_ic_fundings ?? []).filter((f) => f.total_cost);
  if (fundings.length > 1) {
    out.push(`Funding ICs: ${fundings.map((f) => `${f.abbreviation ?? f.code} ${usd(f.total_cost)}`).join("; ")}`);
  }
  out.push(`Project period: ${day(p.project_start_date)} to ${day(p.project_end_date)}${p.is_active ? " (active)" : ""}`);
  if (p.opportunity_number) out.push(`Funding opportunity: ${p.opportunity_number}`);
  if (p.full_study_section?.name) out.push(`Study section: ${p.full_study_section.name}`);
  if (p.spending_categories_desc) out.push(`NIH spending categories (RCDC): ${p.spending_categories_desc}`);
  if (p.covid_response?.length) out.push(`COVID response funding: ${p.covid_response.join(", ")}`);
  if (p.abstract_text) out.push("", "## Abstract", p.abstract_text.trim());
  if (p.phr_text) out.push("", "## Public health relevance", p.phr_text.trim());
  if (p.pref_terms) out.push("", "## Terms", p.pref_terms.replace(/;/g, "; "));
  return out.join("\n");
}
