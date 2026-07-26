import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

type JsonObject = Record<string, unknown>;

export interface HermesToolEvent {
  toolId?: string;
  name: string;
  input?: unknown;
  output?: unknown;
  status: "running" | "complete" | "error";
}

export interface HermesRunOptions {
  model?: string;
  provider?: string;
  cwd?: string;
  title?: string;
  timeoutMs?: number;
}

export interface HermesRunResult {
  answer: string;
  sessionId: string;
  toolEvents: HermesToolEvent[];
  modelLabel: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface GatewayEvent {
  type: string;
  session_id?: string;
  payload?: JsonObject;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_STDERR_CHARS = 24_000;

/**
 * Minimal newline-delimited JSON-RPC client for Hermes' TUI gateway.
 *
 * A fresh process is used for every librarian call. This gives each call its
 * own persisted Hermes session and avoids sharing mutable agent-loop state
 * between concurrent MCP requests.
 */
export class HermesGatewayClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly toolEvents: HermesToolEvent[] = [];
  private readonly toolIndexes = new Map<string, number>();
  private readonly stderr: string[] = [];
  private nextId = 1;
  private disposed = false;
  private sessionId = "";
  private finalResolve?: (event: GatewayEvent) => void;
  private finalReject?: (error: Error) => void;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readonly ready: Promise<void>;

  constructor() {
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    const profileHome = expandHome(
      process.env.HERMES_PROFILE_HOME ?? "~/.hermes/profiles/librarian"
    );
    const python = expandHome(
      process.env.HERMES_PYTHON ?? "~/.hermes/hermes-agent/venv/bin/python"
    );

    this.child = spawn(python, ["-m", "tui_gateway.entry"], {
      cwd: process.env.LIBRARIAN_WORKDIR || process.cwd(),
      env: {
        ...process.env,
        HERMES_HOME: profileHome,
        PYTHONUNBUFFERED: "1",
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
          `Hermes gateway exited before completion (${signal ?? `code ${code ?? "unknown"}`})${
            detail ? `: ${detail}` : ""
          }`
        )
      );
    });
  }

