import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "bun",
  args: [new URL("../dist/mcp/stdio.js", import.meta.url).pathname],
  env: {
    ...process.env,
    BUNDLE_ROOT: process.env.SMOKE_BUNDLE!,
  } as Record<string, string>,
});

const client = new Client({ name: "smoke", version: "0.0.1" });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

// Seed memory — channel 1: initialize instructions
const instructions = client.getInstructions();
console.log(
  "INSTRUCTIONS:",
  instructions?.includes("MEMORY OVERVIEW")
    ? `ok (${instructions.length} chars) — ${instructions.slice(0, 160).replace(/\n/g, " ")}…`
    : `MISSING SEED — got: ${String(instructions).slice(0, 120)}`
);

// Seed memory — channel 2: memory_query tool description
const queryTool = tools.tools.find((t) => t.name === "memory_query");
console.log(
  "QUERY_DESC:",
  queryTool?.description?.includes("CURRENT MEMORY OVERVIEW")
    ? `ok (${queryTool.description.length} chars)`
    : "MISSING SEED IN DESCRIPTION"
);

const status = await client.callTool({ name: "memory_status", arguments: {} });
console.log("STATUS:", (status.content as { text: string }[])[0].text);

if (process.env.HERMES_PROFILE_HOME) {
  const q = await client.callTool({
    name: "memory_query",
    arguments: { question: "What is the billing API rate limit?" },
  });
  console.log("QUERY:", (q.content as { text: string }[])[0].text.slice(0, 400));
}

await client.close();
