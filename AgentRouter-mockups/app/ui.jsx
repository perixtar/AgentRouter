// ui.jsx — shared primitives, icons, shell chrome
const { useState, useEffect, useRef, useCallback } = React;

/* ── Icons: minimal 1.6 stroke line set ─────────────────────────── */
const I = {
  agents: "M4 7l8-4 8 4-8 4-8-4zm0 5l8 4 8-4m-16 5l8 4 8-4",
  key: "M14 9a4 4 0 10-3.5 3.97L11 14l2 0 0 2 2 0 0 2 2.5 0 0-2.5L14 12.5A4 4 0 0014 9z",
  runs: "M3 12h4l2 6 4-14 2 8h6",
  approvals: "M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3zm-2.5 8.5L11.5 14l4-4.5",
  tools: "M14.5 5.5a3.5 3.5 0 01-4.6 4.6L5 15l-1.5 3.5L7 17l4.9-4.9a3.5 3.5 0 004.6-4.6L14 9l-2 0 0-2 2.5-1.5z",
  providers: "M5 4h14v5H5V4zm0 7h14v5H5v-5zm2-5.5v2m0 5v2",
  audit: "M5 3h9l5 5v13H5V3zm9 0v5h5M8 13h8M8 17h5",
  settings: "M12 9a3 3 0 100 6 3 3 0 000-6zm9 3l-2 .5-.6 1.5 1 1.8-1.4 1.4-1.8-1-1.5.6L14 21h-2l-.5-2-1.5-.6-1.8 1-1.4-1.4 1-1.8L7 14.5 5 14v-2l2-.5.6-1.5-1-1.8 1.4-1.4 1.8 1 1.5-.6L10 4h2l.5 2 1.5.6 1.8-1 1.4 1.4-1 1.8.6 1.5 2 .5z",
  search: "M11 4a7 7 0 105 11.9L20 20M11 4a7 7 0 014.9 11.9A7 7 0 0111 4z",
  copy: "M9 9h9v11H9V9zm-3 6H4V4h11v2",
  check: "M5 12.5l4.5 4.5L19 7",
  chevR: "M9 6l6 6-6 6",
  chevD: "M6 9l6 6 6-6",
  play: "M7 4l13 8-13 8V4z",
  pause: "M8 5v14M16 5v14",
  plus: "M12 5v14M5 12h14",
  ext: "M14 5h5v5M19 5l-8 8M11 5H5v14h14v-6",
  dot: "M12 12m-3 0a3 3 0 106 0 3 3 0 10-6 0",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zm10 3a3 3 0 100-6 3 3 0 000 6z",
  bolt: "M13 2L4 14h6l-1 8 9-12h-6l1-8z",
  x: "M6 6l12 12M18 6L6 18",
  refresh: "M20 11a8 8 0 10-2 6m2 2v-5h-5",
  model: "M12 4a3 3 0 013 3 3 3 0 010 6 3 3 0 01-6 0 3 3 0 010-6 3 3 0 013-3zm0 13v3M9 19h6",
  mcp: "M4 12h4l3-8 3 16 3-8h2",
  input: "M4 12h12m0 0l-4-4m4 4l-4 4M20 4v16",
  filter: "M4 5h16l-6 7v6l-4 2v-8L4 5z",
  arrowUp: "M12 19V5m0 0l-6 6m6-6l6 6",
  arrowDn: "M12 5v14m0 0l6-6m-6 6l-6-6",
  clock: "M12 3a9 9 0 100 18 9 9 0 000-18zm0 4v5l3 2",
  link: "M9 15l6-6m-4-1l1.5-1.5a3.5 3.5 0 015 5L16 17m-8-2l-1.5 1.5a3.5 3.5 0 01-5-5L4 9",
};
function Icon({ d, size = 16, sw = 1.6, fill = false, style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"
      style={{ display: "block", flex: "none", ...style }}>
      <path d={I[d] || d} fill={fill ? "currentColor" : "none"} stroke={fill ? "none" : "currentColor"} />
    </svg>
  );
}

/* ── Status dot ─────────────────────────────────────────────────── */
const TONE = {
  ok: "var(--ok)", warn: "var(--warn)", danger: "var(--danger)", info: "var(--info)",
  mute: "var(--tx-4)", live: "var(--acc)",
};
function Dot({ tone = "ok", pulse = false, size = 7 }) {
  return (
    <span style={{
      width: size, height: size, borderRadius: 99, flex: "none",
      background: TONE[tone] || tone, display: "inline-block",
      boxShadow: `0 0 0 3px color-mix(in oklch, ${TONE[tone] || tone} 18%, transparent)`,
      animation: pulse ? "pulse-dot 1.4s var(--ease) infinite" : "none",
    }} />
  );
}

