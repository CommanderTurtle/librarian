import express, { type Router } from "express";
import { runChat, type ChatMessage, type KnowledgeBase } from "@understory/core";

interface ChatBody {
  messages: ChatMessage[];
  model?: string;
}

/** Web chat endpoint backed by the same delegated Librarian path as MCP calls. */
export function chatRouter(kb: KnowledgeBase): Router {
  const router = express.Router();

  router.post("/chat", async (req, res) => {
    const { messages, model } = req.body as ChatBody;
    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: "messages must contain at least one turn" });
      return;
    }
    try {
      res.json(await runChat(kb, messages, { model }));
    } catch (error) {
      res.status(502).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return router;
}