  async run(prompt: string, options: HermesRunOptions = {}): Promise<HermesRunResult> {
    await withTimeout(this.ready, REQUEST_TIMEOUT_MS, "Hermes gateway startup");

    const model = options.model ?? process.env.HERMES_MODEL;
    const provider = options.provider ?? process.env.HERMES_PROVIDER;
    const created = asObject(
      await this.request("session.create", {
        ...(model ? { model } : {}),
        ...(provider ? { provider } : {}),
        cwd: options.cwd ?? process.env.LIBRARIAN_WORKDIR ?? process.cwd(),
        title: options.title ?? "Librarian",
        source: "librarian",
        close_on_disconnect: true,
      })
    );
    this.sessionId = firstString(
      created.session_id,
      created.runtime_session_id,
      created.id
    );
    if (!this.sessionId) {
      throw new Error("Hermes session.create did not return a session id");
    }

    const completion = new Promise<GatewayEvent>((resolve, reject) => {
      this.finalResolve = resolve;
      this.finalReject = reject;
    });

    await this.request("prompt.submit", {
      session_id: this.sessionId,
      text: prompt,
    });

    const event = await withTimeout(
      completion,
      options.timeoutMs ?? numberEnv("HERMES_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
      "Hermes librarian turn"
    );
    const payload = event.payload ?? {};
    const status = firstString(payload.status);
    const answer = firstString(payload.text);
    if (status === "error") {
      throw new Error(firstString(payload.error, payload.message, answer) || "Hermes turn failed");
    }

    return {
      answer,
      sessionId: this.sessionId,
      toolEvents: this.toolEvents,
      modelLabel: `${provider || "profile"}:${model || "default"}`,
    };
  }

  async close(): Promise<void> {
    if (this.disposed) return;
    if (this.sessionId) {
      await this.request("session.close", { session_id: this.sessionId }).catch(() => {});
    }
    this.dispose();
  }

  private request(method: string, params: JsonObject): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error("Hermes gateway is closed"));
    const id = this.nextId++;
    const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Hermes request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${message}\n`, "utf8", (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private onLine(line: string): void {
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      return;
    }

    if (typeof message.id === "number") {
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(message.id);
      if (message.error) {
        request.reject(new Error(errorText(message.error)));
      } else {
        request.resolve(message.result);
      }
      return;
    }

    if (message.method !== "event") return;
    const params = asObject(message.params);
    const event: GatewayEvent = {
      type: firstString(params.type),
      ...(typeof params.session_id === "string" ? { session_id: params.session_id } : {}),
      ...(params.payload && typeof params.payload === "object"
        ? { payload: asObject(params.payload) }
        : {}),
    };
    this.onEvent(event);
  }

  private onEvent(event: GatewayEvent): void {
    const payload = event.payload ?? {};
    switch (event.type) {
      case "gateway.ready":
        this.readyResolve();
        break;
      case "message.complete":
        if (!this.sessionId || !event.session_id || event.session_id === this.sessionId) {
          this.finalResolve?.(event);
        }
        break;
      case "tool.start":
      case "tool.progress":
      case "tool.generating":
        this.recordToolStart(payload);
        break;
      case "tool.complete":
        this.recordToolComplete(payload);
        break;
      case "approval.request":
        void this.request("approval.respond", {
          choice: "deny",
          ...(event.session_id ? { session_id: event.session_id } : {}),
        }).catch(() => {});
        break;
      case "clarify.request":
        void this.request("clarify.respond", {
          request_id: firstString(payload.request_id, payload.id),
          answer:
            "This librarian call is headless. Continue with the supplied task and available knowledge; report any essential missing detail in the final response.",
        }).catch(() => {});
        break;
      case "sudo.request":
        void this.request("sudo.respond", {
          request_id: firstString(payload.request_id, payload.id),
          password: "",
        }).catch(() => {});
        break;
      case "secret.request":
        void this.request("secret.respond", {
          request_id: firstString(payload.request_id, payload.id),
          value: "",
        }).catch(() => {});
        break;
      case "error":
        this.finalReject?.(
          new Error(firstString(payload.message, payload.error) || "Hermes gateway error")
        );
        break;
    }
  }

  private recordToolStart(payload: JsonObject): void {
    const toolId = firstString(payload.tool_id, payload.id);
    const event: HermesToolEvent = {
      ...(toolId ? { toolId } : {}),
      name: firstString(payload.name, payload.tool_name) || "unknown",
      input: payload.input ?? payload.arguments ?? payload.args,
      status: "running",
    };
    if (toolId && this.toolIndexes.has(toolId)) return;
    const index = this.toolEvents.push(event) - 1;
    if (toolId) this.toolIndexes.set(toolId, index);
  }

  private recordToolComplete(payload: JsonObject): void {
    const toolId = firstString(payload.tool_id, payload.id);
    const index = toolId ? this.toolIndexes.get(toolId) : undefined;
    const status = payload.error ? "error" : "complete";
    if (index !== undefined) {
      this.toolEvents[index] = {
        ...this.toolEvents[index],
        output: payload.output ?? payload.result ?? payload.error,
        status,
      };
      return;
    }
    this.toolEvents.push({
      ...(toolId ? { toolId } : {}),
      name: firstString(payload.name, payload.tool_name) || "unknown",
      input: payload.input ?? payload.arguments ?? payload.args,
      output: payload.output ?? payload.result ?? payload.error,
      status,
    });
  }

  private failAll(error: Error): void {
    this.readyReject(error);
    this.finalReject?.(error);
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
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

export async function runHermesGateway(
  prompt: string,
  options: HermesRunOptions = {}
): Promise<HermesRunResult> {
  const client = new HermesGatewayClient();
  try {
    return await client.run(prompt, options);
  } finally {
    await client.close();
  }
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

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const error = asObject(value);
  return firstString(error.message, error.error) || JSON.stringify(value);
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
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
