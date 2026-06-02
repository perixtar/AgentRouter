"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

type RunStatus =
  | "queued"
  | "starting"
  | "running"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "failed";

interface ChatMessage {
  role: "user" | "agent";
  text: string;
}

interface TermLine {
  key: string;
  cls: string;
  text: string;
}

interface FileEntry {
  code: "A" | "M" | "D";
  path: string;
}

interface EventItem {
  sequence: number;
  type: string;
  source: string;
  text?: string;
  payload: Record<string, unknown>;
}

const TERMINAL_DONE: RunStatus[] = ["completed", "failed", "cancelled"];

export function PlaygroundClient() {
  const [task, setTask] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [termLines, setTermLines] = useState<TermLine[]>([]);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [tab, setTab] = useState<"term" | "files">("term");
  const [status, setStatus] = useState<RunStatus | "idle">("idle");
  const [runId, setRunId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [byok, setByok] = useState<{ connected: boolean; last4?: string } | null>(null);
  // The conversation handle = the FIRST run's id. Follow-ups continue by it.
  const [conversationId, setConversationId] = useState<string | null>(null);

  const termRef = useRef<HTMLDivElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seenAgentText = useRef<Set<number>>(new Set());

  const running = status !== "idle" && !TERMINAL_DONE.includes(status as RunStatus);

  useEffect(() => {
    termRef.current?.scrollTo({ top: termRef.current.scrollHeight });
  }, [termLines]);

  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
  }, [messages]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, []);

  // Reflect real BYOK status in the composer chip.
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/provider-keys", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as {
          items: { provider: string; last4: string }[];
        };
        const openai = data.items.find((p) => p.provider === "openai");
        setByok(openai ? { connected: true, last4: openai.last4 } : { connected: false });
      } catch {
        setByok({ connected: false });
      }
    })();
  }, [status]);

  // Resume an in-flight or finished run from a shareable ?run=<id> link.
  // The link's run id is treated as the conversation handle so follow-ups in
  // the chat continue it. Polls from sequence 0 to rebuild Terminal/Files.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("run");
    if (!id) return;
    setRunId(id);
    setConversationId(id);
    setStatus("queued");
    setTermLines([{ key: "resume-0", cls: "dim", text: `· resuming ${id}` }]);
    poll(id, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pushTerm = useCallback((cls: string, text: string, seq: number, idx: number) => {
    setTermLines((prev) => [...prev, { key: `${seq}-${idx}`, cls, text }]);
  }, []);

  const loadFiles = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/playground/files/${id}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { files: FileEntry[] };
      setFiles(data.files ?? []);
    } catch {
      // ignore — files are best-effort post-completion
    }
  }, []);

  const poll = useCallback(
    async (id: string, afterSeq: number) => {
      try {
        const res = await fetch(`/api/playground/events/${id}?afterSeq=${afterSeq}`, {
          cache: "no-store"
        });
        if (!res.ok) {
          setError(`Stream error (${res.status})`);
          setStatus("failed");
          return;
        }
        const data = (await res.json()) as {
          status: RunStatus;
          failure?: { code?: string; reason?: string };
          items: EventItem[];
          nextAfterSeq: number;
        };

        for (const ev of data.items) {
          renderEvent(ev);
        }

        setStatus(data.status);

        const done = TERMINAL_DONE.includes(data.status);
        if (done) {
          if (data.status === "failed") {
            const reason = data.failure?.reason ?? "Run failed";
            pushTerm("warn", `✗ ${reason}`, data.nextAfterSeq, 99);
            if (data.failure?.code === "byok_missing") {
              setError("Connect your OpenAI key in API Keys to run agents.");
            } else {
              setError(reason);
            }
          } else {
            await loadFiles(id);
            setTab("files");
          }
          return;
        }

        pollRef.current = setTimeout(() => poll(id, data.nextAfterSeq), 1500);
      } catch {
        pollRef.current = setTimeout(() => poll(id, afterSeq), 2500);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loadFiles, pushTerm]
  );

  function renderEvent(ev: EventItem) {
    if (ev.type === "provider.stdout" && ev.text) {
      for (const raw of ev.text.split("\n")) {
        const line = raw.replace(/\s+$/, "");
        if (line.length === 0) continue;
        setTermLines((prev) => [
          ...prev,
          { key: `${ev.sequence}-${prev.length}`, cls: "step", text: line }
        ]);
      }
    } else if (ev.type === "agent.response" && ev.text) {
      if (!seenAgentText.current.has(ev.sequence)) {
        seenAgentText.current.add(ev.sequence);
        const text = ev.text;
        setMessages((prev) => [...prev, { role: "agent", text }]);
      }
    } else if (ev.type === "run.completed") {
      setTermLines((prev) => [
        ...prev,
        { key: `${ev.sequence}-done`, cls: "ok", text: "✓ run.completed" }
      ]);
    } else if (ev.type === "run.failed") {
      setTermLines((prev) => [
        ...prev,
        { key: `${ev.sequence}-fail`, cls: "warn", text: "✗ run.failed" }
      ]);
    }
  }

  async function onRun() {
    // Prefer the live DOM value (covers paste / IME / autofill where the
    // controlled state may lag a frame), falling back to React state.
    const value = (taRef.current?.value ?? task).trim();
    if (!value || running || submitting) return;

    const isFollowUp = conversationId !== null;
    setSubmitting(true);
    setError(null);
    setMessages((prev) => [...prev, { role: "user", text: value }]);
    setTab("term");
    setStatus("queued");
    seenAgentText.current = new Set();
    setTask("");
    if (taRef.current) taRef.current.value = "";

    // On a follow-up, keep the cumulative terminal but mark the new turn.
    if (isFollowUp) {
      setTermLines((prev) => [
        ...prev,
        { key: `turn-${Date.now()}`, cls: "dim", text: `\n— turn ${messages.filter((m) => m.role === "user").length + 1} —` }
      ]);
    } else {
      setTermLines([]);
      setFiles([]);
    }

    try {
      // Turn 1 creates a run (its id becomes the conversation handle);
      // follow-ups continue by that run id (run-id multi-turn).
      const url = isFollowUp
        ? `/api/playground/run/${conversationId}/message`
        : "/api/playground/run";
      const body = isFollowUp ? { message: value } : { task: value };

      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = (await res.json()) as {
        runId?: string;
        conversationId?: string;
        error?: string;
        message?: string;
      };
      if (!res.ok || !data.runId) {
        setError(data.message ?? data.error ?? "Failed to start turn");
        setStatus("failed");
        return;
      }
      // The first run's id is the conversation handle for all later turns.
      if (!isFollowUp) setConversationId(data.runId);
      setRunId(data.runId);
      setTermLines((prev) => [
        ...prev,
        {
          key: `init-${data.runId}`,
          cls: "ok",
          text: `✓ ${data.runId} queued${isFollowUp ? " (continue)" : ""}`
        }
      ]);
      poll(data.runId, 0);
    } catch {
      setError("Network error starting turn");
      setStatus("failed");
    } finally {
      setSubmitting(false);
    }
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void onRun();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void onRun();
    }
  }

  const statusBadge = statusBadgeFor(status);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(360px, 0.85fr) 1.15fr",
        height: "calc(100vh - 56px)"
      }}
    >
      {/* chat */}
      <div className="chat" style={{ borderRight: "1px solid var(--line-soft)" }}>
        <div className="chat-scroll" ref={chatRef}>
          {messages.length === 0 ? (
            <div className="msg agent">
              <div className="who">
                <span className="dot info" /> agent
              </div>
              <div className="bubble">
                Describe a task and hit Run. Your agent executes in an isolated
                Daytona sandbox and streams real output into the Terminal.
              </div>
            </div>
          ) : (
            messages.map((m, i) => (
              <div key={i} className={`msg ${m.role}`}>
                <div className="who">{m.role === "user" ? "you" : "agent"}</div>
                <div className="bubble">{m.text}</div>
              </div>
            ))
          )}
          {error ? (
            <div className="msg agent">
              <div className="who">
                <span className="dot warn" /> error
              </div>
              <div className="bubble" style={{ color: "var(--danger)" }}>
                {error}
              </div>
            </div>
          ) : null}
        </div>
        <div className="composer">
          {byok?.connected ? (
            <div className="byok-chip">
              <span className="dot ok" /> Running on{" "}
              <strong style={{ color: "var(--tx-2)", fontWeight: 600 }}>
                your OpenAI key
              </strong>
              {byok.last4 ? (
                <span className="mono" style={{ color: "var(--tx-4)" }}>
                  · sk-••••{byok.last4}
                </span>
              ) : null}
            </div>
          ) : (
            <div className="byok-chip">
              <span className="dot warn" />{" "}
              <Link href="/keys" style={{ color: "var(--warn)", fontWeight: 600 }}>
                Connect your OpenAI key
              </Link>{" "}
              to run agents
            </div>
          )}
          <form className="inputrow" onSubmit={onSubmit}>
            <textarea
              ref={taRef}
              className="taskinput"
              placeholder="Describe a task for your agent…"
              rows={1}
              value={task}
              onChange={(e) => setTask(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={running}
            />
            <button className="btn primary" type="submit" disabled={running || submitting}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                <path d="M7 4l13 8-13 8V4z" />
              </svg>
              {running ? "Running…" : "Run"}
            </button>
          </form>
        </div>
      </div>

      {/* computer */}
      <div
        style={{
          padding: 18,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          gap: 12,
          background: "var(--bg)"
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div className="tabbar">
            <button
              className={`tab${tab === "term" ? " on" : ""}`}
              onClick={() => setTab("term")}
            >
              Terminal
            </button>
            <button
              className={`tab${tab === "files" ? " on" : ""}`}
              onClick={() => setTab("files")}
            >
              Files{" "}
              {files.length > 0 ? (
                <span
                  className="badge mute"
                  style={{ height: 16, padding: "0 5px", fontSize: 10 }}
                >
                  {files.length}
                </span>
              ) : null}
            </button>
          </div>
          <span className={`badge ${statusBadge.cls}`}>
            <span className={`dot ${statusBadge.dot}`} />
            {statusBadge.label}
          </span>
        </div>

        <div className="win" style={{ flex: 1 }}>
          <div className="win-bar">
            <div className="lights">
              <span style={{ background: "color-mix(in oklch,var(--danger) 75%,transparent)" }} />
              <span style={{ background: "color-mix(in oklch,var(--warn) 75%,transparent)" }} />
              <span style={{ background: "color-mix(in oklch,var(--ok) 75%,transparent)" }} />
            </div>
            <span
              className="win-title mono"
              style={{ flex: 1, textAlign: "center" }}
            >
              {runId ? `${runId} · Daytona sandbox` : "Daytona sandbox"}
            </span>
          </div>
          <div className="win-body">
            {tab === "term" ? (
              <div className="term mono" ref={termRef} style={{ height: "100%" }}>
                {termLines.map((l) => (
                  <div key={l.key} className={`ln ${l.cls}`}>
                    {l.text}
                  </div>
                ))}
                {running ? <span className="cursor" /> : null}
              </div>
            ) : (
              <div>
                {files.length === 0 ? (
                  <div style={{ padding: "14px 15px", fontSize: 12, color: "var(--tx-4)" }}>
                    No file changes yet.
                  </div>
                ) : (
                  <>
                    {files.map((f, i) => (
                      <div className="filerow" key={i}>
                        <span className={`fstat ${f.code}`}>{f.code}</span>
                        <span className="mono" style={{ flex: 1 }}>
                          {f.path}
                        </span>
                      </div>
                    ))}
                    <div style={{ padding: "14px 15px", fontSize: 12, color: "var(--tx-4)" }}>
                      {files.length} file{files.length === 1 ? "" : "s"} changed · from{" "}
                      <span className="mono">git status --porcelain</span> in the sandbox
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function statusBadgeFor(status: RunStatus | "idle"): {
  cls: string;
  dot: string;
  label: string;
} {
  switch (status) {
    case "idle":
      return { cls: "mute", dot: "mute", label: "idle" };
    case "completed":
      return { cls: "ok", dot: "ok", label: "completed" };
    case "failed":
      return { cls: "danger", dot: "warn", label: "failed" };
    case "cancelled":
      return { cls: "mute", dot: "mute", label: "cancelled" };
    default:
      return { cls: "warn", dot: "warn", label: `${status}…` };
  }
}
