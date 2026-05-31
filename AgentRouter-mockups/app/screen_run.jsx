// screen_run.jsx — Live run inspector (steps, traces, playback)
const { useState: useStateR, useEffect: useEffectR, useRef: useRefR } = React;

const STEP_META = {
  input: { icon: "input", tone: "mute", k: "INPUT" },
  model: { icon: "model", tone: "info", k: "MODEL" },
  tool: { icon: "tools", tone: "ok", k: "TOOL" },
  mcp: { icon: "mcp", tone: "ok", k: "MCP" },
  approval: { icon: "approvals", tone: "warn", k: "APPROVAL" },
  pending: { icon: "clock", tone: "mute", k: "QUEUED" },
  output: { icon: "arrowDn", tone: "ok", k: "OUTPUT" },
};
const RUN_STATUS = {
  live: { tone: "live", label: "Live", pulse: true },
  awaiting: { tone: "warn", label: "Awaiting approval", pulse: true },
  ok: { tone: "ok", label: "Completed", pulse: false },
  error: { tone: "danger", label: "Error", pulse: false },
};

function RunListItem({ r, active, onClick }) {
  const [h, setH] = useStateR(false);
  const st = RUN_STATUS[r.status];
  return (
    <button onClick={onClick} onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      style={{ display: "block", width: "100%", textAlign: "left", padding: "10px 13px", border: "none", borderBottom: "1px solid var(--line-soft)", cursor: "pointer", position: "relative",
        background: active ? "var(--bg-2)" : (h ? "var(--bg-1)" : "transparent"), transition: "background .12s" }}>
      {active && <span style={{ position: "absolute", left: 0, top: 8, bottom: 8, width: 2.5, background: "var(--acc)", borderRadius: 9 }} />}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <Dot tone={st.tone} pulse={st.pulse} size={7} />
        <span className="mono" style={{ fontSize: 12.5, fontWeight: 540, color: "var(--tx)" }}>{r.id}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: "var(--tx-4)" }}>{r.started}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 7, paddingLeft: 15 }}>
        <span className="mono" style={{ fontSize: 11.5, color: "var(--tx-3)" }}>{r.agent}</span>
        <span style={{ fontSize: 10.5, color: "var(--tx-4)", display: "flex", alignItems: "center", gap: 4 }}>
          <Icon d={r.trigger === "api" ? "link" : "clock"} size={11} />{r.dur || "running"}
        </span>
      </div>
    </button>
  );
}

