// app.jsx — shell, routing, theme/accent/density tweaks
const { useState: useStateApp, useEffect: useEffectApp } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "dark",
  "accent": "green",
  "density": "regular"
}/*EDITMODE-END*/;

/* ── simple secondary screens ───────────────────────────────────── */
function SimpleTable({ cols, rows }) {
  return (
    <Card pad={false} style={{ overflow: "hidden" }}>
      <div style={{ display: "grid", gridTemplateColumns: cols.map((c) => c.w || "1fr").join(" "), gap: 14, padding: "0 16px", height: 36, alignItems: "center", borderBottom: "1px solid var(--line)", fontSize: 11, fontWeight: 600, letterSpacing: ".05em", textTransform: "uppercase", color: "var(--tx-4)", background: "var(--bg-inset)" }}>
        {cols.map((c) => <span key={c.k}>{c.k}</span>)}
      </div>
      {rows.map((row, i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: cols.map((c) => c.w || "1fr").join(" "), gap: 14, padding: "0 16px", height: 54, alignItems: "center", borderBottom: "1px solid var(--line-soft)" }}>
          {cols.map((c) => <span key={c.k}>{c.render(row)}</span>)}
        </div>
      ))}
    </Card>
  );
}

function ToolsScreen() {
  const { TOOLS_MCP } = window.AR_DATA;
  return (
    <div className="fade-up" style={{ padding: "22px 24px", maxWidth: 1180, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}><h2 style={{ fontSize: 15, fontWeight: 600 }}>Connected tools</h2><Badge tone="mute">{TOOLS_MCP.length}</Badge></div>
        <Btn variant="primary" icon="plus">Connect MCP server</Btn>
      </div>
      <SimpleTable cols={[
        { k: "Server", w: "1.6fr", render: (r) => <span style={{ display: "flex", alignItems: "center", gap: 10 }}><div style={{ width: 30, height: 30, borderRadius: 8, background: "var(--bg-2)", border: "1px solid var(--line)", display: "grid", placeItems: "center" }}><Icon d="mcp" size={15} style={{ color: "var(--tx-3)" }} /></div><span><span className="mono" style={{ fontSize: 13, fontWeight: 540, display: "block" }}>{r.name}</span><span style={{ fontSize: 10.5, color: "var(--tx-4)" }}>{r.kind}</span></span></span> },
        { k: "Status", render: (r) => <Badge tone={r.status === "connected" ? "ok" : "warn"}><Dot tone={r.status === "connected" ? "ok" : "warn"} size={6} />{r.status}</Badge> },
        { k: "Tools", render: (r) => <span className="mono tnum" style={{ fontSize: 13 }}>{r.tools}</span> },
        { k: "Latency", render: (r) => <span className="mono tnum" style={{ fontSize: 13, color: parseInt(r.latency) > 500 ? "var(--warn)" : "var(--tx-2)" }}>{r.latency}</span> },
        { k: "", w: "90px", render: () => <Btn size="sm" variant="ghost">Manage</Btn> },
      ]} rows={TOOLS_MCP} />
    </div>
  );
}

function ProvidersScreen() {
  const { PROVIDERS } = window.AR_DATA;
  return (
    <div className="fade-up" style={{ padding: "22px 24px", maxWidth: 1180, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}><h2 style={{ fontSize: 15, fontWeight: 600 }}>Model providers</h2><Badge tone="mute">{PROVIDERS.length}</Badge></div>
        <Btn variant="primary" icon="plus">Add credential</Btn>
      </div>
      <SimpleTable cols={[
        { k: "Provider", w: "1.6fr", render: (r) => <span style={{ display: "flex", alignItems: "center", gap: 10 }}><div style={{ width: 30, height: 30, borderRadius: 8, background: "var(--bg-2)", border: "1px solid var(--line)", display: "grid", placeItems: "center" }}><Icon d="providers" size={15} style={{ color: "var(--tx-3)" }} /></div><span style={{ fontSize: 13, fontWeight: 540 }}>{r.name}</span></span> },
        { k: "Status", render: (r) => <Badge tone={r.status === "active" ? "ok" : "mute"}>{r.status}</Badge> },
        { k: "Models", render: (r) => <span className="mono tnum" style={{ fontSize: 13 }}>{r.models}</span> },
        { k: "Spend (mo)", render: (r) => <span className="mono tnum" style={{ fontSize: 13 }}>{r.spend}</span> },
        { k: "", w: "90px", render: () => <Btn size="sm" variant="ghost">Configure</Btn> },
      ]} rows={PROVIDERS} />
    </div>
  );
}

function AuditScreen() {
  const { LIVE_STEPS, RUNS } = window.AR_DATA;
  const events = [
    { t: "12s", who: "support-triage", act: "run.started", obj: "run_a91f4c", tone: "info" },
    { t: "14s", who: "support-triage", act: "tool.called", obj: "orders.lookup", tone: "ok" },
    { t: "15s", who: "support-triage", act: "mcp.called", obj: "stripe › charges.list", tone: "ok" },
    { t: "16s", who: "support-triage", act: "approval.requested", obj: "stripe › refunds.create", tone: "warn" },
    { t: "1m", who: "dana@acme.io", act: "key.created", obj: "ar_live_7Qx…", tone: "info" },
    { t: "14m", who: "dana@acme.io", act: "approval.approved", obj: "apv_88c · refund $18.00", tone: "ok" },
    { t: "1h", who: "m.chen@acme.io", act: "approval.denied", obj: "apv_71a · rollback", tone: "danger" },
    { t: "2h", who: "deploy-bot", act: "run.failed", obj: "run_2290ef · timeout", tone: "danger" },
  ];
  return (
    <div className="fade-up" style={{ padding: "22px 24px", maxWidth: 1180, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}><h2 style={{ fontSize: 15, fontWeight: 600 }}>Audit log</h2><span style={{ fontSize: 12.5, color: "var(--tx-4)" }}>Immutable · every action by every actor</span></div>
        <Btn variant="default" icon="ext">Export</Btn>
      </div>
      <Card pad={false} style={{ overflow: "hidden" }}>
        {events.map((e, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "70px 200px 1fr auto", gap: 16, padding: "0 16px", height: 46, alignItems: "center", borderBottom: "1px solid var(--line-soft)" }}>
            <span className="mono" style={{ fontSize: 11.5, color: "var(--tx-4)" }}>{e.t} ago</span>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}><Dot tone={e.tone} size={6} /><span className="mono" style={{ fontSize: 12, color: "var(--tx-2)" }}>{e.who}</span></span>
            <span><Badge tone={e.tone} mono style={{ height: 18, fontSize: 10.5 }}>{e.act}</Badge> <span className="mono" style={{ fontSize: 12, color: "var(--tx-3)", marginLeft: 6 }}>{e.obj}</span></span>
            <Icon d="chevR" size={14} style={{ color: "var(--tx-4)" }} />
          </div>
        ))}
      </Card>
    </div>
  );
}

