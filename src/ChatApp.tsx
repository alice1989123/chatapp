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
  webEnabled,
  onToggleWeb,
}: {
  disabled?: boolean;
  onSend: (text: string) => Promise<void>;
  streamEnabled: boolean;
  onToggleStream: (v: boolean) => void;
  webEnabled: boolean;
  onToggleWeb: (v: boolean) => void;
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
        title="Allow backend web search (backend must support this flag)"
      >
        <input
          type="checkbox"
          checked={webEnabled}
          disabled={disabled}
          onChange={(e) => onToggleWeb(e.target.checked)}
          style={{ cursor: disabled ? "not-allowed" : "pointer" }}
        />
        Web
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
  const STREAM_API_BASE = import.meta.env.VITE_STREAM_API_BASE as string | undefined;

  const [threadId, setThreadId] = useState<string | null>(null);

  const [threads, setThreads] = useState<ThreadMeta[]>([]);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [threadsError, setThreadsError] = useState<string | null>(null);

  const [history, setHistory] = useState<BackendMsg[]>([]);
  const [hydrating, setHydrating] = useState(false);
  const [hydrateError, setHydrateError] = useState<string | null>(null);

  const [streamEnabled, setStreamEnabled] = useState(true);
  const [webEnabled, setWebEnabled] = useState(true);

  // copied toast
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  function copyToClipboard(text: string, key: string) {
    const s = String(text ?? "");
    if (!s) return;

    const fallback = () => {
      const ta = document.createElement("textarea");
      ta.value = s;
      ta.setAttribute("readonly", "true");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      ta.style.top = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    };

    (async () => {
      try {
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(s);
        else fallback();
        setCopiedKey(key);
        window.setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1200);
      } catch {
        try {
          fallback();
          setCopiedKey(key);
          window.setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1200);
        } catch {
          // ignore
        }
      }
    })();
  }

  // Always points to the currently visible thread.
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

  function abortInFlight() {
    try {
      inFlightAbortRef.current?.abort();
    } catch {}
    inFlightAbortRef.current = null;
  }

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
      abortInFlight();
      setThreadId(tid);
      await refreshThreads();
    }
  }

  async function hydrateThread(tid: string) {
    if (!API_BASE) return;

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
    return { clientMsgId };
  }

  function appendAssistantPlaceholder(initial = "Thinking…") {
    const assistantId = `m_${safeUUID()}`;
    setHistory((h) => [
      ...h,
      { id: assistantId, ts: Date.now(), role: "assistant", text: initial },
    ]);
    return assistantId;
  }

  function updateAssistantText(assistantId: string, text: string) {
    setHistory((h) => h.map((m) => (m.id === assistantId ? { ...m, text } : m)));
  }

  function replaceAssistantWithError(assistantId: string, message: string) {
    updateAssistantText(assistantId, `⚠️ ${message}`);
  }

  async function sendMessageNonStream(text: string, tid: string) {
    if (!API_BASE) throw new Error("Missing VITE_API_BASE");

    abortInFlight();
    const { clientMsgId } = appendOptimisticUser(text);
    const assistantId = appendAssistantPlaceholder("Thinking…");

    const controller = new AbortController();
    inFlightAbortRef.current = controller;

    try {
      const data = await fetchJson(`${API_BASE}/chat`, {
        method: "POST",
        signal: controller.signal,
        headers: { ...headersAccess, "Content-Type": "application/json" },
        body: JSON.stringify({ threadId: tid, text, clientMsgId, web: webEnabled }),
      });

      if (activeThreadRef.current !== tid) return;

      const assistantText = String(data?.text ?? "");
      updateAssistantText(assistantId, assistantText || "(empty response)");
      refreshThreads().catch(() => {});
    } catch (e: any) {
      if (isAbortError(e) || activeThreadRef.current !== tid) return;
      replaceAssistantWithError(assistantId, e?.message ?? String(e));
      throw e;
    } finally {
      if (inFlightAbortRef.current === controller) inFlightAbortRef.current = null;
    }
  }

  /**
   * Streaming: assumes the backend streams raw text chunks.
   * Adds:
   *  - first-byte timeout (8s)
   *  - no-progress timeout (25s)
   *  - clean fallback behavior
   */
  async function sendMessageStream(text: string, tid: string) {
    if (!STREAM_API_BASE) throw new Error("Missing VITE_STREAM_API_BASE");

    abortInFlight();
    const { clientMsgId } = appendOptimisticUser(text);
    const assistantId = appendAssistantPlaceholder("Thinking…");

    const controller = new AbortController();
    inFlightAbortRef.current = controller;

    // timers
    let firstByteTimer: number | null = null;
    let progressTimer: number | null = null;

    const clearTimers = () => {
      if (firstByteTimer) window.clearTimeout(firstByteTimer);
      if (progressTimer) window.clearTimeout(progressTimer);
      firstByteTimer = null;
      progressTimer = null;
    };

    const armProgressTimeout = () => {
      if (progressTimer) window.clearTimeout(progressTimer);
      progressTimer = window.setTimeout(() => {
        try {
          controller.abort();
        } catch {}
      }, 25_000);
    };

    try {
      const r = await fetch(`${STREAM_API_BASE}/chat`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          ...headersId, // stream authorizer expects ID token (your note)
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ threadId: tid, text, clientMsgId, web: webEnabled }),
      });

      if (!r.ok || !r.body) {
        const raw = await r.text().catch(() => "");
        throw new Error(`HTTP ${r.status}: ${raw || r.statusText}`);
      }

      const reader = r.body.getReader();
      const decoder = new TextDecoder();

      let acc = "";
      let gotAnyByte = false;

      // If nothing arrives soon, abort -> fallback
      firstByteTimer = window.setTimeout(() => {
        try {
          controller.abort();
        } catch {}
      }, 8_000);

      armProgressTimeout();

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        if (activeThreadRef.current !== tid) {
          try {
            await reader.cancel();
          } catch {}
          clearTimers();
          return;
        }

        if (value && value.length) {
          gotAnyByte = true;
          if (firstByteTimer) {
            window.clearTimeout(firstByteTimer);
            firstByteTimer = null;
          }
          armProgressTimeout();
        }

        const chunk = decoder.decode(value, { stream: true });
        acc += chunk;

        // show something even if backend sends whitespace/newlines
        updateAssistantText(assistantId, acc || "Thinking…");
      }

      clearTimers();

      if (activeThreadRef.current !== tid) return;

      // stream ended but sent nothing
      if (!gotAnyByte && !acc.trim()) {
        updateAssistantText(assistantId, "⚠️ stream ended with no content");
      }

      refreshThreads().catch(() => {});
    } catch (e: any) {
      clearTimers();
      if (isAbortError(e) || activeThreadRef.current !== tid) return;
      replaceAssistantWithError(assistantId, `streaming failed: ${e?.message ?? String(e)}`);
      throw e;
    } finally {
      clearTimers();
      if (inFlightAbortRef.current === controller) inFlightAbortRef.current = null;
    }
  }

  async function onSend(text: string) {
    if (!threadId) throw new Error("No thread selected");
    const tid = threadId;
    activeThreadRef.current = tid;

    if (streamEnabled && STREAM_API_BASE) {
      try {
        await sendMessageStream(text, tid);
        return;
      } catch (e: any) {
        if (activeThreadRef.current !== tid) return;
        setHistory((h) => [
          ...h,
          {
            id: `m_${safeUUID()}`,
            ts: Date.now(),
            role: "assistant",
            text: `⚠️ streaming failed, falling back to non-stream.\n${e?.message ?? String(e)}`,
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
                    justifyContent: m.role === "user" ? "flex-end" : "flex-start",
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
                          // ✅ FIX: Put copy button on <pre>, not in code() (prevents nested <pre>)
                          pre({ children }) {
                            // children usually: <code className=...>...</code>
                            const codeNode: any = Array.isArray(children)
                              ? children[0]
                              : children;

                            const raw =
                              typeof codeNode?.props?.children === "string"
                                ? codeNode.props.children
                                : Array.isArray(codeNode?.props?.children)
                                ? codeNode.props.children.join("")
                                : "";

                            const codeText = String(raw ?? "").replace(/\n$/, "");
                            const key = `${m.id}:pre:${codeText.length}`;

                            return (
                              <div style={{ position: "relative", margin: "8px 0" }}>
                                <button
                                  type="button"
                                  onClick={() => codeText && copyToClipboard(codeText, key)}
                                  style={{
                                    position: "absolute",
                                    top: 8,
                                    right: 8,
                                    padding: "6px 10px",
                                    borderRadius: 10,
                                    border: "1px solid #333",
                                    background: "rgba(17,17,17,0.9)",
                                    color: "white",
                                    fontSize: 12,
                                    cursor: codeText ? "pointer" : "not-allowed",
                                    opacity: codeText ? 1 : 0.6,
                                  }}
                                  title="Copy code"
                                  disabled={!codeText}
                                >
                                  {copiedKey === key ? "Copied ✓" : "Copy"}
                                </button>

                                <pre
                                  style={{
                                    background: "#0f0f0f",
                                    border: "1px solid #333",
                                    borderRadius: 12,
                                    padding: 12,
                                    paddingTop: 40,
                                    overflowX: "auto",
                                    margin: 0,
                                  }}
                                >
                                  {children}
                                </pre>
                              </div>
                            );
                          },

                          // Inline code styling only; block code stays inside <pre>
                          code({ className, children, ...props }) {
                            const isInline = !className; // heuristic: block code gets className like "language-ts"
                            if (!isInline) {
                              return (
                                <code className={className} {...props}>
                                  {children}
                                </code>
                              );
                            }

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
                          },

                          // ✅ Avoid <p> wrapping block-level things; use div for paragraphs
                          p({ children }) {
                            return (
                              <div style={{ margin: "6px 0", whiteSpace: "pre-wrap" }}>
                                {children}
                              </div>
                            );
                          },
                          li({ children }) {
                            return <li style={{ whiteSpace: "pre-wrap" }}>{children}</li>;
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
            webEnabled={webEnabled}
            onToggleWeb={setWebEnabled}
          />
        </div>
      </div>
    </div>
  );
}