/* ── Badge ──────────────────────────────────────────────────────── */
function Badge({ children, tone = "mute", solid = false, mono = false, style }) {
  const c = TONE[tone] || tone;
  return (
    <span className={mono ? "mono" : ""} style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      height: 21, padding: "0 8px", borderRadius: 6, fontSize: 11.5, fontWeight: 540,
      letterSpacing: mono ? 0 : ".01em", lineHeight: 1, whiteSpace: "nowrap",
      color: solid ? "var(--bg)" : c,
      background: solid ? c : `color-mix(in oklch, ${c} 13%, transparent)`,
      border: `1px solid ${solid ? "transparent" : `color-mix(in oklch, ${c} 26%, transparent)`}`,
      ...style,
    }}>{children}</span>
  );
}

/* ── Button ─────────────────────────────────────────────────────── */
function Btn({ children, icon, variant = "default", size = "md", onClick, style, title, disabled }) {
  const [h, setH] = useState(false);
  const heights = { sm: 28, md: 34, lg: 40 };
  const pads = { sm: "0 10px", md: "0 13px", lg: "0 18px" };
  const base = {
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7,
    height: heights[size], padding: pads[size], borderRadius: 7, fontSize: size === "sm" ? 12.5 : 13.5,
    fontWeight: 540, cursor: disabled ? "not-allowed" : "pointer", whiteSpace: "nowrap",
    letterSpacing: "-.005em", transition: "all .14s var(--ease)", opacity: disabled ? 0.45 : 1,
    border: "1px solid transparent", userSelect: "none",
  };
  const variants = {
    primary: { background: h ? "color-mix(in oklch, var(--acc) 90%, white)" : "var(--acc)", color: "var(--acc-ink)" },
    default: { background: h ? "var(--bg-3)" : "var(--bg-2)", color: "var(--tx)", borderColor: "var(--line)" },
    ghost: { background: h ? "var(--bg-2)" : "transparent", color: "var(--tx-2)" },
    danger: { background: h ? "color-mix(in oklch, var(--danger) 16%, transparent)" : "transparent", color: "var(--danger)", borderColor: "color-mix(in oklch, var(--danger) 34%, transparent)" },
    okgh: { background: h ? "var(--acc-soft)" : "transparent", color: "var(--acc)", borderColor: "var(--acc-line)" },
  };
  return (
    <button title={title} disabled={disabled} onClick={disabled ? undefined : onClick}
      onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      style={{ ...base, ...variants[variant], ...style }}>
      {icon && <Icon d={icon} size={size === "sm" ? 14 : 15} />}
      {children}
    </button>
  );
}

/* ── IconButton ─────────────────────────────────────────────────── */
function IconBtn({ icon, onClick, title, active, size = 32, dsize = 16, style }) {
  const [h, setH] = useState(false);
  return (
    <button title={title} onClick={onClick} onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      style={{
        width: size, height: size, borderRadius: 7, display: "grid", placeItems: "center",
        cursor: "pointer", border: "1px solid", flex: "none",
        borderColor: active ? "var(--acc-line)" : (h ? "var(--line)" : "transparent"),
        background: active ? "var(--acc-soft)" : (h ? "var(--bg-2)" : "transparent"),
        color: active ? "var(--acc)" : (h ? "var(--tx)" : "var(--tx-3)"),
        transition: "all .14s var(--ease)", ...style,
      }}>
      <Icon d={icon} size={dsize} />
    </button>
  );
}