function StepRow({ step, idx, active, shown, onClick, isLast }) {
  const m = STEP_META[step.type];
  const [h, setH] = useStateR(false);
  return (
    <div onClick={() => step.body && onClick(idx)} onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      style={{ display: "flex", gap: 13, cursor: step.body ? "pointer" : "default", position: "relative", animation: shown ? "streamIn .3s var(--ease) both" : "none", opacity: 1 }}>
      {/* rail */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: "none", width: 30 }}>
        <div style={{ width: 30, height: 30, borderRadius: 9, display: "grid", placeItems: "center", flex: "none", zIndex: 1,
          background: active ? "var(--acc-soft)" : "var(--bg-2)", border: `1px solid ${active ? "var(--acc-line)" : "var(--line)"}`,
          color: step.type === "approval" ? "var(--warn)" : (active ? "var(--acc)" : "var(--tx-3)") }}>
          {step.type === "pending" ? <Icon d="clock" size={15} style={{ opacity: .6 }} /> : <Icon d={m.icon} size={15} />}
        </div>
        {!isLast && <div style={{ width: 1.5, flex: 1, minHeight: 18, background: "var(--line)", margin: "2px 0" }} />}
      </div>
      {/* card */}
      <div style={{ flex: 1, paddingBottom: 14 }}>
        <div style={{ padding: "10px 13px", borderRadius: 10, border: `1px solid ${active ? "var(--acc-line)" : (h && step.body ? "var(--line)" : "var(--line-soft)")}`,
          background: active ? "var(--acc-soft)" : (h && step.body ? "var(--bg-1)" : "var(--bg-1)"), transition: "all .14s", opacity: step.type === "pending" ? .6 : 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <Badge tone={m.tone} mono style={{ height: 18, padding: "0 6px", fontSize: 9.5, letterSpacing: ".06em" }}>{m.k}</Badge>
            <span className="mono" style={{ fontSize: 13, fontWeight: 540, color: "var(--tx)", whiteSpace: "nowrap" }}>{step.label}</span>
            <span style={{ flex: 1 }} />
            {step.tokens && <span className="mono" style={{ fontSize: 10.5, color: "var(--tx-4)", whiteSpace: "nowrap" }}>{step.tokens}</span>}
            {step.dur && <span className="mono tnum" style={{ fontSize: 11, color: "var(--tx-3)", padding: "2px 6px", borderRadius: 5, background: "var(--bg-inset)" }}>{step.dur}</span>}
          </div>
          <div style={{ fontSize: 12, color: "var(--tx-3)", marginTop: 5, paddingLeft: 2 }}>{step.detail}</div>
        </div>
      </div>
    </div>
  );
}

function DetailPanel({ step, onApprove, onDeny, resolved }) {
  if (!step) return (
    <div style={{ display: "grid", placeItems: "center", height: "100%", color: "var(--tx-4)", textAlign: "center", padding: 30 }}>
      <div>
        <Icon d="runs" size={26} style={{ margin: "0 auto 12px", opacity: .5 }} />
        <div style={{ fontSize: 13 }}>Select a step to inspect<br />its inputs, outputs and timing.</div>
      </div>
    </div>
  );
  const m = STEP_META[step.type];
  return (
    <div className="fade-up" key={step.id} style={{ padding: 16, overflowY: "auto", height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 14 }}>
        <Badge tone={m.tone} mono style={{ height: 19 }}>{m.k}</Badge>
        <span className="mono" style={{ fontSize: 13.5, fontWeight: 560 }}>{step.label}</span>
      </div>
      <div style={{ marginBottom: 16 }}>
        <KV k="Status" v={<Badge tone={m.tone}>{step.type === "approval" ? "Awaiting approval" : "Succeeded"}</Badge>} />
        {step.dur && <KV k="Duration" v={step.dur} mono />}
        {step.tokens && <KV k="Tokens" v={step.tokens} mono />}
      </div>

      {step.type === "approval" && !resolved && (
        <div style={{ padding: 13, borderRadius: 11, border: "1px solid color-mix(in oklch, var(--warn) 30%, transparent)", background: "color-mix(in oklch, var(--warn) 9%, transparent)", marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
            <Icon d="approvals" size={16} style={{ color: "var(--warn)" }} />
            <span style={{ fontSize: 13, fontWeight: 580 }}>Human approval required</span>
          </div>
          <div style={{ fontSize: 12, color: "var(--tx-2)", lineHeight: 1.5, marginBottom: 12 }}>{step.body.reason}</div>
          <div style={{ display: "flex", gap: 9 }}>
            <Btn variant="primary" icon="check" size="md" style={{ flex: 1 }} onClick={onApprove}>Approve</Btn>
            <Btn variant="danger" icon="x" size="md" onClick={onDeny}>Deny</Btn>
          </div>
        </div>
      )}
      {step.type === "approval" && resolved === "approved" && (
        <div style={{ padding: "11px 13px", borderRadius: 10, border: "1px solid var(--acc-line)", background: "var(--acc-soft)", color: "var(--acc)", fontSize: 12.5, fontWeight: 540, display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}><Icon d="check" size={15} />Approved · agent resumed</div>
      )}
      {step.type === "approval" && resolved === "denied" && (
        <div style={{ padding: "11px 13px", borderRadius: 10, border: "1px solid color-mix(in oklch, var(--danger) 34%, transparent)", background: "color-mix(in oklch, var(--danger) 12%, transparent)", color: "var(--danger)", fontSize: 12.5, fontWeight: 540, display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}><Icon d="x" size={15} />Denied · agent halted</div>
      )}

      {step.body && (
        <div>
          <Eyebrow style={{ marginBottom: 8 }}>{step.type === "approval" ? "Action payload" : "Payload"}</Eyebrow>
          <pre className="mono" style={{ margin: 0, padding: 13, fontSize: 11.5, lineHeight: 1.7, background: "var(--bg-inset)", border: "1px solid var(--line)", borderRadius: 10, overflowX: "auto" }}>
            <Json value={step.body} />
          </pre>
        </div>
      )}
    </div>
  );
}

function RunScreen({ approveSignal, onApproveAction }) {
  const { RUNS, LIVE_STEPS } = window.AR_DATA;
  const [runId, setRunId] = useStateR(RUNS[0].id);
  const run = RUNS.find((r) => r.id === runId);
  const isLive = run.status === "live" || run.status === "awaiting";
  const [shown, setShown] = useStateR(isLive ? 1 : LIVE_STEPS.length);
  const [sel, setSel] = useStateR(null);
  const [playing, setPlaying] = useStateR(true);
  const [resolved, setResolved] = useStateR(null);
  const scrollRef = useRefR(null);

  // reset when switching runs
  useEffectR(() => {
    const live = run.status === "live" || run.status === "awaiting";
    setShown(live ? 1 : LIVE_STEPS.length);
    setSel(null); setResolved(null); setPlaying(true);
  }, [runId]);

  // stream steps for live runs (stop at the approval gate = idx 5 -> show 6)
  useEffectR(() => {
    if (!isLive || !playing) return;
    const gate = 6; // pause once the approval step is visible
    if (shown >= gate) return;
    const id = setTimeout(() => setShown((s) => Math.min(s + 1, LIVE_STEPS.length)), 900);
    return () => clearTimeout(id);
  }, [shown, playing, isLive]);

  const steps = LIVE_STEPS.slice(0, shown);
  const selStep = sel != null ? LIVE_STEPS[sel] : null;

  const approve = () => {
    setResolved("approved"); onApproveAction && onApproveAction();
    // resume: reveal remaining steps
    setTimeout(() => setShown(LIVE_STEPS.length), 400);
  };
  const deny = () => setResolved("denied");

  const st = RUN_STATUS[run.status];
  const liveActive = isLive && resolved == null;

  return (
    <div className="fade-up" style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {/* run list */}
      <div style={{ width: 256, flex: "none", borderRight: "1px solid var(--line-soft)", display: "flex", flexDirection: "column", background: "var(--bg)" }}>
        <div style={{ padding: "13px 13px 11px", borderBottom: "1px solid var(--line-soft)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Runs</span>
          <Tabs tabs={[{ id: "live", label: "Live" }, { id: "all", label: "All" }]} value="all" onChange={() => {}} style={{ transform: "scale(.92)" }} />
        </div>
        <div style={{ overflowY: "auto", flex: 1 }}>
          {RUNS.map((r) => <RunListItem key={r.id} r={r} active={r.id === runId} onClick={() => setRunId(r.id)} />)}
        </div>
      </div>

      {/* center: timeline */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", borderRight: "1px solid var(--line-soft)" }}>
        {/* run header */}
        <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--line-soft)", flex: "none" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 10 }}>
            <Dot tone={st.tone} pulse={st.pulse} size={8} />
            <span className="mono" style={{ fontSize: 15, fontWeight: 600 }}>{run.id}</span>
            <Badge tone={st.tone}>{liveActive ? st.label : (resolved === "approved" ? "Completed" : resolved === "denied" ? "Halted" : st.label)}</Badge>
            <span style={{ flex: 1 }} />
            {isLive && <IconBtn icon={playing ? "pause" : "play"} onClick={() => setPlaying(!playing)} title="Pause stream" active={playing} />}
            <Btn size="sm" variant="default" icon="ext">Logs</Btn>
            <Btn size="sm" variant="default" icon="refresh">Replay</Btn>
          </div>
          <div style={{ display: "flex", gap: 22, fontSize: 12 }}>
            {[["Agent", run.agent, true], ["Trigger", run.trigger + " · " + run.by, false], ["Tokens", run.tokens.toLocaleString(), false], ["Started", run.started, false]].map(([k, v, mono]) => (
              <div key={k} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ fontSize: 10.5, color: "var(--tx-4)", textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 600 }}>{k}</span>
                <span className={mono ? "mono" : ""} style={{ color: "var(--tx-2)", fontWeight: 500, whiteSpace: "nowrap" }}>{v}</span>
              </div>
            ))}
          </div>
        </div>
        {/* timeline */}
        <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "18px 20px 40px" }}>
          {steps.map((s, i) => <StepRow key={s.id} step={s} idx={i} shown={isLive && i === shown - 1} active={sel === i} onClick={setSel} isLast={i === LIVE_STEPS.length - 1 || (i === steps.length - 1 && liveActive && shown < LIVE_STEPS.length)} />)}
          {liveActive && shown < LIVE_STEPS.length && shown >= 6 && (
            <div style={{ display: "flex", gap: 13, alignItems: "center", paddingLeft: 0, color: "var(--tx-4)", fontSize: 12 }}>
              <div style={{ width: 30, display: "grid", placeItems: "center" }}><span style={{ width: 7, height: 7, borderRadius: 99, background: "var(--warn)", animation: "pulse-dot 1.2s infinite" }} /></div>
              Paused at approval gate — resolve in the panel to resume.
            </div>
          )}
          {isLive && shown < 6 && (
            <div style={{ display: "flex", gap: 13, alignItems: "center", color: "var(--tx-4)", fontSize: 12 }}>
              <div style={{ width: 30, display: "grid", placeItems: "center" }}><span style={{ width: 14, height: 14, border: "1.5px solid var(--line-strong)", borderTopColor: "var(--acc)", borderRadius: 99, animation: "spin .7s linear infinite" }} /></div>
              Streaming steps…
            </div>
          )}
        </div>
      </div>

      {/* right: detail */}
      <div style={{ width: 332, flex: "none", background: "var(--bg)" }}>
        <DetailPanel step={selStep} resolved={selStep && selStep.type === "approval" ? resolved : null} onApprove={approve} onDeny={deny} />
      </div>
    </div>
  );
}

window.RunScreen = RunScreen;