/* ── accent swatch picker (maps to data-accent names) ───────────── */
const ACCENTS = [
  { id: "green", hex: "oklch(0.80 0.155 152)" },
  { id: "blue", hex: "oklch(0.72 0.14 245)" },
  { id: "orange", hex: "oklch(0.76 0.16 52)" },
  { id: "violet", hex: "oklch(0.72 0.15 295)" },
];
function AccentPicker({ value, onChange }) {
  return (
    <div className="twk-row">
      <div className="twk-lbl"><span>Accent</span></div>
      <div style={{ display: "flex", gap: 6 }}>
        {ACCENTS.map((a) => (
          <button key={a.id} type="button" onClick={() => onChange(a.id)} title={a.id}
            style={{ flex: 1, height: 30, borderRadius: 7, cursor: "pointer", background: a.hex,
              border: value === a.id ? "2px solid rgba(0,0,0,.55)" : "2px solid transparent",
              boxShadow: value === a.id ? "0 0 0 1.5px #fff inset" : "0 0 0 .5px rgba(0,0,0,.15)" }} />
        ))}
      </div>
    </div>
  );
}

/* ── route metadata for topbar ──────────────────────────────────── */
const META = {
  overview: { title: "Agents", crumbs: ["Acme Inc", "Agents"] },
  keys: { title: "API Keys & Quickstart", crumbs: ["Acme Inc", "Developers", "API Keys"] },
  runs: { title: "Runs", crumbs: ["Acme Inc", "Observability", "Runs"] },
  approvals: { title: "Approvals", crumbs: ["Acme Inc", "Approvals"] },
  tools: { title: "Tools & MCP", crumbs: ["Acme Inc", "Configure", "Tools"] },
  providers: { title: "Providers", crumbs: ["Acme Inc", "Configure", "Providers"] },
  audit: { title: "Audit log", crumbs: ["Acme Inc", "Configure", "Audit"] },
};

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [route, setRoute] = useStateApp("keys");
  const [pending, setPending] = useStateApp(window.AR_DATA.APPROVALS.length);

  // apply tweaks to <html>
  useEffectApp(() => {
    const el = document.documentElement;
    el.setAttribute("data-theme", t.theme);
    el.setAttribute("data-accent", t.accent);
    el.setAttribute("data-density", t.density);
  }, [t.theme, t.accent, t.density]);

  const m = META[route];
  const toggleTheme = () => setTweak("theme", t.theme === "dark" ? "light" : "dark");

  let topActions = null;
  if (route === "overview") topActions = <Btn variant="default" icon="ext" size="md">Docs</Btn>;
  if (route === "runs") topActions = <Badge tone="live"><Dot tone="live" pulse size={6} />2 live</Badge>;

  const sub = route === "approvals" && pending > 0
    ? <Badge tone="warn"><Dot tone="warn" pulse size={6} />{pending} awaiting you</Badge>
    : route === "keys" ? <Badge tone="ok" mono>v1 · api.agentrouter.dev</Badge> : null;

  let screen;
  if (route === "overview") screen = <OverviewScreen onOpenAgent={() => setRoute("runs")} onNew={() => setRoute("keys")} />;
  else if (route === "keys") screen = <KeysScreen goRuns={() => setRoute("runs")} />;
  else if (route === "runs") screen = <RunScreen onApproveAction={() => setPending((p) => Math.max(0, p - 1))} />;
  else if (route === "approvals") screen = <ApprovalsScreen onResolve={() => setPending((p) => Math.max(0, p - 1))} />;
  else if (route === "tools") screen = <ToolsScreen />;
  else if (route === "providers") screen = <ProvidersScreen />;
  else if (route === "audit") screen = <AuditScreen />;

  const scrolls = route === "runs" || route === "approvals";

  return (
    <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
      <Sidebar route={route} setRoute={setRoute} pendingApprovals={pending} />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <TopBar title={m.title} sub={sub} crumbs={m.crumbs} actions={topActions} theme={t.theme} onTheme={toggleTheme} />
        <main style={{ flex: 1, minHeight: 0, overflow: scrolls ? "hidden" : "auto" }}>{screen}</main>
      </div>

      <TweaksPanel title="Tweaks">
        <TweakSection label="Theme" />
        <TweakRadio label="Mode" value={t.theme} options={["dark", "light"]} onChange={(v) => setTweak("theme", v)} />
        <AccentPicker value={t.accent} onChange={(v) => setTweak("accent", v)} />
        <TweakSection label="Layout" />
        <TweakRadio label="Density" value={t.density} options={["compact", "regular", "comfy"]} onChange={(v) => setTweak("density", v)} />
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
