export type AgentBackend = "hermes" | "omp";

export interface AgentToolEvent {
  toolId?: string;
  name: string;
  input?: unknown;
  output?: unknown;
  status: "running" | "complete" | "error";
}

export interface AgentRunOptions {
  /** Override LIBRARIAN_AGENT_BACKEND for one call. */
  backend?: AgentBackend;
  model?: string;
  provider?: string;
  cwd?: string;
  /** Override librarian-okf's bundle for this delegated process only. */
  bundleRoot?: string;
  title?: string;
  timeoutMs?: number;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AgentRunResult {
  answer: string;
  sessionId: string;
  toolEvents: AgentToolEvent[];
  modelLabel: string;
  backend: AgentBackend;
  /** Per-run usage when the selected RPC protocol reports it. */
  usage?: AgentUsage;
}
