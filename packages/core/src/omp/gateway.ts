import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type {
  AgentRunOptions,
  AgentRunResult,
  AgentToolEvent,
} from "../gateway/types.js";

type JsonObject = Record<string, unknown>;

interface PendingRequest {
  resolve: (value: JsonObject) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_STDERR_CHARS = 24_000;
/**
 * JSONL client for OMP's documented `omp --mode rpc` protocol.
 *
 * OMP is not JSON-RPC 2.0: commands are correlated by string `id`, prompt
 * acceptance is immediate, and the turn completes on `agent_end`. Keeping the
 * implementation separate from Hermes makes that distinction explicit while
 * exposing one small result contract to Librarian.
 */
export class OmpGatewayClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly toolEvents: AgentToolEvent[] = [];
  private readonly toolIndexes = new Map<string, number>();
  private readonly stderr: string[] = [];
  private readonly options: AgentRunOptions;
  private nextId = 1;
  private disposed = false;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readonly ready: Promise<void>;
  private finalResolve?: () => void;
  private finalReject?: (error: Error) => void;
  private lastAssistantText = "";
  private sessionId = "";
  private modelLabel = "profile:default";

  constructor(options: AgentRunOptions = {}) {
    this.options = options;
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    const command = expandHome(process.env.OMP_COMMAND || "omp");
    const args = ["--mode", "rpc", "--no-session"];
    const profile =
      process.env.OMP_PROFILE?.trim() ||
      process.env.LIBRARIAN_PROFILE?.trim() ||
      "librarian";
    if (profile) args.push("--profile", profile);

    this.child = spawn(command, args, {
      cwd: options.cwd ?? process.env.LIBRARIAN_WORKDIR ?? process.cwd(),
      env: {
        ...process.env,
        PI_RPC_EMIT_TITLE: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.onLine(line));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr.push(chunk.toString("utf8"));
      while (this.stderr.join("").length > MAX_STDERR_CHARS) this.stderr.shift();
    });
    this.child.once("error", (error) => this.failAll(error));
    this.child.once("exit", (code, signal) => {
      if (this.disposed) return;
      const detail = this.stderr.join("").trim();
      this.failAll(
        new Error(
          `OMP RPC exited before completion (${signal ?? `code ${code ?? "unknown"}`})${
            detail ? `: ${detail}` : ""
          }`
        )
      );
    });
  }

