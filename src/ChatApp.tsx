// src/ChatApp.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";

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

function decodeJwtPayload(token: string): any | null {
  try {
    const p = token.split(".")[1];
    if (!p) return null;

    // base64url -> base64 + proper padding
    const base64 = p.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(
      base64.length + ((4 - (base64.length % 4)) % 4),
      "="
    );

    const json = atob(padded);
    return JSON.parse(json);
  } catch {
    return null;
  }
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
    const msg = data?.message ? String(data.message) : raw || r.statusText;
    throw new Error(`HTTP ${r.status}: ${msg}`);
  }
  return data;
}

function isAbortError(e: any) {
  return e?.name === "AbortError";
}

function Composer({
  disabled,
  onSend,
  streamEnabled,
  onToggleStream,
}: {
  disabled?: boolean;
  onSend: (text: string) => Promise<void>;
  streamEnabled: boolean;
  onToggleStream: (v: boolean) => void;
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
        alignItems: "center",
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

      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 12,
          opacity: disabled ? 0.5 : 0.9,
          userSelect: "none",
          cursor: disabled ? "not-allowed" : "pointer",
          border: "1px solid #333",
          borderRadius: 10,
          padding: "8px 10px",
          background: "#111",
        }}
        title="Use streaming endpoint"
      >
        <input
          type="checkbox"
          checked={streamEnabled}
          disabled={disabled}
          onChange={(e) => onToggleStream(e.target.checked)}
          style={{ cursor: disabled ? "not-allowed" : "pointer" }}
        />
        Stream
      </label>

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

