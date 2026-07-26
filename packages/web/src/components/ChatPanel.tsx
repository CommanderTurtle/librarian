import { useState } from "react";
import { MarkdownRenderer } from "../components/MarkdownRenderer";
import { authHeaders } from "../api";
import type { AppConfig } from "../api";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ToolEvent {
  name: string;
  status: "running" | "complete" | "error";
}

interface ChatResponse {
  answer: string;
  filesChanged: string[];
  toolEvents: ToolEvent[];
}

export function ChatPanel({
  config,
  onMutation,
}: {
  config: AppConfig | null;
  onMutation: () => void;
  onOpenConcept: (path: string) => void;
}) {
  const [input, setInput] = useState("");
  const [model, setModel] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [latestTools, setLatestTools] = useState<ToolEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const nextMessages: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(nextMessages);
    setInput("");
    setBusy(true);
    setError("");
    setLatestTools([]);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ messages: nextMessages, model: model || undefined }),
      });
      const payload = (await response.json()) as ChatResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error || `${response.status} ${response.statusText}`);
      setMessages([...nextMessages, { role: "assistant", content: payload.answer }]);
      setLatestTools(payload.toolEvents ?? []);
      if (payload.filesChanged?.length) onMutation();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <span className="text-sm font-semibold text-zinc-300">Librarian chat</span>
        {config && (
          <input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder={config.model}
            className="ml-auto w-40 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-xs text-zinc-300 outline-none focus:border-cyan-600"
          />
        )}
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {messages.length === 0 && (
          <p className="p-4 text-sm text-zinc-500">
            Ask or teach the knowledge base. Each turn runs as a fresh, persisted Hermes
            librarian session.
          </p>
        )}
        {messages.map((message, index) => (
          <div key={index} className={message.role === "user" ? "text-right" : ""}>
            <div
              className={`markdown inline-block max-w-[95%] rounded-xl px-3 py-2 text-left text-sm ${
                message.role === "user"
                  ? "bg-cyan-900/50"
                  : "border border-zinc-800 bg-zinc-900"
              }`}
            >
              <MarkdownRenderer>{message.content}</MarkdownRenderer>
            </div>
          </div>
        ))}
        {latestTools.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {latestTools.map((tool, index) => (
              <span
                key={`${tool.name}-${index}`}
                className="rounded border border-zinc-800 bg-zinc-900/60 px-2 py-1 font-mono text-xs text-zinc-400"
              >
                {tool.status === "complete" ? "✓" : tool.status === "error" ? "✗" : "…"}{" "}
                {tool.name}
              </span>
            ))}
          </div>
        )}
        {busy && <div className="animate-pulse text-xs text-zinc-500">Hermes is working…</div>}
        {error && <div className="text-xs text-red-400">{error}</div>}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="border-t border-zinc-800 p-3"
      >
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Ask or teach the knowledge base…"
          className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-cyan-600"
        />
      </form>
    </div>
  );
}