  async run(prompt: string): Promise<AgentRunResult> {
    await withTimeout(this.ready, REQUEST_TIMEOUT_MS, "OMP RPC startup");

    const model = this.options.model ?? process.env.OMP_MODEL;
    const explicitProvider = this.options.provider ?? process.env.OMP_PROVIDER;
    const selected = splitModel(model, explicitProvider);
    if (selected) {
      await this.request("set_model", {
        provider: selected.provider,
        modelId: selected.model,
      });
      this.modelLabel = `${selected.provider}:${selected.model}`;
    }

    const state = await this.request("get_state");
    const stateData = asObject(state.data);
    this.sessionId = firstString(stateData.sessionId, stateData.session_id);
    if (!selected) {
      const stateModel = asObject(stateData.model);
      const provider = firstString(stateModel.provider);
      const modelId = firstString(stateModel.id, stateModel.modelId);
      if (provider || modelId) this.modelLabel = `${provider || "profile"}:${modelId || "default"}`;
    }

    const completion = new Promise<void>((resolve, reject) => {
      this.finalResolve = resolve;
      this.finalReject = reject;
    });

    const response = await this.request("prompt", { message: prompt });
    const responseData = asObject(response.data);
    if (responseData.agentInvoked === false) {
      const final = await this.request("get_last_assistant_text");
      this.lastAssistantText = firstString(asObject(final.data).text);
      this.finalResolve?.();
    }

    await withTimeout(
      completion,
      this.options.timeoutMs ?? numberEnv("OMP_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
      "OMP librarian turn"
    );

    return {
      answer: this.lastAssistantText,
      sessionId: this.sessionId,
      toolEvents: this.toolEvents,
      modelLabel: this.modelLabel,
      backend: "omp",
    };
  }

  async close(): Promise<void> {
    this.dispose();
  }

  private request(type: string, fields: JsonObject = {}): Promise<JsonObject> {
    if (this.disposed) return Promise.reject(new Error("OMP RPC is closed"));
    const id = `librarian-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`OMP request timed out: ${type}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, type, ...fields }, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private write(message: JsonObject, callback?: (error?: Error | null) => void): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`, "utf8", callback);
  }

  private onLine(line: string): void {
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      return;
    }

    if (message.type === "ready") {
      this.readyResolve();
      return;
    }

    if (message.type === "response") {
      const id = firstString(message.id);
      const pending = id ? this.pending.get(id) : undefined;
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (message.success === false) {
        pending.reject(new Error(firstString(message.error) || "OMP command failed"));
      } else {
        pending.resolve(message);
      }
      return;
    }

    switch (message.type) {
      case "message_end": {
        const text = assistantText(message.message);
        if (text) this.lastAssistantText = text;
        break;
      }
      case "agent_end": {
        const messages = Array.isArray(message.messages) ? message.messages : [];
        for (let index = messages.length - 1; index >= 0; index--) {
          const text = assistantText(messages[index]);
          if (text) {
            this.lastAssistantText = text;
            break;
          }
        }
        this.finalResolve?.();
        break;
      }
      case "tool_execution_start":
        this.recordToolStart(message);
        break;
      case "tool_execution_update":
        this.recordToolUpdate(message);
        break;
      case "tool_execution_end":
        this.recordToolComplete(message);
        break;
      case "extension_ui_request":
        this.answerUiRequest(message);
        break;
      case "extension_error":
        // OMP reports extension failures out-of-band. An unrelated optional
        // extension must not abort a completed Librarian turn; preserve the
        // diagnostic and let command/process/agent lifecycle failures decide
        // whether the turn itself failed.
        this.stderr.push(
          `[extension ${firstString(message.extensionPath) || "unknown"}] ${
            firstString(message.error) || "OMP extension failed"
          }\n`
        );
        break;
      case "prompt_result":
        if (message.agentInvoked === false) this.finalResolve?.();
        break;
    }
  }

  private answerUiRequest(message: JsonObject): void {
    const id = firstString(message.id);
    if (!id) return;
    const method = firstString(message.method);
    if (method === "confirm") {
      this.write({ type: "extension_ui_response", id, confirmed: false });
    } else if (["select", "input", "editor"].includes(method)) {
      this.write({ type: "extension_ui_response", id, cancelled: true });
    }
  }

  private recordToolStart(message: JsonObject): void {
    const toolId = firstString(message.toolCallId, message.tool_call_id, message.id);
    const event: AgentToolEvent = {
      ...(toolId ? { toolId } : {}),
      name: firstString(message.toolName, message.tool_name) || "unknown",
      input: message.args ?? message.arguments,
      status: "running",
    };
    if (toolId && this.toolIndexes.has(toolId)) return;
    const index = this.toolEvents.push(event) - 1;
    if (toolId) this.toolIndexes.set(toolId, index);
  }

  private recordToolUpdate(message: JsonObject): void {
    const toolId = firstString(message.toolCallId, message.tool_call_id, message.id);
    const index = toolId ? this.toolIndexes.get(toolId) : undefined;
    if (index !== undefined) {
      this.toolEvents[index] = {
        ...this.toolEvents[index],
        output: message.partialResult ?? message.partial_result,
      };
    }
  }

  private recordToolComplete(message: JsonObject): void {
    const toolId = firstString(message.toolCallId, message.tool_call_id, message.id);
    const index = toolId ? this.toolIndexes.get(toolId) : undefined;
    const status = message.isError ? "error" : "complete";
    if (index !== undefined) {
      this.toolEvents[index] = {
        ...this.toolEvents[index],
        output: message.result,
        status,
      };
      return;
    }
    this.toolEvents.push({
      ...(toolId ? { toolId } : {}),
      name: firstString(message.toolName, message.tool_name) || "unknown",
      input: message.args ?? message.arguments,
      output: message.result,
      status,
    });
  }

  private failAll(error: Error): void {
    this.readyReject(error);
    this.finalReject?.(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.child.stdin.end();
    if (!this.child.killed) this.child.kill("SIGTERM");
  }
}

export async function runOmpGateway(
  prompt: string,
  options: AgentRunOptions = {}
): Promise<AgentRunResult> {
  const client = new OmpGatewayClient(options);
  try {
    return await client.run(prompt);
  } finally {
    await client.close();
  }
}

function splitModel(
  model: string | undefined,
  provider: string | undefined
): { provider: string; model: string } | null {
  const normalizedModel = model?.trim();
  const normalizedProvider = provider?.trim();
  if (!normalizedModel && !normalizedProvider) return null;
  if (normalizedModel?.includes("/") && !normalizedProvider) {
    const separator = normalizedModel.indexOf("/");
    return {
      provider: normalizedModel.slice(0, separator),
      model: normalizedModel.slice(separator + 1),
    };
  }
  if (!normalizedModel || !normalizedProvider) {
    throw new Error("OMP model overrides require both OMP_PROVIDER and OMP_MODEL (or provider/model in OMP_MODEL)");
  }
  return { provider: normalizedProvider, model: normalizedModel };
}

function assistantText(value: unknown): string {
  const message = asObject(value);
  if (message.role !== "assistant") return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => {
      const block = asObject(part);
      return block.type === "text" ? firstString(block.text) : "";
    })
    .filter(Boolean)
    .join("");
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value) return value;
  }
  return "";
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
