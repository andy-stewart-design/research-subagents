// Local JSONL protocol fixture only. It never performs network requests or model calls.
import { appendFileSync, writeFileSync } from "node:fs";

const names = (process.env.FAKE_MCP_TOOLS ?? "search,scrape,code,docs,crawl,tag").split(",");
const marker = process.env.FAKE_MCP_MARKER ?? "fixture";
if (process.env.FAKE_MCP_PID) writeFileSync(process.env.FAKE_MCP_PID, String(process.pid));
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");

function handle(request) {
  if (request.id === undefined) return;
  const { id, method, params = {} } = request;
  if (method === "initialize") {
    reply(id, { protocolVersion: "2024-11-05", capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "fake-ketch", version: "test" }, instructions: "Controlled local fixture." });
  } else if (method === "tools/list") {
    setTimeout(() => reply(id, { tools: names.map((name) => ({
      name, description: "Fixture " + name,
      annotations: { readOnlyHint: name !== "tag", openWorldHint: true },
      inputSchema: {
        type: "object",
        properties: name === "scrape"
          ? { url: { type: "string" }, urls: { type: "array", items: { type: "string" } }, max_chars: { type: "integer" } }
          : { query: { type: "string" }, limit: { type: "integer" } },
        required: name === "scrape" ? [] : ["query"], additionalProperties: false,
      },
      outputSchema: { type: "object", properties: { results: { type: "array", items: { type: "object" } } },
        required: ["results"], additionalProperties: true },
    })) }), Number(process.env.FAKE_MCP_DELAY_MS ?? 0));
  } else if (method === "resources/list") {
    reply(id, { resources: [] });
  } else if (method === "resources/templates/list") {
    reply(id, { resourceTemplates: [] });
  } else if (method === "tools/call") {
    const args = params.arguments ?? {};
    if (process.env.FAKE_MCP_CALL_LOG) appendFileSync(process.env.FAKE_MCP_CALL_LOG,
      JSON.stringify({ name: params.name, args }) + "\n");
    if (typeof args.query === "string" && /^\[(validation|not_found|upstream|precondition|cancelled)\]$/.test(args.query)) {
      reply(id, { content: [{ type: "text", text: args.query + " fixture failure; operator/input action required." }], isError: true });
      return;
    }
    const data = {
      marker, tool: params.name,
      results: params.name === "scrape" && args.urls
        ? args.urls.map((url) => url.includes("bad.example")
          ? { url, error: "[upstream] fixture fetch failure" }
          : { url, title: "Fixture page", markdown: "# Fixture page" })
        : [{ title: "Fixture result", url: "https://example.test/" + params.name, snippet: "Controlled evidence" }],
      ...(args.query === "partial" ? { errors: { other: "[upstream] fixture backend unavailable" } } : {}),
    };
    reply(id, { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError: false });
  } else if (method === "ping") {
    reply(id, {});
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unknown fixture method" } }) + "\n");
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) if (line.trim()) handle(JSON.parse(line));
});
process.stdin.on("end", () => process.exit(0));
