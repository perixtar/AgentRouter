"use client";

import { useCallback, useEffect, useState } from "react";

interface ProviderStatus {
  provider: string;
  last4: string;
  connected: boolean;
}

interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface CreatedKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  secret: string;
}

export function KeysClient() {
  const [provider, setProvider] = useState<ProviderStatus | null>(null);
  const [providerInput, setProviderInput] = useState("");
  const [providerBusy, setProviderBusy] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);

  const [keys, setKeys] = useState<ApiKeySummary[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [revealed, setRevealed] = useState<CreatedKey | null>(null);
  const [copied, setCopied] = useState(false);

  const loadProvider = useCallback(async () => {
    const res = await fetch("/api/provider-keys", { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { items: ProviderStatus[] };
    setProvider(data.items.find((p) => p.provider === "openai") ?? null);
  }, []);

  const loadKeys = useCallback(async () => {
    const res = await fetch("/api/keys", { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { items: ApiKeySummary[] };
    setKeys(data.items);
  }, []);

  useEffect(() => {
    void loadProvider();
    void loadKeys();
  }, [loadProvider, loadKeys]);

  async function connectProvider() {
    const key = providerInput.trim();
    if (!key || providerBusy) return;
    setProviderBusy(true);
    setProviderError(null);
    try {
      const res = await fetch("/api/provider-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key })
      });
      const data = (await res.json()) as { message?: string; error?: string };
      if (!res.ok) {
        setProviderError(data.message ?? data.error ?? "Could not connect key");
        return;
      }
      setProviderInput("");
      await loadProvider();
    } finally {
      setProviderBusy(false);
    }
  }

  async function disconnectProvider() {
    setProviderBusy(true);
    try {
      await fetch("/api/provider-keys/openai", { method: "DELETE" });
      await loadProvider();
    } finally {
      setProviderBusy(false);
    }
  }

  async function createKey() {
    const name = newKeyName.trim();
    if (!name || createBusy) return;
    setCreateBusy(true);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name })
      });
      if (!res.ok) return;
      const created = (await res.json()) as CreatedKey;
      setRevealed(created);
      setNewKeyName("");
      await loadKeys();
    } finally {
      setCreateBusy(false);
    }
  }

  async function revokeKey(id: string) {
    await fetch(`/api/keys/${id}`, { method: "DELETE" });
    await loadKeys();
  }

  function openModal() {
    setRevealed(null);
    setCopied(false);
    setNewKeyName("");
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setRevealed(null);
  }

  const activeKeys = keys.filter((k) => !k.revokedAt);

  return (
    <div className="section fade-up">
      {/* ── BYOK provider key ── */}
      <div className="sec-head">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h2 className="sec-title">Provider key</h2>
          <span className="badge acc">Bring your own key</span>
        </div>
      </div>
      <p
        style={{
          fontSize: 13,
          color: "var(--tx-3)",
          margin: "-6px 0 14px",
          maxWidth: 680
        }}
      >
        This is the credential that{" "}
        <strong style={{ color: "var(--tx-2)" }}>actually runs your agents</strong>.
        AgentRouter encrypts it at rest and passes it straight to the runtime in an
        isolated sandbox — never in plaintext, never in general tool env.
      </p>

      <div className="provcard">
        <div
          className="provlogo"
          style={{
            background: "color-mix(in oklch,var(--ok) 14%,transparent)",
            color: "var(--ok)"
          }}
        >
          AI
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>OpenAI</span>
            {provider ? (
              <span className="badge ok" style={{ height: 19 }}>
                <span className="dot ok" />
                connected
              </span>
            ) : (
              <span className="badge mute" style={{ height: 19 }}>
                not connected
              </span>
            )}
          </div>
          {provider ? (
            <div
              className="mono"
              style={{ fontSize: 12, color: "var(--tx-3)", marginTop: 3 }}
            >
              sk-•••••••••••••••{provider.last4} · powers all Codex runs
            </div>
          ) : (
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <input
                className="field mono"
                style={{ flex: 1, maxWidth: 360 }}
                placeholder="sk-proj-…"
                value={providerInput}
                onChange={(e) => setProviderInput(e.target.value)}
              />
              <button
                className="btn primary sm"
                onClick={() => void connectProvider()}
                disabled={providerBusy || providerInput.trim().length === 0}
              >
                {providerBusy ? "Connecting…" : "Connect"}
              </button>
            </div>
          )}
          {providerError ? (
            <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 6 }}>
              {providerError}
            </div>
          ) : null}
        </div>
        {provider ? (
          <button
            className="btn danger sm"
            onClick={() => void disconnectProvider()}
            disabled={providerBusy}
          >
            Disconnect
          </button>
        ) : null}
      </div>

      <div style={{ height: 34 }} />

      {/* ── AgentRouter API keys ── */}
      <div className="sec-head">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h2 className="sec-title">AgentRouter API keys</h2>
          <span className="badge mute">{activeKeys.length}</span>
        </div>
        <button className="btn primary" onClick={openModal}>
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
          Create key
        </button>
      </div>
      <p
        style={{
          fontSize: 13,
          color: "var(--tx-3)",
          margin: "-6px 0 14px",
          maxWidth: 680
        }}
      >
        These authenticate{" "}
        <strong style={{ color: "var(--tx-2)" }}>your app → AgentRouter</strong> (the
        SDK / REST API). They don&apos;t run models — your provider key above does that.
      </p>

      <div className="card" style={{ overflow: "hidden" }}>
        <div className="tablehead">
          <span>Name</span>
          <span>Secret</span>
          <span>Scopes</span>
          <span>Last used</span>
          <span>Created</span>
          <span />
        </div>
        {activeKeys.length === 0 ? (
          <div style={{ padding: "18px 16px", fontSize: 13, color: "var(--tx-4)" }}>
            No keys yet. Create one to call the API.
          </div>
        ) : (
          activeKeys.map((k) => (
            <div className="keyrow" key={k.id}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                <span className="dot info" />
                <div style={{ fontSize: 13, fontWeight: 540 }}>{k.name}</div>
              </div>
              <div className="mono" style={{ fontSize: 12, color: "var(--tx-3)" }}>
                {k.prefix}
                <span style={{ color: "var(--tx-4)" }}>••••••</span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {k.scopes.map((s) => (
                  <span className="chip" key={s}>
                    {s}
                  </span>
                ))}
              </div>
              <span style={{ fontSize: 12, color: "var(--tx-3)" }}>
                {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : "never"}
              </span>
              <span style={{ fontSize: 12, color: "var(--tx-3)" }}>
                {new Date(k.createdAt).toLocaleDateString()}
              </span>
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button
                  className="btn ghost sm"
                  style={{ color: "var(--danger)" }}
                  onClick={() => void revokeKey(k.id)}
                >
                  Revoke
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* ── create / reveal-once modal ── */}
      {modalOpen ? (
        <div className="modal-bg" onClick={closeModal}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "16px 18px",
                borderBottom: "1px solid var(--line-soft)"
              }}
            >
              <h3 style={{ fontSize: 15, fontWeight: 600 }}>
                {revealed ? "Save your API key" : "Create API key"}
              </h3>
              <button className="iconbtn" onClick={closeModal} aria-label="Close">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>

            {!revealed ? (
              <div style={{ padding: 18 }}>
                <label
                  style={{
                    fontSize: 12.5,
                    fontWeight: 540,
                    color: "var(--tx-2)",
                    display: "block",
                    marginBottom: 7
                  }}
                >
                  Key name
                </label>
                <input
                  className="field mono"
                  placeholder="e.g. prod-backend"
                  style={{ marginBottom: 16 }}
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  autoFocus
                />
                <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                  <button className="btn ghost" onClick={closeModal}>
                    Cancel
                  </button>
                  <button
                    className="btn primary"
                    onClick={() => void createKey()}
                    disabled={createBusy || newKeyName.trim().length === 0}
                  >
                    {createBusy ? "Creating…" : "Create key"}
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ padding: 18 }}>
                <div
                  style={{
                    display: "flex",
                    gap: 9,
                    padding: "11px 13px",
                    borderRadius: 9,
                    background: "color-mix(in oklch,var(--warn) 12%,transparent)",
                    border: "1px solid color-mix(in oklch,var(--warn) 28%,transparent)",
                    marginBottom: 16,
                    fontSize: 12.5,
                    color: "var(--tx-2)",
                    lineHeight: 1.5
                  }}
                >
                  This is the only time you&apos;ll see the full key. Store it in a
                  secret manager — AgentRouter only keeps the prefix + a hash.
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "12px 14px",
                    borderRadius: 9,
                    background: "var(--bg-inset)",
                    border: "1px solid var(--line)",
                    marginBottom: 18
                  }}
                >
                  <span
                    className="mono"
                    style={{
                      flex: 1,
                      fontSize: 13,
                      color: "var(--tx)",
                      wordBreak: "break-all"
                    }}
                  >
                    {revealed.secret}
                  </span>
                  <button
                    className="btn ghost sm"
                    onClick={() => {
                      void navigator.clipboard?.writeText(revealed.secret);
                      setCopied(true);
                    }}
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button className="btn primary" onClick={closeModal}>
                    Done — I saved it
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
