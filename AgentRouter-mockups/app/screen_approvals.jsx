// screen_approvals.jsx — risky action approvals queue
const { useState: useStateA } = React;

const RISK = {
  high: { tone: "danger", label: "High risk" },
  medium: { tone: "warn", label: "Medium" },
  low: { tone: "info", label: "Low" },
};

function ApprovalListItem({ a, active, onClick, resolved }) {
  const [h, setH] = useStateA(false);
  const r = RISK[a.risk];
  return (
    <button onClick={onClick} onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      style={{ display: "block", width: "100%", textAlign: "left", padding: "13px 15px", border: "none", borderBottom: "1px solid var(--line-soft)", cursor: "pointer", position: "relative",
        opacity: resolved ? 0.5 : 1, background: active ? "var(--bg-2)" : (h ? "var(--bg-1)" : "transparent"), transition: "all .12s" }}>
      {active && <span style={{ position: "absolute", left: 0, top: 10, bottom: 10, width: 2.5, background: "var(--acc)", borderRadius: 9 }} />}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <Badge tone={r.tone} style={{ height: 18, fontSize: 10.5 }}>{r.label}</Badge>
        <span style={{ flex: 1 }} />
        {resolved ? <Badge tone={resolved === "approved" ? "ok" : "danger"} style={{ height: 18, fontSize: 10.5 }}>{resolved}</Badge>
          : <span style={{ fontSize: 11, color: "var(--tx-4)", display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 5, height: 5, borderRadius: 99, background: "var(--warn)", animation: "pulse-dot 1.4s infinite" }} />{a.age}</span>}
      </div>
      <div style={{ fontSize: 13, fontWeight: 540, color: "var(--tx)", marginBottom: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.title}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 7, whiteSpace: "nowrap", overflow: "hidden" }}>
        <span className="mono" style={{ fontSize: 11, color: "var(--acc)", overflow: "hidden", textOverflow: "ellipsis" }}>{a.action}</span>
      </div>
      <div className="mono" style={{ fontSize: 10.5, color: "var(--tx-4)", marginTop: 4 }}>{a.agent} · {a.run}</div>
    </button>
  );
}

function ApprovalDetail({ a, onApprove, onDeny, resolved }) {
  if (!a) return (
    <div style={{ display: "grid", placeItems: "center", height: "100%", color: "var(--tx-4)", textAlign: "center" }}>
      <div><Icon d="approvals" size={28} style={{ margin: "0 auto 12px", opacity: .5 }} /><div style={{ fontSize: 13 }}>Select a request to review.</div></div>
    </div>
  );
  const r = RISK[a.risk];
  return (
    <div className="fade-up" key={a.id} style={{ padding: 22, overflowY: "auto", height: "100%", maxWidth: 620 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <Badge tone={r.tone}>{r.label}</Badge>
        <span className="mono" style={{ fontSize: 12, color: "var(--tx-4)" }}>{a.run}</span>
      </div>
      <h2 style={{ fontSize: 21, fontWeight: 620, letterSpacing: "-.02em", marginBottom: 8 }}>{a.title}</h2>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 22 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "5px 11px", borderRadius: 8, background: "var(--acc-soft)", border: "1px solid var(--acc-line)" }}>
          <Icon d="tools" size={14} style={{ color: "var(--acc)" }} /><span className="mono" style={{ fontSize: 12.5, color: "var(--acc)", fontWeight: 540 }}>{a.action}</span>
        </span>
        <span style={{ fontSize: 12.5, color: "var(--tx-3)" }}>requested by <span className="mono">{a.agent}</span></span>
      </div>

      {/* policy callout */}
      <div style={{ display: "flex", gap: 11, padding: "13px 15px", borderRadius: 11, background: "var(--bg-1)", border: "1px solid var(--line)", marginBottom: 14 }}>
        <Icon d="approvals" size={17} style={{ color: "var(--warn)", marginTop: 1, flex: "none" }} />
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--tx-2)", marginBottom: 2 }}>Triggered policy</div>
          <div style={{ fontSize: 12.5, color: "var(--tx-3)", lineHeight: 1.5 }}>{a.rule}</div>
        </div>
      </div>

      {/* rationale */}
      <div style={{ display: "flex", gap: 11, padding: "13px 15px", borderRadius: 11, background: "var(--bg-1)", border: "1px solid var(--line)", marginBottom: 20 }}>
        <Icon d="model" size={17} style={{ color: "var(--info)", marginTop: 1, flex: "none" }} />
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--tx-2)", marginBottom: 2 }}>Agent rationale</div>
          <div style={{ fontSize: 12.5, color: "var(--tx-3)", lineHeight: 1.5 }}>{a.rationale}</div>
        </div>
      </div>

      {/* payload */}
      <Eyebrow style={{ marginBottom: 9 }}>Action payload</Eyebrow>
      <pre className="mono" style={{ margin: "0 0 24px", padding: 15, fontSize: 12, lineHeight: 1.75, background: "var(--bg-inset)", border: "1px solid var(--line)", borderRadius: 11, overflowX: "auto" }}>
        <Json value={a.args} />
      </pre>

      {/* actions */}
      {!resolved ? (
        <div style={{ display: "flex", gap: 11, position: "sticky", bottom: 0, paddingTop: 6 }}>
          <Btn variant="primary" icon="check" size="lg" style={{ flex: 1 }} onClick={onApprove}>Approve & resume</Btn>
          <Btn variant="danger" icon="x" size="lg" onClick={onDeny}>Deny</Btn>
          <Btn variant="ghost" size="lg">Edit</Btn>
        </div>
      ) : (
        <div style={{ padding: "13px 16px", borderRadius: 11, fontSize: 13, fontWeight: 540, display: "flex", alignItems: "center", gap: 9,
          border: `1px solid ${resolved === "approved" ? "var(--acc-line)" : "color-mix(in oklch, var(--danger) 34%, transparent)"}`,
          background: resolved === "approved" ? "var(--acc-soft)" : "color-mix(in oklch, var(--danger) 12%, transparent)",
          color: resolved === "approved" ? "var(--acc)" : "var(--danger)" }}>
          <Icon d={resolved === "approved" ? "check" : "x"} size={17} />
          {resolved === "approved" ? "Approved — the agent has resumed and executed this action." : "Denied — the agent was halted and the action discarded."}
        </div>
      )}
    </div>
  );
}

