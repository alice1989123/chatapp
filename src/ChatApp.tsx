// src/ChatApp.tsx
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import React from "react";

/* =========================
   Types
========================= */
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

/* =========================
   Small utilities
========================= */
function safeUUID(): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `c_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function isAbortError(e: any) {
  return e?.name === "AbortError";
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

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

function normalizeText(s: any) {
  return String(s ?? "");
}

function looksLikeBrowsingPlaceholder(s: string) {
  const t = s.trim().toLowerCase();
  return t === "[browsing...]" || t.startsWith("[browsing");
}

/* =========================
   Clipboard hook
========================= */
function extractTextFromReact(node: any): string {
  if (node == null || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);

  if (Array.isArray(node)) return node.map(extractTextFromReact).join("");

  if (React.isValidElement(node)) {
    return extractTextFromReact((node as any).props?.children);
  }

  try {
    return String(node);
  } catch {
    return "";
  }
}

function useClipboardToast(timeoutMs = 1200) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const copyToClipboard = useCallback(
    (text: string, key: string) => {
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
          window.setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), timeoutMs);
        } catch {
          try {
            fallback();
            setCopiedKey(key);
            window.setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), timeoutMs);
          } catch {
            // ignore
          }
        }
      })();
    },
    [timeoutMs]
  );

  return { copiedKey, copyToClipboard };
}

/* =========================
   API client wrapper
========================= */
function makeApi({
  apiBase,
  streamApiBase,
  headersAccess,
  headersId,
}: {
  apiBase?: string;
  streamApiBase?: string;
  headersAccess: Record<string, string>;
  headersId: Record<string, string>;
}) {
  return {
    async listThreads(limit = 20): Promise<ThreadsListResponse> {
      if (!apiBase) throw new Error("Missing VITE_API_BASE");
      return fetchJson(`${apiBase}/threads?limit=${limit}`, {
        method: "GET",
        headers: headersAccess,
      });
    },

    async createThread(title = "Untitled"): Promise<{ threadId: string }> {
      if (!apiBase) throw new Error("Missing VITE_API_BASE");
      return fetchJson(`${apiBase}/threads`, {
        method: "POST",
        headers: { ...headersAccess, "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
    },

    async getThread(tid: string): Promise<ThreadGetResponse> {
      if (!apiBase) throw new Error("Missing VITE_API_BASE");
      return fetchJson(`${apiBase}/threads/${tid}`, {
        method: "GET",
        headers: headersAccess,
      });
    },

    async chatStreamFetch(args: {
      threadId: string;
      text: string;
      clientMsgId: string;
      webEnabled: boolean;
      signal: AbortSignal;
    }): Promise<Response> {
      if (!streamApiBase) throw new Error("Missing VITE_STREAM_API_BASE");
      return fetch(`${streamApiBase}/chat`, {
        method: "POST",
        signal: args.signal,
        headers: {
          ...headersId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          threadId: args.threadId,
          text: args.text,
          clientMsgId: args.clientMsgId,
          capabilities: {
            web_search: args.webEnabled,
          },
        }),
      });
    },
  };
}

/* =========================
   Streaming timer helper
========================= */
function createStreamTimers() {
  let firstByteTimer: number | null = null;
  let progressTimer: number | null = null;

  const clear = () => {
    if (firstByteTimer) window.clearTimeout(firstByteTimer);
    if (progressTimer) window.clearTimeout(progressTimer);
    firstByteTimer = null;
    progressTimer = null;
  };

  const armFirstByte = (ms: number, onTimeout: () => void) => {
    if (firstByteTimer) window.clearTimeout(firstByteTimer);
    firstByteTimer = window.setTimeout(onTimeout, ms);
  };

  const disarmFirstByte = () => {
    if (firstByteTimer) window.clearTimeout(firstByteTimer);
    firstByteTimer = null;
  };

  const armProgress = (ms: number, onTimeout: () => void) => {
    if (progressTimer) window.clearTimeout(progressTimer);
    progressTimer = window.setTimeout(onTimeout, ms);
  };

  return { clear, armFirstByte, disarmFirstByte, armProgress };
}

/* =========================
   Stream decoder:
   - Supports AWS Lambda response streaming meta+8zero delimiter
   - Also supports plain-text streaming (no delimiter)
========================= */
function createHybridStreamDecoder() {
  const DELIM = new Uint8Array(8); // 8 zero bytes
  const td = new TextDecoder();

  let startedBody = false;
  let decidedPlainText = false;
  let buf = new Uint8Array(0);

  function concat(a: Uint8Array, b: Uint8Array) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  function indexOfSubarray(hay: Uint8Array, needle: Uint8Array) {
    outer: for (let i = 0; i <= hay.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (hay[i + j] !== needle[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  const MAX_META_BYTES = 32 * 1024;

  function firstNonWhitespaceByte(u8: Uint8Array) {
    for (let i = 0; i < u8.length; i++) {
      const c = u8[i];
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) continue;
      return c;
    }
    return null;
  }

  return {
    push(bytes?: Uint8Array | null): { text: string; meta?: any } {
      if (!bytes || bytes.length === 0) return { text: "" };

      buf = concat(buf, bytes);

      if (!startedBody && !decidedPlainText) {
        const b = firstNonWhitespaceByte(buf);
        if (b !== null && b !== 0x7b /* "{" */) {
          decidedPlainText = true;
          startedBody = true;
        }
      }

      if (!startedBody) {
        if (buf.length > MAX_META_BYTES) {
          startedBody = true;
          const text = td.decode(buf, { stream: true });
          buf = new Uint8Array(0);
          return { text };
        }

        const at = indexOfSubarray(buf, DELIM);
        if (at === -1) return { text: "" };

        let meta: any = undefined;
        try {
          const metaStr = td.decode(buf.slice(0, at));
          meta = JSON.parse(metaStr);
        } catch {
          // ignore
        }

        const bodyBytes = buf.slice(at + DELIM.length);
        buf = new Uint8Array(0);
        startedBody = true;

        const text = bodyBytes.length ? td.decode(bodyBytes, { stream: true }) : "";
        return { text, meta };
      }

      const text = td.decode(buf, { stream: true });
      buf = new Uint8Array(0);
      return { text };
    },
  };
}

/* =========================
   Markdown renderer component
========================= */
function AssistantMarkdown({
  text,
  msgId,
  copiedKey,
  copyToClipboard,
}: {
  text: string;
  msgId: string;
  copiedKey: string | null;
  copyToClipboard: (text: string, key: string) => void;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        pre({ children }) {
          const codeNode: any = Array.isArray(children) ? children[0] : children;
          const rawChildren = codeNode?.props?.children;

          const codeText = extractTextFromReact(rawChildren).replace(/\n$/, "");
          const key = `${msgId}:pre:${codeText.length}`;

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

        code({ className, children, ...props }) {
          const isInline = !className;
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

        p({ children }) {
          return <div style={{ margin: "6px 0", whiteSpace: "pre-wrap" }}>{children}</div>;
        },
        li({ children }) {
          return <li style={{ whiteSpace: "pre-wrap" }}>{children}</li>;
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

/* =========================
   Composer component
========================= */
function Composer({
  disabled,
  onSend,
  webEnabled,
  onToggleWeb,
  onStop,
  canStop,
}: {
  disabled?: boolean;
  onSend: (text: string) => Promise<void>;
  webEnabled: boolean;
  onToggleWeb: (v: boolean) => void;
  onStop: () => void;
  canStop: boolean;
})  {
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
      <button
      type="button"
      onClick={onStop}
      disabled={!canStop}
      style={{
        padding: "10px 14px",
        borderRadius: 10,
        border: "1px solid #333",
        background: !canStop ? "#222" : "#111",
        color: "white",
        cursor: !canStop ? "not-allowed" : "pointer",
      }}
      title="Stop generating"
    >
      Stop
    </button>
    </form>
  );
}

/* =========================
   Main hook: chat runtime
========================= */
function useChatRuntime({
  apiBase,
  streamApiBase,
  accessToken,
  idToken,
  webEnabled,
}: {
  apiBase?: string;
  streamApiBase?: string;
  accessToken: string;
  idToken: string;
  webEnabled: boolean;
}) {
  const headersAccess = useMemo(
    () => ({ Authorization: `Bearer ${accessToken}` }),
    [accessToken]
  );
  const headersId = useMemo(() => ({ Authorization: `Bearer ${idToken}` }), [idToken]);

  const api = useMemo(
    () => makeApi({ apiBase, streamApiBase, headersAccess, headersId }),
    [apiBase, streamApiBase, headersAccess, headersId]
  );

  const [threadId, setThreadId] = useState<string | null>(null);

  const [threads, setThreads] = useState<ThreadMeta[]>([]);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [threadsError, setThreadsError] = useState<string | null>(null);

  const [history, setHistory] = useState<BackendMsg[]>([]);
  const [hydrating, setHydrating] = useState(false);
  const [hydrateError, setHydrateError] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const activeThreadRef = useRef<string | null>(null);
  const inFlightAbortRef = useRef<AbortController | null>(null);

  const abortInFlight = useCallback(() => {
    const ctrl = inFlightAbortRef.current;
    if (!ctrl) return;

    // update UI immediately no matter what
    setHistory((h) => {
      const hh = [...h];
      for (let i = hh.length - 1; i >= 0; i--) {
        if (hh[i].role === "assistant") {
          hh[i] = { ...hh[i], text: "⏹️ Stopped." };
          break;
        }
      }
      return hh;
    });

    try { ctrl.abort(); } catch {}

    inFlightAbortRef.current = null;
    setIsStreaming(false);
  }, []);

  useEffect(() => {
    return () => abortInFlight();
  }, [abortInFlight ]);

  const refreshThreads = useCallback(async () => {
    if (!apiBase) return [];
    const data = await api.listThreads(20);
    const items = Array.isArray(data?.items) ? data.items : [];
    setThreads(items);
    return items;
  }, [api, apiBase]);

  const createNewThread = useCallback(async () => {
    if (!apiBase) return;
    setThreadsError(null);

    const out = await api.createThread("Untitled");
    const tid = String(out?.threadId ?? "");
    if (tid) {
      abortInFlight();
      setThreadId(tid);
      activeThreadRef.current = tid;
      await refreshThreads();
    }
  }, [api, apiBase, abortInFlight, refreshThreads]);

  const hydrateThread = useCallback(
    async (tid: string) => {
      if (!apiBase) return;

      abortInFlight();
      activeThreadRef.current = tid;

      try {
        setHydrating(true);
        setHydrateError(null);

        const thread = await api.getThread(tid);
        if (activeThreadRef.current !== tid) return;

        setHistory(Array.isArray(thread?.messages) ? thread.messages : []);
      } catch (e: any) {
        if (activeThreadRef.current !== tid) return;
        setHydrateError(e?.message ?? String(e));
        setHistory([]);
      } finally {
        if (activeThreadRef.current === tid) setHydrating(false);
      }
    },
    [api, apiBase, abortInFlight]
  );

  const appendOptimisticUser = useCallback((text: string) => {
    const clientMsgId = safeUUID();
    const userMsg: BackendMsg = {
      id: `m_${clientMsgId}`,
      ts: Date.now(),
      role: "user",
      text,
      clientMsgId,
    };
    setHistory((h) => [...h, userMsg]);
    return { clientMsgId, userTs: userMsg.ts };
  }, []);

  const appendAssistantPlaceholder = useCallback((initial = "Thinking…") => {
    const assistantId = `m_${safeUUID()}`;
    setHistory((h) => [
      ...h,
      { id: assistantId, ts: Date.now(), role: "assistant", text: initial },
    ]);
    return assistantId;
  }, []);

  const updateAssistantText = useCallback((assistantId: string, text: string) => {
    setHistory((h) => h.map((m) => (m.id === assistantId ? { ...m, text } : m)));
  }, []);

  const replaceAssistantWithError = useCallback(
    (assistantId: string, message: string) => {
      updateAssistantText(assistantId, `⚠️ ${message}`);
    },
    [updateAssistantText]
  );

  // Poll thread until we see a newer assistant message that isn't the placeholder
  const pollForFinalAssistant = useCallback(
    async (tid: string, userTs: number, assistantId: string, signal: AbortSignal) => {
      const deadline = Date.now() + 60_000; // 60s max
      let lastSeen = "";

      while (Date.now() < deadline) {
        if (signal.aborted) return;

        try {
          const thread = await api.getThread(tid);
          if (signal.aborted) return;
          if (activeThreadRef.current !== tid) return;

          const msgs = Array.isArray(thread?.messages) ? thread.messages : [];
          const candidates = msgs
            .filter((m) => m.role === "assistant" && typeof m.ts === "number" && m.ts >= userTs)
            .sort((a, b) => a.ts - b.ts);

          const latest = candidates[candidates.length - 1];
          const text = normalizeText(latest?.text);

          if (
            text &&
            !looksLikeBrowsingPlaceholder(text) &&
            text !== "Thinking…" &&
            text !== lastSeen
          ) {
            updateAssistantText(assistantId, text);
            refreshThreads().catch(() => {});
            return;
          }

          if (text) lastSeen = text;
        } catch {
          // ignore transient
        }

        await sleep(1200);
      }
    },
    [api, refreshThreads, updateAssistantText]
  );

  const sendMessageStream = useCallback(
        async (text: string, tid: string) => {
        abortInFlight();

        const { clientMsgId, userTs } = appendOptimisticUser(text);
        const assistantId = appendAssistantPlaceholder("Thinking…");

        const controller = new AbortController();
        inFlightAbortRef.current = controller;
        setIsStreaming(true); // <-- move here (after ref is set)

        const timers = createStreamTimers();
        const abort = () => {
          try { controller.abort(); } catch {}
        };

        try {
          const r = await api.chatStreamFetch({
            threadId: tid,
            text,
            clientMsgId,
            webEnabled,
            signal: controller.signal,
          });

        if (!r.ok || !r.body) {
          const raw = await r.text().catch(() => "");
          throw new Error(`HTTP ${r.status}: ${raw || r.statusText}`);
        }

        const reader = r.body.getReader();
        const decoder = createHybridStreamDecoder();

        let acc = "";
        let pending = "";
        let flushTimer: number | null = null;

        let gotAnyByte = false;
        let sawAnyText = false;

        const flush = () => {
          if (!pending) return;
          acc += pending;
          pending = "";
          updateAssistantText(assistantId, acc || "Thinking…");
        };

        const scheduleFlush = () => {
          if (flushTimer != null) return;
          flushTimer = window.setTimeout(() => {
            flushTimer = null;
            flush();
          }, 50); // tune: 30–80ms
        };

        timers.armFirstByte(30_000, abort);

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          if (activeThreadRef.current !== tid) {
            try {
              await reader.cancel();
            } catch {}
            timers.clear();
            return;
          }

          if (value && value.length) {
            if (!gotAnyByte) {
              gotAnyByte = true;
              timers.disarmFirstByte();
              timers.armProgress(120_000, abort); // give room for long generations
            } else {
              timers.armProgress(120_000, abort);
            }
          }

          const { text: chunkText } = decoder.push(value);

          if (chunkText) {
            sawAnyText = true;
            pending += chunkText;

            if (pending.length >= 2048) flush();
            else scheduleFlush();
          }
        }

        if (flushTimer != null) window.clearTimeout(flushTimer);
        flush();
        timers.clear();

        if (activeThreadRef.current !== tid) return;

        const finalText = acc.trim();

        if (!gotAnyByte) {
          updateAssistantText(assistantId, "⚠️ stream ended with no content");
          return;
        }

        if (!sawAnyText) {
          await pollForFinalAssistant(tid, userTs, assistantId, controller.signal);
          return;
        }

        if (!finalText || looksLikeBrowsingPlaceholder(finalText)) {
          if (finalText) updateAssistantText(assistantId, finalText);
          await pollForFinalAssistant(tid, userTs, assistantId, controller.signal);
          return;
        }

        refreshThreads().catch(() => {});
      } catch (e: any) {
        timers.clear();
        if (isAbortError(e) || activeThreadRef.current !== tid) return;
        replaceAssistantWithError(assistantId, `streaming failed: ${e?.message ?? String(e)}`);
        throw e;
      } finally {
        timers.clear();
        setIsStreaming(false);
        if (inFlightAbortRef.current === controller) inFlightAbortRef.current = null;
      }
    },
    [
      api,
      webEnabled,
      abortInFlight,
      appendOptimisticUser,
      appendAssistantPlaceholder,
      updateAssistantText,
      replaceAssistantWithError,
      refreshThreads,
      pollForFinalAssistant,
    ]
  );

  const onSend = useCallback(
    async (text: string) => {
      if (!threadId) throw new Error("No thread selected");
      const tid = threadId;
      activeThreadRef.current = tid;

      if (!streamApiBase) {
        setHistory((h) => [
          ...h,
          {
            id: `m_${safeUUID()}`,
            ts: Date.now(),
            role: "assistant",
            text: "⚠️ Streaming endpoint is not configured (missing VITE_STREAM_API_BASE).",
          },
        ]);
        return;
      }

      await sendMessageStream(text, tid);
    },
    [threadId, streamApiBase, sendMessageStream]
  );

  // initial load
  useEffect(() => {
    if (!apiBase || !accessToken) return;
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
          activeThreadRef.current = initial;
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
  }, [apiBase, accessToken]);

  // hydrate on thread change
  useEffect(() => {
    if (!threadId) return;
    hydrateThread(threadId);
  }, [threadId, hydrateThread]);
  const canStop = isStreaming || !!inFlightAbortRef.current;
  return {
    threadId,
    setThreadId,
    threads,
    loadingThreads,
    threadsError,
    refreshThreads,
    createNewThread,
    history,
    hydrating,
    hydrateError,
    abortInFlight,
    onSend,
    isStreaming,
    canStop,
  };
}

/* =========================
   Main component
========================= */
export default function ChatApp({
  accessToken,
  idToken,
}: {
  accessToken: string;
  idToken: string;
}) {
  const API_BASE = import.meta.env.VITE_API_BASE as string | undefined;
  const STREAM_API_BASE = import.meta.env.VITE_STREAM_API_BASE as string | undefined;

  const [webEnabled, setWebEnabled] = useState(false);

  const { copiedKey, copyToClipboard } = useClipboardToast(1200);

  const {
    threadId,
    setThreadId,
    threads,
    loadingThreads,
    threadsError,
    refreshThreads,
    createNewThread,
    history,
    hydrating,
    hydrateError,
    abortInFlight,
    onSend,
    canStop,
  } = useChatRuntime({
    apiBase: API_BASE,
    streamApiBase: STREAM_API_BASE,
    accessToken,
    idToken,
    webEnabled,
  });

  // autoscroll (use auto during streaming updates to avoid jank)
  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "auto" });
  }, [history, threadId]);

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
      <div style={{ width: 320, borderRight: "1px solid #222", padding: 12, overflow: "auto" }}>
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
          <div style={{ color: "#ff7b7b", whiteSpace: "pre-wrap" }}>{threadsError}</div>
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
            <span style={{ fontFamily: "monospace" }}>{threadId ?? "(none yet)"}</span>
            {hydrating && <span style={{ marginLeft: 12 }}>(loading history…)</span>}
          </div>

          {hydrateError && <div style={{ color: "#ff7b7b", fontSize: 12 }}>{hydrateError}</div>}

          {!API_BASE && (
            <div style={{ color: "#ff7b7b", fontSize: 12 }}>
              Missing VITE_API_BASE (threads/history API).
            </div>
          )}

          {!STREAM_API_BASE && (
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
                      <AssistantMarkdown
                        text={m.text}
                        msgId={m.id}
                        copiedKey={copiedKey}
                        copyToClipboard={copyToClipboard}
                      />
                    ) : (
                      <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>
                    )}
                  </div>
                </div>
              ))
          )}
          <div ref={bottomRef} />
        </div>

        <div style={{ borderTop: "1px solid #222" }}>
          <Composer
            disabled={hydrating || !threadId}
            onSend={onSend}
            webEnabled={webEnabled}
            onToggleWeb={setWebEnabled}
            onStop={abortInFlight}
            canStop={canStop}
          />
        </div>
      </div>
    </div>
  );
}