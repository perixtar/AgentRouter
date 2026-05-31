// screen_overview.jsx — Agents list + fleet overview
const { useState: useStateO } = React;

function MetricCard({ label, value, unit, delta, deltaTone, data, tone }) {
  return (
    <Card style={{ padding: "15px 16px 13px", display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <span style={{ fontSize: 12.5, color: "var(--tx-3)", fontWeight: 500, whiteSpace: "nowrap" }}>{label}</span>
        {delta && <Badge tone={deltaTone} style={{ height: 19, padding: "0 6px", fontSize: 10.5 }}>{delta}</Badge>}
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
          <span className="tnum" style={{ fontSize: 27, fontWeight: 620, letterSpacing: "-.03em", lineHeight: 1 }}>{value}</span>
          {unit && <span style={{ fontSize: 13, color: "var(--tx-4)", fontWeight: 500 }}>{unit}</span>}
        </div>
        {data && <Bars data={data} tone={tone} w={116} h={32} />}
      </div>
    </Card>
  );
}

function AgentRow({ a, onOpen }) {
  const [h, setH] = useStateO(false);
  const stTone = { healthy: "ok", degraded: "warn", paused: "mute" }[a.status];
  return (
    <div onClick={() => onOpen(a)} onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      style={{
        display: "grid", gridTemplateColumns: "minmax(220px,2fr) 120px 100px 92px 96px 100px 40px",
        alignItems: "center", gap: 14, padding: "0 16px", height: 62, cursor: "pointer",
        background: h ? "var(--bg-1)" : "transparent", borderBottom: "1px solid var(--line-soft)",
        transition: "background .12s var(--ease)",
      }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
        <div style={{ width: 34, height: 34, borderRadius: 8, background: "var(--bg-2)", border: "1px solid var(--line)", display: "grid", placeItems: "center", flex: "none" }}>
          <Dot tone={a.status === "paused" ? "mute" : stTone} pulse={a.status === "healthy"} size={8} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="mono" style={{ fontSize: 13.5, fontWeight: 550, letterSpacing: "-.01em", whiteSpace: "nowrap" }}>{a.name}</span>
            <Badge tone={a.env === "production" ? "info" : "mute"} style={{ height: 17, padding: "0 5px", fontSize: 10 }}>{a.env === "production" ? "prod" : "staging"}</Badge>
          </div>
          <div style={{ fontSize: 11.5, color: "var(--tx-4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 340 }}>{a.desc}</div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, color: "var(--tx-2)", whiteSpace: "nowrap" }}>
        <Icon d="model" size={14} style={{ color: "var(--tx-4)" }} /><span className="mono" style={{ fontSize: 11.5, whiteSpace: "nowrap" }}>{a.model.replace("claude-", "")}</span>
      </div>
      <div className="tnum" style={{ fontSize: 13, color: "var(--tx)", fontWeight: 500, whiteSpace: "nowrap" }}>{a.runs24h.toLocaleString()}<span style={{ color: "var(--tx-4)", fontWeight: 400 }}> /24h</span></div>
      <div className="tnum" style={{ fontSize: 13, color: "var(--tx-2)" }}>{a.p50 ? a.p50 + "s" : "—"}</div>
      <div className="tnum" style={{ fontSize: 13, color: a.errRate > 3 ? "var(--danger)" : a.errRate > 1 ? "var(--warn)" : "var(--tx-2)" }}>{a.status === "paused" ? "—" : a.errRate + "%"}</div>
      <Spark data={a.spark} tone={a.color === "mute" ? "mute" : a.color} w={92} h={26} />
      <Icon d="chevR" size={16} style={{ color: h ? "var(--tx-2)" : "var(--tx-4)" }} />
    </div>
  );
}

function OverviewScreen({ onOpenAgent, onNew }) {
  const { AGENTS } = window.AR_DATA;
  const [env, setEnv] = useStateO("all");
  const filtered = AGENTS.filter((a) => env === "all" || (env === "prod" ? a.env === "production" : a.env === "staging"));
  return (
    <div className="fade-up" style={{ padding: "22px 24px 60px", maxWidth: 1180, margin: "0 auto" }}>
      {/* metric strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 26 }}>
        <MetricCard label="Runs today" value="2,754" delta="▲ 14%" deltaTone="ok" data={[18,22,19,28,24,31,35,30,38,42,39,48]} tone="ok" />
        <MetricCard label="Active agents" value="4" unit="/ 5" delta="1 degraded" deltaTone="warn" data={[4,4,4,4,4,3,4,4,4,4,4,4]} tone="info" />
        <MetricCard label="p50 latency" value="3.4" unit="s" delta="▼ 0.3s" deltaTone="ok" data={[5,4,5,4,4,3,4,3,3,4,3,3]} tone="info" />
        <MetricCard label="Pending approvals" value="4" delta="2 high risk" deltaTone="warn" data={[1,2,1,3,2,4,3,5,4,3,4,4]} tone="warn" />
      </div>

      {/* table header row */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, letterSpacing: "-.01em" }}>Agents</h2>
          <Badge tone="mute">{filtered.length}</Badge>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Tabs tabs={[{ id: "all", label: "All" }, { id: "prod", label: "Production" }, { id: "staging", label: "Staging" }]} value={env} onChange={setEnv} />
          <Btn variant="default" icon="filter" size="md">Filter</Btn>
          <Btn variant="primary" icon="plus" size="md" onClick={onNew}>New agent</Btn>
        </div>
      </div>

      <Card pad={false} style={{ overflow: "hidden" }}>
        <div style={{
          display: "grid", gridTemplateColumns: "minmax(220px,2fr) 120px 100px 92px 96px 100px 40px", gap: 14,
          padding: "0 16px", height: 38, alignItems: "center", borderBottom: "1px solid var(--line)",
          fontSize: 11, fontWeight: 600, letterSpacing: ".05em", textTransform: "uppercase", color: "var(--tx-4)", background: "var(--bg-inset)",
        }}>
          <span>Agent</span><span>Model</span><span>Runs</span><span>p50</span><span>Error</span><span>Trend</span><span></span>
        </div>
        {filtered.map((a) => <AgentRow key={a.id} a={a} onOpen={onOpenAgent} />)}
      </Card>
    </div>
  );
}

window.OverviewScreen = OverviewScreen;
