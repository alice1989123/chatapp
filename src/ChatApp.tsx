// src/ChatApp.tsx
import { useMemo, useState } from "react";
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  type ChatModelAdapter,
  type ThreadMessage,
} from "@assistant-ui/react";
import { Thread } from "@assistant-ui/react-ui";

// Extract the latest user text from assistant-ui thread messages
function getLastUserText(messages: readonly ThreadMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;

    const parts = (m.content ?? []) as any[];
    const textPart = parts.find(
      (p) => p?.type === "text" && typeof p?.text === "string"
    );
    if (textPart?.text) return String(textPart.text);
  }
  return "";
}

export default function ChatApp({ accessToken }: { accessToken: string }) {
  const API_BASE = import.meta.env.VITE_API_BASE as string | undefined;

  // NOTE: This persists only while the tab is alive.
  // Next step (no localStorage): load last thread via backend on mount.
  const [threadId, setThreadId] = useState<string | null>(null);

  const adapter: ChatModelAdapter = useMemo(
    () => ({
      async run({ messages, abortSignal }) {
        if (!API_BASE) {
          return {
            content: [
              {
                type: "text",
                text:
                  "Missing VITE_API_BASE.\nCreate .env.local:\n" +
                  "VITE_API_BASE=https://YOUR_API_ID.execute-api.us-east-1.amazonaws.com/prod",
              },
            ],
          };
        }

        const text = getLastUserText(messages).trim();
        if (!text) {
          return { content: [{ type: "text", text: "(no user text found to send)" }] };
        }

        // Browser-safe UUID (no Node crypto import needed)
        const clientMsgId =
          typeof globalThis.crypto?.randomUUID === "function"
            ? globalThis.crypto.randomUUID()
            : `c_${Date.now()}_${Math.random().toString(16).slice(2)}`;

        const resp = await fetch(`${API_BASE}/chat`, {
          method: "POST",
          signal: abortSignal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            threadId, // null => create a new thread
            text, // only latest user message
            clientMsgId, // idempotency key
          }),
        });

        const raw = await resp.text();
        let data: any = null;
        try {
          data = JSON.parse(raw);
        } catch {
          // non-json response; keep raw
        }

        if (!resp.ok) {
          return {
            content: [
              {
                type: "text",
                text: `Backend ${resp.status}:\n${raw}`,
              },
            ],
          };
        }

        const newThreadId = String(data?.threadId ?? "");
        if (newThreadId && newThreadId !== threadId) setThreadId(newThreadId);

        return {
          content: [{ type: "text", text: String(data?.text ?? "") }],
        };
      },
    }),
    [API_BASE, accessToken, threadId]
  );

  const runtime = useLocalRuntime(adapter);

  return (
    <div style={{ height: "100vh", width: "100vw" }}>
      <AssistantRuntimeProvider runtime={runtime}>
        <Thread />
      </AssistantRuntimeProvider>
    </div>
  );
}
