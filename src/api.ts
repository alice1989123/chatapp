export type Msg = {
  id: string;
  ts: number;
  role: "user" | "assistant";
  text: string;
  clientMsgId?: string;
};

export type ThreadMeta = {
  threadId: string;
  title: string;
  updatedAt: number;
  createdAt: number;
};

export type ThreadsList = {
  items: ThreadMeta[];
  nextToken: string | null;
};

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

export async function apiListThreads(apiBase: string, token: string, limit = 20, nextToken?: string | null) {
  const url = new URL(`${apiBase}/threads`);
  url.searchParams.set("limit", String(limit));
  if (nextToken) url.searchParams.set("nextToken", nextToken);

  const r = await fetch(url.toString(), { headers: authHeaders(token) });
  const t = await r.text();
  if (!r.ok) throw new Error(`ListThreads ${r.status}: ${t}`);
  return JSON.parse(t) as ThreadsList;
}

export async function apiCreateThread(apiBase: string, token: string, title?: string) {
  const r = await fetch(`${apiBase}/threads`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ title: title ?? "Untitled" }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`CreateThread ${r.status}: ${t}`);
  return JSON.parse(t) as { threadId: string };
}

export async function apiGetThread(apiBase: string, token: string, threadId: string) {
  const r = await fetch(`${apiBase}/threads/${encodeURIComponent(threadId)}`, {
    headers: authHeaders(token),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`GetThread ${r.status}: ${t}`);
  return JSON.parse(t) as { threadId: string; title: string; updatedAt: number; messages: Msg[] };
}

export async function apiChat(apiBase: string, token: string, payload: { threadId: string; text: string; clientMsgId: string }) {
  const r = await fetch(`${apiBase}/chat`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`Chat ${r.status}: ${t}`);
  return JSON.parse(t) as { threadId: string; text: string };
}
