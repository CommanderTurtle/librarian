import { runHermesGateway } from "../hermes/gateway.js";
import { runOmpGateway } from "../omp/gateway.js";
import type {
  AgentBackend,
  AgentRunOptions,
  AgentRunResult,
} from "./types.js";

export * from "./types.js";

export function resolveAgentBackend(value = process.env.LIBRARIAN_AGENT_BACKEND): AgentBackend {
  const normalized = (value || "hermes").trim().toLowerCase();
  if (normalized === "hermes" || normalized === "omp") return normalized;
  throw new Error(
    `Unsupported LIBRARIAN_AGENT_BACKEND "${value}"; expected "hermes" or "omp"`
  );
}

export function agentBackendLabel(value?: string): "Hermes" | "OMP" {
  return resolveAgentBackend(value) === "omp" ? "OMP" : "Hermes";
}

/** Run one isolated Librarian turn through the selected native agent RPC. */
export async function runAgentGateway(
  prompt: string,
  options: AgentRunOptions = {}
): Promise<AgentRunResult> {
  const backend = options.backend ?? resolveAgentBackend();
  if (backend === "omp") return runOmpGateway(prompt, options);
  return runHermesGateway(prompt, options);
}
