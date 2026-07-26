/**
 * Verifies the seed auto-refresh: within ONE stdio session, memory_add a new
 * fact, then re-list tools — memory_query's description must now mention it.
 *   SMOKE_BUNDLE=<abs path> HERMES_PROFILE_HOME=~/.hermes/profiles/librarian \
 *     bun packages/server/scripts/seed-refresh-test.mts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "bun",
  args: [new URL("../dist/mcp/stdio.js", import.meta.url).pathname],
  env: { ...process.env, BUNDLE_ROOT: process.env.SMOKE_BUNDLE! } as Record<string, string>,
});

const client = new Client({ name: "refresh-test", version: "0.0.1" });
await client.connect(transport);

const before = (await client.listTools()).tools.find((t) => t.name === "memory_query")!;
console.log("BEFORE has 'Grafana':", before.description!.includes("grafana"));

await client.callTool({
  name: "memory_add",
  arguments: {
    content:
      "Our team dashboards live in Grafana at grafana.acme.internal; the billing overview dashboard is the one on-call should check first.",
  },
});

const after = (await client.listTools()).tools.find((t) => t.name === "memory_query")!;
const refreshed = after.description!.toLowerCase().includes("grafana");
console.log("AFTER has 'grafana':", refreshed);
console.log(refreshed ? "REFRESH OK" : "REFRESH FAILED");

await client.close();
process.exit(refreshed ? 0 : 1);
