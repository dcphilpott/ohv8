// Cloudflare Worker entry: a stateless Streamable HTTP MCP endpoint at /mcp.
// Add https://<your-worker>.workers.dev/mcp as a custom connector in claude.ai.
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ReporterClient } from "./reporter.js";
import { buildServer } from "./tools.js";

// One client per isolate so the 1 request/second pacing holds across concurrent tool calls.
const client = new ReporterClient();

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" && request.method === "GET") {
      return new Response("NIH RePORTER MCP server. Connect an MCP client to /mcp.\n", {
        headers: { "Content-Type": "text/plain" },
      });
    }
    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });

    const server = buildServer(client);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