function ApprovalsScreen({ onResolve }) {
  const { APPROVALS, APPROVAL_HISTORY } = window.AR_DATA;
  const [sel, setSel] = useStateA(APPROVALS[0].id);
  const [resolved, setResolved] = useStateA({}); // id -> "approved"|"denied"
  const [tab, setTab] = useStateA("pending");

  const pending = APPROVALS.filter((a) => !resolved[a.id]);
  const cur = APPROVALS.find((a) => a.id === sel);

  const resolve = (decision) => {
    setResolved((r) => ({ ...r, [sel]: decision }));
    onResolve && onResolve();
    // advance to next pending
    const next = APPROVALS.find((a) => a.id !== sel && !resolved[a.id]);
    if (next) setTimeout(() => setSel(next.id), 650);
  };

  return (
    <div className="fade-up" style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {/* list */}
      <div style={{ width: 320, flex: "none", borderRight: "1px solid var(--line-soft)", display: "flex", flexDirection: "column", background: "var(--bg)" }}>
        <div style={{ padding: "13px 15px 12px", borderBottom: "1px solid var(--line-soft)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 11 }}>
            <span style={{ fontSize: 13.5, fontWeight: 600 }}>Approval queue</span>
            <Badge tone={pending.length ? "warn" : "ok"}>{pending.length} pending</Badge>
          </div>
          <Tabs tabs={[{ id: "pending", label: "Pending" }, { id: "history", label: "History" }]} value={tab} onChange={setTab} style={{ width: "100%", display: "flex" }} />
        </div>
        <div style={{ overflowY: "auto", flex: 1 }}>
          {tab === "pending" ? (
            APPROVALS.map((a) => <ApprovalListItem key={a.id} a={a} active={a.id === sel} resolved={resolved[a.id]} onClick={() => setSel(a.id)} />)
          ) : (
            <div>
              {APPROVAL_HISTORY.map((h) => (
                <div key={h.id} style={{ padding: "12px 15px", borderBottom: "1px solid var(--line-soft)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                    <Badge tone={h.decision === "approved" ? "ok" : "danger"} style={{ height: 18, fontSize: 10.5 }}>{h.decision}</Badge>
                    <span style={{ flex: 1 }} /><span style={{ fontSize: 11, color: "var(--tx-4)" }}>{h.age}</span>
                  </div>
                  <div style={{ fontSize: 12.5, fontWeight: 530, marginBottom: 3 }}>{h.title}</div>
                  <div className="mono" style={{ fontSize: 10.5, color: "var(--tx-4)" }}>{h.action} · by {h.by}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* detail */}
      <div style={{ flex: 1, minWidth: 0, background: "var(--bg)" }}>
        <ApprovalDetail a={cur} resolved={resolved[sel]} onApprove={() => resolve("approved")} onDeny={() => resolve("denied")} />
      </div>
    </div>
  );
}

window.ApprovalsScreen = ApprovalsScreen;