/* ── Sparkline ──────────────────────────────────────────────────── */
function Spark({ data, w = 88, h = 26, tone = "ok" }) {
  const max = Math.max(...data, 1), min = Math.min(...data);
  const rng = max - min || 1;
  const pts = data.map((v, i) => [
    (i / (data.length - 1)) * w,
    h - 2 - ((v - min) / rng) * (h - 4),
  ]);
  const dPath = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const c = TONE[tone] || tone;
  return (
    <svg width={w} height={h} style={{ display: "block", overflow: "visible" }}>
      <path d={`${dPath} L${w} ${h} L0 ${h} Z`} fill={`color-mix(in oklch, ${c} 12%, transparent)`} stroke="none" />
      <path d={dPath} fill="none" stroke={c} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ── Mini bars (for big metrics) ────────────────────────────────── */
function Bars({ data, w = 120, h = 34, tone = "ok" }) {
  const max = Math.max(...data, 1);
  const bw = w / data.length;
  const c = TONE[tone] || tone;
  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      {data.map((v, i) => {
        const bh = Math.max(2, (v / max) * (h - 2));
        return <rect key={i} x={i * bw + bw * 0.18} y={h - bh} width={bw * 0.64} height={bh}
          rx="1.2" fill={i === data.length - 1 ? c : `color-mix(in oklch, ${c} 38%, transparent)`} />;
      })}
    </svg>
  );
}

/* ── Card ───────────────────────────────────────────────────────── */
function Card({ children, style, pad = true, hover = false, onClick }) {
  const [h, setH] = useState(false);
  return (
    <div onClick={onClick} onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      style={{
        background: "var(--bg-1)", border: "1px solid var(--line-soft)", borderRadius: "var(--r-lg)",
        boxShadow: hover && h ? "var(--shadow)" : "none",
        borderColor: hover && h ? "var(--line)" : "var(--line-soft)",
        transition: "all .16s var(--ease)", cursor: onClick ? "pointer" : "default",
        padding: pad ? "var(--pad)" : 0, ...style,
      }}>{children}</div>
  );
}

/* ── Section title ──────────────────────────────────────────────── */
function Eyebrow({ children, style }) {
  return <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".07em", textTransform: "uppercase", color: "var(--tx-4)", ...style }}>{children}</div>;
}

/* ── KV row ─────────────────────────────────────────────────────── */
function KV({ k, v, mono }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 16, padding: "7px 0", borderBottom: "1px solid var(--line-soft)", fontSize: 13 }}>
      <span style={{ color: "var(--tx-3)" }}>{k}</span>
      <span className={mono ? "mono" : ""} style={{ color: "var(--tx)", fontWeight: 500, textAlign: "right" }}>{v}</span>
    </div>
  );
}

/* ── Copy button (inline) ───────────────────────────────────────── */
function Copy({ text, label, size = "sm" }) {
  const [done, setDone] = useState(false);
  const click = () => { try { navigator.clipboard?.writeText(text); } catch (e) {} setDone(true); setTimeout(() => setDone(false), 1400); };
  return (
    <Btn size={size} variant="ghost" icon={done ? "check" : "copy"} onClick={click}
      style={done ? { color: "var(--acc)" } : undefined}>
      {label != null ? (done ? "Copied" : label) : null}
    </Btn>
  );
}

/* ── Segmented tabs ─────────────────────────────────────────────── */
function Tabs({ tabs, value, onChange, style }) {
  return (
    <div style={{ display: "inline-flex", gap: 2, padding: 3, background: "var(--bg-inset)", border: "1px solid var(--line-soft)", borderRadius: 9, ...style }}>
      {tabs.map((t) => {
        const k = typeof t === "string" ? t : t.id;
        const lbl = typeof t === "string" ? t : t.label;
        const on = value === k;
        return (
          <button key={k} onClick={() => onChange(k)} style={{
            height: 28, padding: "0 12px", borderRadius: 6, fontSize: 12.5, fontWeight: 540, cursor: "pointer",
            border: "none", whiteSpace: "nowrap", transition: "all .14s var(--ease)",
            display: "inline-flex", alignItems: "center", gap: 6,
            background: on ? "var(--bg-2)" : "transparent", color: on ? "var(--tx)" : "var(--tx-3)",
            boxShadow: on ? "var(--shadow)" : "none",
          }}>{lbl}</button>
        );
      })}
    </div>
  );
}

/* ── Sidebar ────────────────────────────────────────────────────── */
const NAV = [
  { id: "overview", label: "Agents", icon: "agents" },
  { id: "keys", label: "API Keys", icon: "key", badge: "Quickstart" },
  { id: "runs", label: "Runs", icon: "runs" },
  { id: "approvals", label: "Approvals", icon: "approvals" },
];
const NAV2 = [
  { id: "tools", label: "Tools & MCP", icon: "tools" },
  { id: "providers", label: "Providers", icon: "providers" },
  { id: "audit", label: "Audit log", icon: "audit" },
];

