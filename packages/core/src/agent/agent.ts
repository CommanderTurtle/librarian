import type { KnowledgeBase } from "../okf/index.js";
import type { TreeNode } from "../okf/types.js";
import {
  runHermesGateway,
  type HermesRunOptions,
  type HermesToolEvent,
} from "../hermes/gateway.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { formatTree } from "./tools.js";
import { TraceRecorder, TraceStore } from "./trace.js";

export interface AgentOptions extends HermesRunOptions {}

export interface QueryResult {
  answer: string;
  steps: number;
  traceId: string;
  sessionId: string;
}

export interface MutationResult {
  summary: string;
  filesChanged: string[];
  steps: number;
  traceId: string;
  sessionId: string;
}

export type MutationOutcome =
  | { ok: true; result: MutationResult }
  | { ok: false; status: "partial"; filesChanged: string[]; error: string; traceId: string }
  | { ok: false; status: "failed"; error: string };

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatResult {
  answer: string;
  filesChanged: string[];
  steps: number;
  traceId?: string;
  sessionId: string;
  toolEvents: HermesToolEvent[];
}

async function promptContext(kb: KnowledgeBase, mode: "query" | "mutate" | "chat") {
  const [types, tree] = await Promise.all([kb.listTypes(), kb.listTree()]);
  return { existingTypes: types, treeSummary: formatTree(tree), mode };
}

