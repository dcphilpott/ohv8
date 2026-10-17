import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker.js";

const rpc = (body: unknown) =>
  new Request("https://example.workers.dev/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });

afterEach(() => vi.unstubAllGlobals());

describe("worker", () => {
  it("answers initialize, tools/list, and tools/call over stateless HTTP", async () => {
    const init = await worker.fetch(
      rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
    );
    expect(init.status).toBe(200);
    const initBody: any = await init.json();
    expect(initBody.result.serverInfo.name).toBe("nih-reporter");
    expect(initBody.result.instructions).toContain("One record per project per fiscal year");

    const list: any = await (await worker.fetch(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }))).json();
    expect(list.result.tools).toHaveLength(6);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ meta: { total: 0, offset: 0, limit: 25 }, results: [] }), { status: 200 })),
    );
    const res: any = await (
      await worker.fetch(rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_projects", arguments: { criteria: { fiscal_years: [2025] } } } }))
    ).json();
    expect(JSON.parse(res.result.content[0].text).meta.total).toBe(0);
  });

  it("404s other paths", async () => {
    expect((await worker.fetch(new Request("https://example.workers.dev/nope"))).status).toBe(404);
  });
});