function Sidebar({ route, setRoute, pendingApprovals }) {
  const NavItem = ({ item }) => {
    const on = route === item.id;
    const [h, setH] = useState(false);
    const count = item.id === "approvals" ? pendingApprovals : 0;
    return (
      <button onClick={() => setRoute(item.id)} onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
        style={{
          display: "flex", alignItems: "center", gap: 10, width: "100%", height: 34, padding: "0 9px",
          borderRadius: 7, cursor: "pointer", border: "none", textAlign: "left", position: "relative",
          background: on ? "var(--bg-2)" : (h ? "var(--bg-1)" : "transparent"),
          color: on ? "var(--tx)" : (h ? "var(--tx)" : "var(--tx-3)"),
          transition: "all .13s var(--ease)", fontSize: 13.5, fontWeight: on ? 560 : 480,
        }}>
        {on && <span style={{ position: "absolute", left: -9, top: 8, bottom: 8, width: 2.5, borderRadius: 9, background: "var(--acc)" }} />}
        <Icon d={item.icon} size={17} style={{ color: on ? "var(--acc)" : "inherit" }} />
        <span style={{ flex: 1 }}>{item.label}</span>
        {count > 0 && <Badge tone="warn" style={{ height: 18, padding: "0 6px", fontSize: 11 }}>{count}</Badge>}
        {item.badge && !count && <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".04em", color: "var(--acc)", opacity: on || h ? 1 : 0, transition: "opacity .15s" }}>↗</span>}
      </button>
    );
  };
  return (
    <aside style={{
      width: 232, flex: "none", background: "var(--bg)", borderRight: "1px solid var(--line-soft)",
      display: "flex", flexDirection: "column", padding: "14px 13px 12px",
    }}>
      {/* brand */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 6px 14px" }}>
        <div style={{ width: 27, height: 27, borderRadius: 7, background: "var(--acc)", display: "grid", placeItems: "center", flex: "none", boxShadow: "0 2px 8px var(--acc-soft)" }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--acc-ink)" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 6h6m8 0h-3M5 18h3m11 0h-6M5 12h14" /><circle cx="14" cy="6" r="2.3" fill="var(--acc-ink)" stroke="none" /><circle cx="10" cy="18" r="2.3" fill="var(--acc-ink)" stroke="none" /><circle cx="6" cy="12" r="2.3" fill="var(--acc-ink)" stroke="none" />
          </svg>
        </div>
        <div style={{ lineHeight: 1.1 }}>
          <div style={{ fontSize: 14.5, fontWeight: 640, letterSpacing: "-.02em" }}>AgentRouter</div>
          <div style={{ fontSize: 10.5, color: "var(--tx-4)", fontWeight: 500, letterSpacing: ".02em" }}>control plane</div>
        </div>
      </div>

      {/* env switcher */}
      <button style={{
        display: "flex", alignItems: "center", gap: 8, width: "100%", height: 36, padding: "0 10px", marginBottom: 14,
        borderRadius: 8, border: "1px solid var(--line)", background: "var(--bg-1)", cursor: "pointer", color: "var(--tx)",
      }}>
        <Dot tone="ok" size={7} />
        <div style={{ flex: 1, textAlign: "left", lineHeight: 1.15 }}>
          <div style={{ fontSize: 12.5, fontWeight: 560 }}>Acme Inc</div>
          <div style={{ fontSize: 10.5, color: "var(--tx-4)" }}>production · us-east</div>
        </div>
        <Icon d="chevD" size={14} style={{ color: "var(--tx-4)" }} />
      </button>

      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {NAV.map((n) => <NavItem key={n.id} item={n} />)}
      </div>
      <div style={{ height: 1, background: "var(--line-soft)", margin: "14px 6px" }} />
      <Eyebrow style={{ padding: "0 9px 8px" }}>Configure</Eyebrow>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {NAV2.map((n) => <NavItem key={n.id} item={n} />)}
      </div>

      <div style={{ flex: 1 }} />
      {/* docs / usage card */}
      <div style={{ background: "var(--bg-1)", border: "1px solid var(--line-soft)", borderRadius: 10, padding: 12, marginBottom: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
          <span style={{ fontSize: 11.5, color: "var(--tx-3)", fontWeight: 540, whiteSpace: "nowrap" }}>Run usage</span>
          <span className="mono" style={{ fontSize: 11, color: "var(--tx-4)" }}>68%</span>
        </div>
        <div style={{ height: 5, borderRadius: 9, background: "var(--bg-3)", overflow: "hidden" }}>
          <div style={{ width: "68%", height: "100%", background: "var(--acc)", borderRadius: 9 }} />
        </div>
        <div style={{ fontSize: 11, color: "var(--tx-4)", marginTop: 7 }}>2.7M / 4.0M runs · resets Jun 1</div>
      </div>
      <button style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", padding: "7px 8px", borderRadius: 8, border: "none", background: "transparent", cursor: "pointer", color: "var(--tx-2)" }}>
        <div style={{ width: 26, height: 26, borderRadius: 7, background: "var(--bg-3)", display: "grid", placeItems: "center", fontSize: 11.5, fontWeight: 600, color: "var(--tx-2)" }}>DK</div>
        <div style={{ flex: 1, textAlign: "left", lineHeight: 1.2 }}>
          <div style={{ fontSize: 12.5, fontWeight: 540, color: "var(--tx)" }}>Dana Kim</div>
          <div style={{ fontSize: 10.5, color: "var(--tx-4)" }}>dana@acme.io</div>
        </div>
        <Icon d="settings" size={15} style={{ color: "var(--tx-4)" }} />
      </button>
    </aside>
  );
}

/* ── Topbar ─────────────────────────────────────────────────────── */
function TopBar({ title, sub, crumbs, actions, theme, onTheme }) {
  return (
    <header style={{
      height: 56, flex: "none", borderBottom: "1px solid var(--line-soft)", background: "color-mix(in oklch, var(--bg) 86%, transparent)",
      backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)", display: "flex", alignItems: "center", padding: "0 22px", gap: 16, position: "sticky", top: 0, zIndex: 20,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {crumbs && <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11.5, color: "var(--tx-4)", marginBottom: 1, whiteSpace: "nowrap", overflow: "hidden" }}>
          {crumbs.map((c, i) => <React.Fragment key={i}>{i > 0 && <Icon d="chevR" size={11} />}<span style={{ color: i === crumbs.length - 1 ? "var(--tx-2)" : "var(--tx-4)" }}>{c}</span></React.Fragment>)}
        </div>}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "nowrap" }}>
          <h1 style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-.02em", whiteSpace: "nowrap" }}>{title}</h1>
          {sub}
        </div>
      </div>
      {/* search */}
      <button style={{
        display: "flex", alignItems: "center", gap: 8, height: 33, padding: "0 11px 0 10px", borderRadius: 8,
        border: "1px solid var(--line-soft)", background: "var(--bg-1)", cursor: "pointer", color: "var(--tx-4)", minWidth: 190,
      }}>
        <Icon d="search" size={15} />
        <span style={{ fontSize: 12.5, flex: 1, textAlign: "left" }}>Search or jump to…</span>
        <kbd className="mono" style={{ fontSize: 10.5, padding: "2px 5px", borderRadius: 4, background: "var(--bg-3)", color: "var(--tx-3)" }}>⌘K</kbd>
      </button>
      <IconBtn icon={theme === "dark" ? "bolt" : "model"} onClick={onTheme} title="Toggle theme" />
      {actions}
    </header>
  );
}

