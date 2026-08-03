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
  title?: string;
  timeoutMs?: number;
}

export interface AgentRunResult {
  answer: string;
  sessionId: string;
  toolEvents: AgentToolEvent[];
  modelLabel: string;
  backend: AgentBackend;
}
