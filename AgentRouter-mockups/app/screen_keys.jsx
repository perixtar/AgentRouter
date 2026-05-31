// screen_keys.jsx — API Keys & Quickstart (centerpiece)
const { useState: useStateK, useEffect: useEffectK, useRef: useRefK } = React;

/* ── lightweight syntax highlighter ─────────────────────────────── */
const KW = "const|let|var|import|from|await|async|function|return|new|export|if|else|for|in|class|def|print|pip|npm|curl";
const TOK = new RegExp(
  `(#[^\\n]*|//[^\\n]*)` +                 // 1 comment
  `|("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)` + // 2 string
  `|\\b(${KW})\\b` +                        // 3 keyword
  `|\\b(\\d+\\.?\\d*)\\b` +                 // 4 number
  `|([A-Za-z_][A-Za-z0-9_]*)(?=\\()` +     // 5 fn call
  `|(\\$\\{?[A-Z_]+\\}?)`,                  // 6 env/var
  "g"
);
function hl(code) {
  const out = [];
  let last = 0, m, i = 0;
  TOK.lastIndex = 0;
  while ((m = TOK.exec(code))) {
    if (m.index > last) out.push(code.slice(last, m.index));
    let color;
    if (m[1]) color = "var(--tx-4)";        // comment
    else if (m[2]) color = "var(--acc)";    // string
    else if (m[3]) color = "var(--info)";   // keyword
    else if (m[4]) color = "var(--warn)";   // number
    else if (m[5]) color = "var(--tx)";     // fn
    else if (m[6]) color = "var(--warn)";   // env
    out.push(<span key={i++} style={{ color, fontWeight: m[5] ? 540 : 400 }}>{m[0]}</span>);
    last = m.index + m[0].length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

function CodeBlock({ code, lang, filename }) {
  return (
    <div style={{ background: "var(--bg-inset)", border: "1px solid var(--line)", borderRadius: 10, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", height: 36, padding: "0 8px 0 13px", borderBottom: "1px solid var(--line-soft)", background: "var(--bg-1)" }}>
        <span className="mono" style={{ fontSize: 11.5, color: "var(--tx-3)" }}>{filename}</span>
        <Copy text={code} label="Copy" />
      </div>
      <pre className="mono" style={{ margin: 0, padding: "14px 16px", fontSize: 12.5, lineHeight: 1.75, overflowX: "auto", color: "var(--tx-2)" }}>
        <code>{hl(code)}</code>
      </pre>
    </div>
  );
}

const SNIPPETS = {
  Node: {
    filename: "run-agent.ts",
    code: `import { AgentRouter } from "@agentrouter/sdk";

const ar = new AgentRouter({ apiKey: process.env.AGENTROUTER_KEY });

// Run an agent and stream every step back
const run = await ar.agents.run("support-triage", {
  input: { ticket_id: 48213 },
  // risky tool calls pause for approval instead of failing
  onApproval: "pause",
});

for await (const step of run.stream()) {
  console.log(step.type, step.label, step.status);
}

console.log("run", run.id, "→", run.status);`,
  },
  Python: {
    filename: "run_agent.py",
    code: `from agentrouter import AgentRouter

ar = AgentRouter(api_key=os.environ["AGENTROUTER_KEY"])

# Run an agent and stream every step back
run = ar.agents.run(
    "support-triage",
    input={"ticket_id": 48213},
    on_approval="pause",  # risky calls wait for a human
)

for step in run.stream():
    print(step.type, step.label, step.status)

print("run", run.id, "->", run.status)`,
  },
  cURL: {
    filename: "terminal",
    code: `curl https://api.agentrouter.dev/v1/agents/support-triage/runs \\
  -H "Authorization: Bearer $AGENTROUTER_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "input": { "ticket_id": 48213 },
    "on_approval": "pause"
  }'`,
  },
};

/* ── terminal output that "streams" ─────────────────────────────── */
const TERMINAL_LINES = [
  { t: "cmd", s: "$ npx tsx run-agent.ts" },
  { t: "dim", s: "→ POST /v1/agents/support-triage/runs" },
  { t: "ok", s: "✓ run_a91f4c started · streaming" },
  { t: "step", s: "input   Run started" },
  { t: "step", s: "model   Model reasoning            1.9s" },
  { t: "step", s: "tool    orders.lookup       200    0.2s" },
  { t: "step", s: "mcp     stripe › charges.list      0.3s" },
  { t: "warn", s: "⏸ approval  stripe › refunds.create — paused" },
  { t: "dim", s: "  waiting for approval in dashboard…" },
];

function Terminal({ onTrace }) {
  const [n, setN] = useStateK(0);
  const [playing, setPlaying] = useStateK(true);
  const ref = useRefK(null);
  useEffectK(() => {
    if (!playing || n >= TERMINAL_LINES.length) return;
    const id = setTimeout(() => setN((x) => x + 1), n === 0 ? 320 : 520);
    return () => clearTimeout(id);
  }, [n, playing]);
  useEffectK(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [n]);
  const colorFor = (t) => ({ cmd: "var(--tx)", dim: "var(--tx-4)", ok: "var(--acc)", warn: "var(--warn)", step: "var(--tx-2)" }[t]);
  const done = n >= TERMINAL_LINES.length;
  return (
    <div style={{ background: "var(--bg-inset)", border: "1px solid var(--line)", borderRadius: 10, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, height: 36, padding: "0 10px 0 13px", borderBottom: "1px solid var(--line-soft)", background: "var(--bg-1)" }}>
        <div style={{ display: "flex", gap: 6 }}>
          {["var(--danger)", "var(--warn)", "var(--ok)"].map((c, i) => <span key={i} style={{ width: 10, height: 10, borderRadius: 99, background: `color-mix(in oklch, ${c} 75%, transparent)` }} />)}
        </div>
        <span className="mono" style={{ fontSize: 11.5, color: "var(--tx-4)", flex: 1, textAlign: "center" }}>zsh — agent-app</span>
        <IconBtn icon={playing && !done ? "pause" : "refresh"} size={26} dsize={13} onClick={() => { if (done) { setN(0); setPlaying(true); } else setPlaying(!playing); }} title="Replay" />
      </div>
      <div ref={ref} className="mono" style={{ padding: "13px 15px", fontSize: 12, lineHeight: 1.85, height: 232, overflowY: "auto" }}>
        {TERMINAL_LINES.slice(0, n).map((l, i) => (
          <div key={i} style={{ color: colorFor(l.t), whiteSpace: "pre", animation: "streamIn .26s var(--ease) both" }}>{l.s}</div>
        ))}
        {!done && <span style={{ display: "inline-block", width: 7, height: 14, background: "var(--acc)", verticalAlign: "-2px", animation: "pulse-dot 1s steps(2) infinite" }} />}
        {done && <button onClick={onTrace} style={{ marginTop: 10, display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 7, border: "1px solid var(--acc-line)", background: "var(--acc-soft)", color: "var(--acc)", cursor: "pointer", fontSize: 12, fontWeight: 540 }}>View full trace <Icon d="chevR" size={13} /></button>}
      </div>
    </div>
  );
}

/* ── create-key reveal flow ─────────────────────────────────────── */
function CreateKeyModal({ onClose, onCreated }) {
  const [name, setName] = useStateK("");
  const [env, setEnv] = useStateK("production");
  const [created, setCreated] = useStateK(false);
  const [revealed, setRevealed] = useStateK(false);
  const fullKey = "ar_live_7QxR2v9KmZ4pXc8Lf3Hn6Td1Ws5Bg0Jy";
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "color-mix(in oklch, var(--bg-inset) 70%, transparent)", backdropFilter: "blur(3px)", zIndex: 100, display: "grid", placeItems: "center", animation: "fadeUp .2s var(--ease)" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 480, background: "var(--bg-1)", border: "1px solid var(--line)", borderRadius: 14, boxShadow: "var(--shadow-lg)", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 18px", borderBottom: "1px solid var(--line-soft)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 30, height: 30, borderRadius: 8, background: "var(--acc-soft)", color: "var(--acc)", display: "grid", placeItems: "center" }}><Icon d="key" size={16} /></div>
            <h3 style={{ fontSize: 15, fontWeight: 600 }}>{created ? "Save your API key" : "Create API key"}</h3>
          </div>
          <IconBtn icon="x" onClick={onClose} />
        </div>
        {!created ? (
          <div style={{ padding: 18 }}>
            <label style={{ fontSize: 12.5, fontWeight: 540, color: "var(--tx-2)", display: "block", marginBottom: 7 }}>Key name</label>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. prod-backend" className="mono"
              style={{ width: "100%", height: 38, padding: "0 12px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--bg-inset)", color: "var(--tx)", fontSize: 13, outline: "none", marginBottom: 16 }} />
            <label style={{ fontSize: 12.5, fontWeight: 540, color: "var(--tx-2)", display: "block", marginBottom: 7 }}>Environment</label>
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              {["production", "test"].map((e) => (
                <button key={e} onClick={() => setEnv(e)} style={{ flex: 1, height: 38, borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 540, textTransform: "capitalize",
                  border: `1px solid ${env === e ? "var(--acc-line)" : "var(--line)"}`, background: env === e ? "var(--acc-soft)" : "var(--bg-inset)", color: env === e ? "var(--acc)" : "var(--tx-2)" }}>{e}</button>
              ))}
            </div>
            <label style={{ fontSize: 12.5, fontWeight: 540, color: "var(--tx-2)", display: "block", marginBottom: 7 }}>Scopes</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginBottom: 20 }}>
              {["agents:run", "runs:read", "approvals:write", "keys:read"].map((s, i) => (
                <span key={s} className="mono" style={{ fontSize: 11.5, padding: "5px 9px", borderRadius: 7, border: `1px solid ${i < 2 ? "var(--acc-line)" : "var(--line)"}`, background: i < 2 ? "var(--acc-soft)" : "var(--bg-inset)", color: i < 2 ? "var(--acc)" : "var(--tx-3)", display: "inline-flex", alignItems: "center", gap: 5 }}>
                  {i < 2 && <Icon d="check" size={12} />}{s}
                </span>
              ))}
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
              <Btn variant="primary" icon="key" onClick={() => setCreated(true)}>Create key</Btn>
            </div>
          </div>
        ) : (
          <div style={{ padding: 18 }}>
            <div style={{ display: "flex", gap: 9, padding: "11px 13px", borderRadius: 9, background: "color-mix(in oklch, var(--warn) 12%, transparent)", border: "1px solid color-mix(in oklch, var(--warn) 28%, transparent)", marginBottom: 16 }}>
              <Icon d="eye" size={16} style={{ color: "var(--warn)", marginTop: 1 }} />
              <span style={{ fontSize: 12.5, color: "var(--tx-2)", lineHeight: 1.5 }}>This is the only time you'll see the full key. Store it in a secret manager — AgentRouter only keeps the prefix.</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px", borderRadius: 9, background: "var(--bg-inset)", border: "1px solid var(--line)", marginBottom: 18 }}>
              <span className="mono" style={{ flex: 1, fontSize: 13, color: "var(--tx)", letterSpacing: ".01em", overflow: "hidden", textOverflow: "ellipsis" }}>
                {revealed ? fullKey : "ar_live_7Qx" + "•".repeat(28)}
              </span>
              <IconBtn icon="eye" onClick={() => setRevealed(!revealed)} title="Reveal" active={revealed} />
              <Copy text={fullKey} label="Copy" />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <Btn variant="primary" icon="check" onClick={() => { onCreated && onCreated({ name: name || "new-key", env }); onClose(); }}>Done — I saved it</Btn>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── keys table ─────────────────────────────────────────────────── */
function KeyRow({ k }) {
  const [h, setH] = useStateK(false);
  return (
    <div onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      style={{ display: "grid", gridTemplateColumns: "minmax(150px,1.4fr) 200px 1.4fr 110px 90px 80px", gap: 14, alignItems: "center", padding: "0 16px", height: 56, borderBottom: "1px solid var(--line-soft)", background: h ? "var(--bg-1)" : "transparent", transition: "background .12s" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <Dot tone={k.env === "production" ? "info" : "mute"} size={7} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 540, whiteSpace: "nowrap" }}>{k.name}</div>
          <div style={{ fontSize: 10.5, color: "var(--tx-4)" }}>{k.env}</div>
        </div>
      </div>
      <div className="mono" style={{ fontSize: 12, color: "var(--tx-3)", display: "flex", alignItems: "center", gap: 7 }}>
        {k.prefix}<span style={{ color: "var(--tx-4)", letterSpacing: "1px" }}>••••••</span>
        <span style={{ opacity: h ? 1 : 0, transition: "opacity .14s" }}><Copy text={k.prefix} /></span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
        {k.scopes.map((s) => <span key={s} className="mono" style={{ fontSize: 10.5, padding: "2px 6px", borderRadius: 5, background: "var(--bg-2)", border: "1px solid var(--line-soft)", color: "var(--tx-3)" }}>{s}</span>)}
      </div>
      <span className="tnum" style={{ fontSize: 12.5, color: "var(--tx-2)" }}>{k.reqs} <span style={{ color: "var(--tx-4)" }}>reqs</span></span>
      <span style={{ fontSize: 12, color: "var(--tx-3)" }}>{k.lastUsed}</span>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Btn size="sm" variant="ghost" style={{ color: "var(--danger)", opacity: h ? 1 : 0.4 }}>Revoke</Btn>
      </div>
    </div>
  );
}

function KeysScreen({ goRuns }) {
  const { KEYS } = window.AR_DATA;
  const [lang, setLang] = useStateK("Node");
  const [modal, setModal] = useStateK(false);
  const [keys, setKeys] = useStateK(KEYS);
  const snip = SNIPPETS[lang];

  const STEPS = [
    { n: 1, title: "Create an API key", body: "Scope it to agents:run. The secret is shown once — store it in your secret manager." },
    { n: 2, title: "Install the SDK", body: "TypeScript and Python clients, or hit the REST API directly with cURL." },
    { n: 3, title: "Run an agent from your code", body: "Pass input, stream every step. Risky tool calls pause for approval instead of failing." },
    { n: 4, title: "Inspect the run", body: "Every step — model, tool, MCP, approval — is captured and replayable in the dashboard." },
  ];

  return (
    <div className="fade-up" style={{ padding: "22px 24px 64px", maxWidth: 1180, margin: "0 auto" }}>
      {modal && <CreateKeyModal onClose={() => setModal(false)} onCreated={(k) => setKeys([{ id: "key_new", name: k.name, prefix: "ar_live_7Qx", env: k.env, scopes: ["agents:run", "runs:read"], created: "Just now", lastUsed: "—", reqs: "0", color: "ok" }, ...keys])} />}

      {/* keys */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600 }}>API keys</h2>
          <Badge tone="mute">{keys.length}</Badge>
        </div>
        <Btn variant="primary" icon="plus" onClick={() => setModal(true)}>Create key</Btn>
      </div>
      <Card pad={false} style={{ overflow: "hidden", marginBottom: 34 }}>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(150px,1.4fr) 200px 1.4fr 110px 90px 80px", gap: 14, padding: "0 16px", height: 36, alignItems: "center", borderBottom: "1px solid var(--line)", fontSize: 11, fontWeight: 600, letterSpacing: ".05em", textTransform: "uppercase", color: "var(--tx-4)", background: "var(--bg-inset)" }}>
          <span>Name</span><span>Secret</span><span>Scopes</span><span>Usage</span><span>Last used</span><span></span>
        </div>
        {keys.map((k) => <KeyRow key={k.id} k={k} />)}
      </Card>

      {/* quickstart */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <Icon d="bolt" size={17} style={{ color: "var(--acc)" }} />
        <h2 style={{ fontSize: 15, fontWeight: 600 }}>Quickstart</h2>
        <span style={{ fontSize: 13, color: "var(--tx-3)" }}>— get an agent running from your code in under a minute</span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(280px,0.9fr) 1.25fr", gap: 24, marginTop: 18, alignItems: "start" }}>
        {/* steps */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          {STEPS.map((s, i) => (
            <div key={s.n} style={{ display: "flex", gap: 14, paddingBottom: i < STEPS.length - 1 ? 22 : 0, position: "relative" }}>
              {i < STEPS.length - 1 && <span style={{ position: "absolute", left: 14, top: 30, bottom: 0, width: 1.5, background: "var(--line)" }} />}
              <div style={{ width: 29, height: 29, borderRadius: 9, flex: "none", display: "grid", placeItems: "center", fontSize: 13, fontWeight: 600, zIndex: 1,
                background: s.n === 1 ? "var(--acc)" : "var(--bg-2)", color: s.n === 1 ? "var(--acc-ink)" : "var(--tx-2)", border: s.n === 1 ? "none" : "1px solid var(--line)" }}>{s.n}</div>
              <div style={{ paddingTop: 3 }}>
                <div style={{ fontSize: 13.5, fontWeight: 580, marginBottom: 3 }}>{s.title}</div>
                <div style={{ fontSize: 12.5, color: "var(--tx-3)", lineHeight: 1.5, maxWidth: 280 }}>{s.body}</div>
                {s.n === 1 && <Btn size="sm" variant="okgh" icon="key" style={{ marginTop: 9 }} onClick={() => setModal(true)}>Create key</Btn>}
                {s.n === 2 && <div className="mono" style={{ marginTop: 9, fontSize: 11.5, color: "var(--tx-3)", display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ padding: "4px 8px", borderRadius: 6, background: "var(--bg-inset)", border: "1px solid var(--line-soft)" }}>npm i @agentrouter/sdk</span>
                  <span style={{ padding: "4px 8px", borderRadius: 6, background: "var(--bg-inset)", border: "1px solid var(--line-soft)" }}>pip install agentrouter</span>
                </div>}
              </div>
            </div>
          ))}
        </div>

        {/* code + terminal */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16, position: "sticky", top: 74 }}>
          <div>
            <Tabs tabs={["Node", "Python", "cURL"]} value={lang} onChange={setLang} style={{ marginBottom: 10 }} />
            <CodeBlock code={snip.code} filename={snip.filename} lang={lang} />
          </div>
          <Terminal onTrace={goRuns} />
        </div>
      </div>
    </div>
  );
}

window.KeysScreen = KeysScreen;