/* ── JSON viewer (compact, syntax-tinted) ───────────────────────── */
function Json({ value, indent = 0 }) {
  const pad = { paddingLeft: indent * 14 };
  if (value === null) return <span style={{ color: "var(--tx-4)" }}>null</span>;
  if (typeof value === "boolean") return <span style={{ color: "var(--info)" }}>{String(value)}</span>;
  if (typeof value === "number") return <span style={{ color: "var(--warn)" }}>{value}</span>;
  if (typeof value === "string") return <span style={{ color: "var(--acc)" }}>"{value}"</span>;
  if (Array.isArray(value)) {
    return <span>[{value.map((v, i) => <span key={i}>{i ? ", " : ""}<Json value={v} /></span>)}]</span>;
  }
  return (
    <span>{"{"}
      {Object.entries(value).map(([k, v], i) => (
        <div key={k} style={{ ...pad, paddingLeft: (indent + 1) * 14 }}>
          <span style={{ color: "var(--tx-2)" }}>{k}</span><span style={{ color: "var(--tx-4)" }}>: </span><Json value={v} indent={indent + 1} />{i < Object.keys(value).length - 1 ? "," : ""}
        </div>
      ))}
      <div style={pad}>{"}"}</div>
    </span>
  );
}

Object.assign(window, { Icon, I, Dot, Badge, Btn, IconBtn, Spark, Bars, Card, Eyebrow, KV, Copy, Tabs, Sidebar, TopBar, Json, TONE, NAV });
