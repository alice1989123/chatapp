// src/ChatApp.tsx
import { useEffect, useMemo, useRef, useState } from "react";

type ThreadMeta = {
  threadId: string;
  title: string;
  updatedAt: number;
  createdAt: number;
};

type ThreadsListResponse = {
  items: ThreadMeta[];
  nextToken: string | null;
};

type BackendMsg = {
  id: string;
  ts: number;
  role: "user" | "assistant" | "system";
  text: string;
  clientMsgId?: string;
};

type ThreadGetResponse = {
  threadId: string;
  title: string;
  updatedAt: number;
  messages: BackendMsg[];
};

function safeUUID(): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `c_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function fetchJson(url: string, init: RequestInit): Promise<any> {
  const r = await fetch(url, init);
  const raw = await r.text();
  let data: any = null;
  try {
    data = JSON.parse(raw);
  } catch {
    // ignore non-json
  }
  if (!r.ok) {
    const msg = data?.message ? String(data.message) : raw;
    throw new Error(`HTTP ${r.status}: ${msg}`);
  }
  return data;
}

function Composer({
  disabled,
  onSend,
}: {
  disabled?: boolean;
  onSend: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState("");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const t = text.trim();
        if (!t || disabled) return;
        setText("");
        onSend(t);
      }}
      style={{
        display: "flex",
        gap: 8,
        padding: 12,
        background: "#0b0b0b",
      }}
    >
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={disabled}
        placeholder={disabled ? "Loading…" : "Write a message…"}
        style={{
          flex: 1,
          padding: "10px 12px",
          borderRadius: 10,
          border: "1px solid #333",
          background: "#0f0f0f",
          color: "white",
          outline: "none",
        }}
      />
      <button
        type="submit"
        disabled={disabled}
        style={{
          padding: "10px 14px",
          borderRadius: 10,
          border: "1px solid #333",
          background: disabled ? "#222" : "#111",
          color: "white",
          cursor: disabled ? "not-allowed" : "pointer",
        }}
      >
        Send
      </button>
    </form>
  );
}

export default function ChatApp({ accessToken }: { accessToken: string }) {
  const API_BASE = import.meta.env.VITE_API_BASE as string | undefined;

  const [threadId, setThreadId] = useState<string | null>(null);

  // thread list
  const [threads, setThreads] = useState<ThreadMeta[]>([]);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [threadsError, setThreadsError] = useState<string | null>(null);

  // active thread data
  const [history, setHistory] = useState<BackendMsg[]>([]);
  const [hydrating, setHydrating] = useState(false);
  const [hydrateError, setHydrateError] = useState<string | null>(null);

  // avoid races when switching threads quickly
  const activeThreadRef = useRef<string | null>(null);

  // autoscroll
  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history, threadId]);

  const headersAuth = useMemo(
    () => ({
      Authorization: `Bearer ${accessToken}`,
    }),
    [accessToken]
  );

  async function refreshThreads() {
    if (!API_BASE) return [];
    const data = (await fetchJson(`${API_BASE}/threads?limit=20`, {
      method: "GET",
      headers: headersAuth,
    })) as ThreadsListResponse;

    const items = Array.isArray(data?.items) ? data.items : [];
    setThreads(items);
    return items;
  }

  async function createNewThread() {
    if (!API_BASE) return;
    setThreadsError(null);

    const out = await fetchJson(`${API_BASE}/threads`, {
      method: "POST",
      headers: {
        ...headersAuth,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: "Untitled" }),
    });

    const tid = String(out?.threadId ?? "");
    if (tid) {
      setThreadId(tid);
      await refreshThreads();
    }
  }

  async function hydrateThread(tid: string) {
    if (!API_BASE) return;

    activeThreadRef.current = tid;

    try {
      setHydrating(true);
      setHydrateError(null);

      const thread = (await fetchJson(`${API_BASE}/threads/${tid}`, {
        method: "GET",
        headers: headersAuth,
      })) as ThreadGetResponse;

      // if user switched threads mid-flight, ignore old response
      if (activeThreadRef.current !== tid) return;

      setHistory(Array.isArray(thread?.messages) ? thread.messages : []);
    } catch (e: any) {
      if (activeThreadRef.current !== tid) return;
      setHydrateError(e?.message ?? String(e));
      setHistory([]);
    } finally {
      if (activeThreadRef.current === tid) setHydrating(false);
    }
  }

  async function sendMessage(text: string) {
    if (!API_BASE) throw new Error("Missing VITE_API_BASE");
    if (!threadId) throw new Error("No thread selected");

    const clientMsgId = safeUUID();
    const now = Date.now();

    // optimistic add user message
    const optimisticUser: BackendMsg = {
      id: `m_${clientMsgId}`,
      ts: now,
      role: "user",
      text,
      clientMsgId,
    };
    setHistory((h) => [...h, optimisticUser]);

    const data = await fetchJson(`${API_BASE}/chat`, {
      method: "POST",
      headers: {
        ...headersAuth,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ threadId, text, clientMsgId }),
    });

    // if the user switched threads while waiting, don't inject reply into wrong thread
    if (activeThreadRef.current && activeThreadRef.current !== threadId) return;

    const assistantText = String(data?.text ?? "");
    const assistantMsg: BackendMsg = {
      id: `m_${safeUUID()}`,
      ts: Date.now(),
      role: "assistant",
      text: assistantText,
    };
    setHistory((h) => [...h, assistantMsg]);

    // update sidebar ordering
    refreshThreads().catch(() => {});
  }

  // initial load: get threads, pick newest
  useEffect(() => {
    if (!API_BASE || !accessToken) return;
    let alive = true;

    (async () => {
      try {
        setLoadingThreads(true);
        setThreadsError(null);

        const items = await refreshThreads();
        if (!alive) return;

        const initial = items?.[0]?.threadId ?? null;
        if (initial && !threadId) {
          setThreadId(initial);
        }
      } catch (e: any) {
        if (!alive) return;
        setThreadsError(e?.message ?? String(e));
      } finally {
        if (alive) setLoadingThreads(false);
      }
    })();

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [API_BASE, accessToken]);

  // hydrate whenever thread changes
  useEffect(() => {
    if (!threadId) return;
    hydrateThread(threadId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        width: "100vw",
        background: "#0b0b0b",
        color: "white",
        fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto",
      }}
    >
      {/* Sidebar */}
      <div
        style={{
          width: 320,
          borderRight: "1px solid #222",
          padding: 12,
          overflow: "auto",
        }}
      >
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ fontWeight: 700 }}>Threads</div>
          <button
            onClick={createNewThread}
            style={{
              marginLeft: "auto",
              padding: "6px 10px",
              borderRadius: 10,
              border: "1px solid #333",
              background: "#111",
              color: "white",
              cursor: "pointer",
            }}
          >
            + New
          </button>
        </div>

        <div style={{ marginTop: 10, marginBottom: 10 }}>
          <button
            onClick={() => refreshThreads()}
            disabled={loadingThreads}
            style={{
              padding: "6px 10px",
              borderRadius: 10,
              border: "1px solid #333",
              background: loadingThreads ? "#222" : "#111",
              color: "white",
              cursor: loadingThreads ? "not-allowed" : "pointer",
              width: "100%",
            }}
          >
            {loadingThreads ? "Loading…" : "Refresh"}
          </button>
        </div>

        {threadsError && (
          <div style={{ color: "#ff7b7b", whiteSpace: "pre-wrap" }}>
            {threadsError}
          </div>
        )}

        {threads.map((t) => (
          <button
            key={t.threadId}
            onClick={() => setThreadId(t.threadId)}
            style={{
              width: "100%",
              textAlign: "left",
              padding: 10,
              marginBottom: 8,
              border: "1px solid #333",
              borderRadius: 10,
              background: t.threadId === threadId ? "#111" : "transparent",
              cursor: "pointer",
              color: "white",
            }}
          >
            <div style={{ fontWeight: 600 }}>{t.title || "Untitled"}</div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>
              {new Date(t.updatedAt).toLocaleString()}
            </div>
          </button>
        ))}
      </div>

      {/* Chat */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        <div style={{ padding: 10, borderBottom: "1px solid #222" }}>
          <div style={{ fontSize: 12, opacity: 0.8 }}>
            Active thread:{" "}
            <span style={{ fontFamily: "monospace" }}>
              {threadId ?? "(none yet)"}
            </span>
            {hydrating && (
              <span style={{ marginLeft: 12 }}>(loading history…)</span>
            )}
          </div>
          {hydrateError && (
            <div style={{ color: "#ff7b7b", fontSize: 12 }}>
              {hydrateError}
            </div>
          )}
          {!API_BASE && (
            <div style={{ color: "#ff7b7b", fontSize: 12 }}>
              Missing VITE_API_BASE (set it to your API Gateway prod base URL).
            </div>
          )}
        </div>

        {/* History */}
        <div style={{ flex: 1, overflow: "auto", padding: 12 }}>
          {hydrating ? (
            <div style={{ opacity: 0.8 }}>Loading thread…</div>
          ) : history.length === 0 ? (
            <div style={{ opacity: 0.7 }}>No messages yet.</div>
          ) : (
            history
              .filter((m) => m.role === "user" || m.role === "assistant")
              .map((m) => (
                <div
                  key={m.id}
                  style={{
                    marginBottom: 10,
                    display: "flex",
                    justifyContent:
                      m.role === "user" ? "flex-end" : "flex-start",
                  }}
                >
                  <div
                    style={{
                      maxWidth: 720,
                      padding: "10px 12px",
                      borderRadius: 12,
                      border: "1px solid #333",
                      background: m.role === "user" ? "#111" : "transparent",
                      whiteSpace: "pre-wrap",
                      lineHeight: 1.35,
                    }}
                  >
                    {m.text}
                  </div>
                </div>
              ))
          )}
          <div ref={bottomRef} />
        </div>

        {/* Composer */}
        <div style={{ borderTop: "1px solid #222" }}>
          <Composer disabled={hydrating || !threadId} onSend={sendMessage} />
        </div>
      </div>
    </div>
  );
}