export default function ChatApp({
  accessToken,
  idToken,
}: {
  accessToken: string;
  idToken: string;
}) {
  const API_BASE = import.meta.env.VITE_API_BASE as string | undefined;
  const STREAM_API_BASE = import.meta.env.VITE_STREAM_API_BASE as
    | string
    | undefined;

  const [threadId, setThreadId] = useState<string | null>(null);

  const [threads, setThreads] = useState<ThreadMeta[]>([]);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [threadsError, setThreadsError] = useState<string | null>(null);

  const [history, setHistory] = useState<BackendMsg[]>([]);
  const [hydrating, setHydrating] = useState(false);
  const [hydrateError, setHydrateError] = useState<string | null>(null);

  const [streamEnabled, setStreamEnabled] = useState(true);

  // Always points to the *currently visible* thread.
  const activeThreadRef = useRef<string | null>(null);

  // One in-flight request at a time (especially important for streaming).
  const inFlightAbortRef = useRef<AbortController | null>(null);

  // autoscroll
  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history, threadId]);

  const headersAccess = useMemo(
    () => ({ Authorization: `Bearer ${accessToken}` }),
    [accessToken]
  );

  const headersId = useMemo(
    () => ({ Authorization: `Bearer ${idToken}` }),
    [idToken]
  );

  useEffect(() => {
    // Debug sanity: access vs id token
    const a = decodeJwtPayload(accessToken);
    const i = decodeJwtPayload(idToken);
    console.log(
      "token_use(accessToken):",
      a?.token_use,
      "len",
      accessToken?.length
    );
    console.log("token_use(idToken):", i?.token_use, "len", idToken?.length);
  }, [accessToken, idToken]);

  function abortInFlight() {
    try {
      inFlightAbortRef.current?.abort();
    } catch {}
    inFlightAbortRef.current = null;
  }

  // Abort any in-flight stream if user switches threads or unmounts.
  useEffect(() => {
    return () => abortInFlight();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshThreads() {
    if (!API_BASE) return [];
    const data = (await fetchJson(`${API_BASE}/threads?limit=20`, {
      method: "GET",
      headers: headersAccess,
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
      headers: { ...headersAccess, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Untitled" }),
    });

    const tid = String(out?.threadId ?? "");
    if (tid) {
      // switching thread: abort any in-flight request first
      abortInFlight();
      setThreadId(tid);
      await refreshThreads();
    }
  }

  async function hydrateThread(tid: string) {
    if (!API_BASE) return;

    // switching thread: abort any in-flight request first
    abortInFlight();
    activeThreadRef.current = tid;

    try {
      setHydrating(true);
      setHydrateError(null);

      const thread = (await fetchJson(`${API_BASE}/threads/${tid}`, {
        method: "GET",
        headers: headersAccess,
      })) as ThreadGetResponse;

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

  function appendOptimisticUser(text: string) {
    const clientMsgId = safeUUID();
    const userMsg: BackendMsg = {
      id: `m_${clientMsgId}`,
      ts: Date.now(),
      role: "user",
      text,
      clientMsgId,
    };
    setHistory((h) => [...h, userMsg]);
    return { clientMsgId, userMsg };
  }

  function appendAssistantPlaceholder() {
    const assistantId = `m_${safeUUID()}`;
    setHistory((h) => [
      ...h,
      { id: assistantId, ts: Date.now(), role: "assistant", text: "" },
    ]);
    return assistantId;
  }

  function updateAssistantText(assistantId: string, text: string) {
    setHistory((h) =>
      h.map((m) => (m.id === assistantId ? { ...m, text } : m))
    );
  }

  function replaceAssistantWithError(assistantId: string, message: string) {
    setHistory((h) =>
      h.map((m) =>
        m.id === assistantId ? { ...m, text: `⚠️ ${message}` } : m
      )
    );
  }

  async function sendMessageNonStream(text: string, tid: string) {
    if (!API_BASE) throw new Error("Missing VITE_API_BASE");

    abortInFlight();
    const { clientMsgId } = appendOptimisticUser(text);
    const assistantId = appendAssistantPlaceholder();

    const controller = new AbortController();
    inFlightAbortRef.current = controller;

    try {
      const data = await fetchJson(`${API_BASE}/chat`, {
        method: "POST",
        signal: controller.signal,
        headers: { ...headersAccess, "Content-Type": "application/json" },
        body: JSON.stringify({ threadId: tid, text, clientMsgId }),
      });

      // only update if still on same thread
      if (activeThreadRef.current !== tid) return;

      const assistantText = String(data?.text ?? "");
      updateAssistantText(assistantId, assistantText);
      refreshThreads().catch(() => {});
    } catch (e: any) {
      if (isAbortError(e) || activeThreadRef.current !== tid) return;
      replaceAssistantWithError(assistantId, e?.message ?? String(e));
      throw e;
    } finally {
      if (inFlightAbortRef.current === controller) inFlightAbortRef.current = null;
    }
  }

  async function sendMessageStream(text: string, tid: string) {
    if (!STREAM_API_BASE) throw new Error("Missing VITE_STREAM_API_BASE");

    abortInFlight();
    const { clientMsgId } = appendOptimisticUser(text);
    const assistantId = appendAssistantPlaceholder();

    const controller = new AbortController();
    inFlightAbortRef.current = controller;

    try {
      const r = await fetch(`${STREAM_API_BASE}/chat`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          ...headersId, // IMPORTANT: your REST authorizer expects ID token
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ threadId: tid, text, clientMsgId }),
      });

      if (!r.ok || !r.body) {
        const raw = await r.text().catch(() => "");
        throw new Error(`HTTP ${r.status}: ${raw || r.statusText}`);
      }

      // Stream reader
      const reader = r.body.getReader();
      const decoder = new TextDecoder();

      // Optional: show a tiny heartbeat immediately so UI feels alive
      let acc = "Thinking...\n";

      // Write initial text quickly
      if (activeThreadRef.current === tid) updateAssistantText(assistantId, acc);

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        // If user switched threads mid-stream, stop reading to avoid wasted work
        if (activeThreadRef.current !== tid) {
          try {
            await reader.cancel();
          } catch {}
          return;
        }

        const chunk = decoder.decode(value, { stream: true });
        acc += chunk;

        // Update the placeholder message in-place
        updateAssistantText(assistantId, acc);
      }

      refreshThreads().catch(() => {});
    } catch (e: any) {
      if (isAbortError(e) || activeThreadRef.current !== tid) return;

      // Network errors during streaming are common; surface them nicely.
      replaceAssistantWithError(
        assistantId,
        `streaming failed: ${e?.message ?? String(e)}`
      );

      throw e;
    } finally {
      if (inFlightAbortRef.current === controller) inFlightAbortRef.current = null;
    }
  }

  async function onSend(text: string) {
    if (!threadId) throw new Error("No thread selected");

    // Capture tid at send time; and mark it as the active thread for this operation.
    const tid = threadId;
    activeThreadRef.current = tid;

    if (streamEnabled) {
      try {
        await sendMessageStream(text, tid);
        return;
      } catch (e: any) {
        // If streaming fails, do a clean non-stream retry (same thread, new request).
        if (activeThreadRef.current !== tid) return;
        setHistory((h) => [
          ...h,
          {
            id: `m_${safeUUID()}`,
            ts: Date.now(),
            role: "assistant",
            text: `⚠️ streaming failed, falling back to non-stream.\n${
              e?.message ?? String(e)
            }`,
          },
        ]);
      }
    }

    await sendMessageNonStream(text, tid);
  }

  // initial load: threads, pick newest
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
          // switching thread: abort any in-flight request first
          abortInFlight();
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
            onClick={() => {
              abortInFlight();
              setThreadId(t.threadId);
            }}
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
              Missing VITE_API_BASE (threads/history API).
            </div>
          )}

          {streamEnabled && !STREAM_API_BASE && (
            <div style={{ color: "#ff7b7b", fontSize: 12 }}>
              Streaming is ON but VITE_STREAM_API_BASE is missing.
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
                      lineHeight: 1.35,
                      whiteSpace: "normal",
                      overflowWrap: "anywhere",
                    }}
                  >
                    {m.role === "assistant" ? (
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        rehypePlugins={[rehypeHighlight]}
                        components={{
                          code({ inline, className, children, ...props }) {
                            if (inline) {
                              return (
                                <code
                                  style={{
                                    background: "#111",
                                    border: "1px solid #333",
                                    padding: "2px 6px",
                                    borderRadius: 8,
                                    fontFamily:
                                      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                                    fontSize: 13,
                                  }}
                                  {...props}
                                >
                                  {children}
                                </code>
                              );
                            }
                            return (
                              <pre
                                style={{
                                  background: "#0f0f0f",
                                  border: "1px solid #333",
                                  borderRadius: 12,
                                  padding: 12,
                                  overflowX: "auto",
                                  marginTop: 8,
                                  marginBottom: 8,
                                }}
                              >
                                <code className={className} {...props}>
                                  {children}
                                </code>
                              </pre>
                            );
                          },
                          p({ children }) {
                            return (
                              <p style={{ margin: "6px 0", whiteSpace: "pre-wrap" }}>
                                {children}
                              </p>
                            );
                          },
                          li({ children }) {
                            return (
                              <li style={{ whiteSpace: "pre-wrap" }}>
                                {children}
                              </li>
                            );
                          },
                        }}
                      >
                        {m.text}
                      </ReactMarkdown>
                    ) : (
                      <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>
                    )}
                  </div>
                </div>
              ))
          )}
          <div ref={bottomRef} />
        </div>

        {/* Composer */}
        <div style={{ borderTop: "1px solid #222" }}>
          <Composer
            disabled={hydrating || !threadId}
            onSend={onSend}
            streamEnabled={streamEnabled}
            onToggleStream={setStreamEnabled}
          />
        </div>
      </div>
    </div>
  );
}