function traceStore(kb: KnowledgeBase): TraceStore {
  return new TraceStore(kb.bundle.root);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function buildHermesPrompt(system: string, task: string): string {
  return `${system}

## Execution boundary

This is a headless Librarian operation. Use the \`librarian-okf\` MCP tools for
all knowledge-base reads and writes. Do not edit bundle files with terminal or
filesystem tools. The MCP operations are the conformance boundary and
automatically maintain indexes and logs.

## Requested operation

${task}`;
}

/** Read-only Q&A over the bundle, executed by a fresh Hermes session. */
export async function runQuery(
  kb: KnowledgeBase,
  question: string,
  options: AgentOptions = {}
): Promise<QueryResult> {
  const ctx = await promptContext(kb, "query");
  const recorder = new TraceRecorder();
  let modelChain: string[] = [];
  try {
    const result = await runHermesGateway(
      buildHermesPrompt(buildSystemPrompt(ctx), question),
      { ...options, title: options.title ?? "Librarian query" }
    );
    modelChain = [result.modelLabel];
    recordToolEvents(recorder, result.toolEvents);
    const trace = recorder.finalize("query", question, result.answer, "success", modelChain);
    await traceStore(kb).save(trace);
    return {
      answer: result.answer,
      steps: recorder.steps.length,
      traceId: trace.id,
      sessionId: result.sessionId,
    };
  } catch (err) {
    const trace = recorder.finalize("query", question, errorMessage(err), "failed", modelChain);
    await traceStore(kb).save(trace);
    throw err;
  }
}

/** Knowledge add/update, executed by a fresh Hermes session. */
export async function runMutation(
  kb: KnowledgeBase,
  instruction: string,
  options: AgentOptions = {}
): Promise<MutationOutcome> {
  const ctx = await promptContext(kb, "mutate");
  const recorder = new TraceRecorder();
  const before = await snapshotConcepts(kb);
  let modelChain: string[] = [];
  try {
    const result = await runHermesGateway(
      buildHermesPrompt(buildSystemPrompt(ctx), instruction),
      { ...options, title: options.title ?? "Librarian mutation" }
    );
    modelChain = [result.modelLabel];
    recordToolEvents(recorder, result.toolEvents);
    const filesChanged = changedConcepts(before, await snapshotConcepts(kb));
    const trace = recorder.finalize(
      "mutation",
      instruction,
      result.answer,
      "success",
      modelChain
    );
    await traceStore(kb).save(trace);
    return {
      ok: true,
      result: {
        summary: result.answer,
        filesChanged,
        steps: recorder.steps.length,
        traceId: trace.id,
        sessionId: result.sessionId,
      },
    };
  } catch (err) {
    const filesChanged = changedConcepts(before, await snapshotConcepts(kb));
    const message = errorMessage(err);
    if (filesChanged.length > 0) {
      const summary = `Partial mutation: ${filesChanged.length} concept(s) changed before failure. Error: ${message}`;
      const trace = recorder.finalize("mutation", instruction, summary, "partial", modelChain);
      await traceStore(kb).save(trace);
      return {
        ok: false,
        status: "partial",
        filesChanged,
        error: message,
        traceId: trace.id,
      };
    }
    const trace = recorder.finalize("mutation", instruction, message, "failed", modelChain);
    await traceStore(kb).save(trace);
    return { ok: false, status: "failed", error: message };
  }
}

/** Interactive web chat backed by a fresh Hermes session. */
export async function runChat(
  kb: KnowledgeBase,
  messages: ChatMessage[],
  options: AgentOptions = {}
): Promise<ChatResult> {
  const ctx = await promptContext(kb, "chat");
  const recorder = new TraceRecorder();
  const before = await snapshotConcepts(kb);
  const transcript = messages
    .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
    .join("\n\n");
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const input = lastUser?.content ?? "(chat)";
  let modelChain: string[] = [];

  try {
    const result = await runHermesGateway(
      buildHermesPrompt(buildSystemPrompt(ctx), transcript),
      { ...options, title: options.title ?? "Librarian chat" }
    );
    modelChain = [result.modelLabel];
    recordToolEvents(recorder, result.toolEvents);
    const filesChanged = changedConcepts(before, await snapshotConcepts(kb));
    let traceId: string | undefined;
    if (recorder.steps.length > 0) {
      const trace = recorder.finalize("chat", input, result.answer, "success", modelChain);
      await traceStore(kb).save(trace);
      traceId = trace.id;
    }
    return {
      answer: result.answer,
      filesChanged,
      steps: recorder.steps.length,
      ...(traceId ? { traceId } : {}),
      sessionId: result.sessionId,
      toolEvents: result.toolEvents,
    };
  } catch (err) {
    const outcome = changedConcepts(before, await snapshotConcepts(kb)).length > 0
      ? "partial"
      : "failed";
    await traceStore(kb).save(
      recorder.finalize("chat", input, errorMessage(err), outcome, modelChain)
    );
    throw err;
  }
}

function recordToolEvents(recorder: TraceRecorder, events: HermesToolEvent[]): void {
  for (const event of events) {
    if (event.status === "running") continue;
    const tool = normalizeToolName(event.name);
    const input = asRecord(event.input);
    const paths = collectPaths(event.input, event.output);
    const summary =
      typeof input.query === "string"
        ? input.query
        : typeof input.path === "string"
          ? input.path
          : "";
    recorder.record(
      tool,
      summary,
      paths,
      ["write_concept", "patch_concept", "delete_concept"].includes(tool)
    );
  }
}

function normalizeToolName(name: string): string {
  const known = [
    "search_knowledge",
    "read_concept",
    "list_directory",
    "lint_knowledge",
    "write_concept",
    "patch_concept",
    "delete_concept",
  ];
  return known.find((tool) => name.endsWith(tool)) ?? name;
}

function collectPaths(...values: unknown[]): string[] {
  const paths = new Set<string>();
  const visit = (value: unknown, depth = 0) => {
    if (depth > 6) return;
    if (typeof value === "string") {
      if (/^\/[^/].*\.md$/.test(value)) paths.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (value && typeof value === "object") {
      for (const nested of Object.values(value as Record<string, unknown>)) {
        visit(nested, depth + 1);
      }
    }
  };
  for (const value of values) visit(value);
  return [...paths].sort();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function snapshotConcepts(kb: KnowledgeBase): Promise<Map<string, string>> {
  const tree = await kb.listTree();
  const paths: string[] = [];
  const visit = (node: TreeNode) => {
    if (node.kind === "concept") paths.push(node.path);
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  const concepts = await Promise.all(
    paths.map(async (conceptPath) => {
      const concept = await kb.readConcept(conceptPath);
      return [conceptPath, concept.raw] as const;
    })
  );
  return new Map(concepts);
}

function changedConcepts(
  before: Map<string, string>,
  after: Map<string, string>
): string[] {
  const all = new Set([...before.keys(), ...after.keys()]);
  return [...all]
    .filter((conceptPath) => before.get(conceptPath) !== after.get(conceptPath))
    .sort();
}
