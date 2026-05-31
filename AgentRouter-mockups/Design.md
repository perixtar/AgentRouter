# AgentRouter — Dashboard Design

> The operations / control plane for production AI agents.
> **Promise:** *Create an agent. Get an API key. Run it safely from your code. See every step.*

A developer-facing, clickable hi-fi prototype built as a single-page React app. It feels like serious devtools infrastructure — clear, dense, reliable, and calm — in the spirit of Daytona / Composio.

---

## 1. Who it's for

A developer, AI engineer, platform engineer, or technical founder who wants to run autonomous agents safely from their own app, CLI, backend service, or CI workflow. The UI assumes the reader lives in code and treats the dashboard as the *control plane* around their running agents — not a no-code builder.

---

## 2. Design system

### Aesthetic
Dark, terminal-leaning devtools with a calm, dense layout. Ships a full **light** theme as well. Nothing decorative earns its place by accident: monochrome surfaces, one accent, semantic status colors only where state matters.

### Type
| Role | Family | Notes |
|---|---|---|
| UI / sans | **Geist** | 300–700; tight `-0.005em` tracking, base 14px |
| Code / data | **Geist Mono** | IDs, keys, payloads, metrics; `ss01` + slashed zero |

Headings are 15–21px; body 12.5–14px; labels/eyebrows 11px uppercase with `.05–.07em` tracking. Numbers use tabular figures (`.tnum`) so columns align.

### Color tokens
Defined as CSS custom properties, themed via `[data-theme]` on `<html>`. Built in **OKLCH** so the two themes stay perceptually even.

- **Surfaces:** `--bg`, `--bg-1`, `--bg-2`, `--bg-3`, `--bg-inset` (a ramp from page → panel → card → elevated → sunken code wells).
- **Lines:** `--line-soft`, `--line`, `--line-strong`.
- **Text:** `--tx` → `--tx-4` (primary to faint).
- **Accent:** `--acc` (+ `--acc-ink`, `--acc-soft`, `--acc-line`). Used sparingly — primary CTAs, the live pulse, active nav, string literals in code.
- **Semantic status:** `--ok` (green), `--warn` (amber), `--danger` (red), `--info` (blue). These are *fixed* and independent of the accent so "healthy / degraded / error" always read the same.

### Accent (tweakable)
Four curated accents map to `[data-accent]`: **green** (default), **blue**, **orange**, **violet**. All share lightness/chroma and vary only in hue, so swapping never destabilizes the palette.

### Density (tweakable)
`compact / regular / comfy` adjust row height and padding via `--row-h` / `--pad`.

### Shape & motion
- Radii: 5 / 8 / 12 / 16px. Cards are 12px; pills/badges 6px.
- Shadows are near-absent in dark, soft in light — depth comes from the surface ramp, not drop shadows.
- Motion is restrained: a single `--ease` curve, **transform-only** entrances (content never depends on an animation to be visible), a pulsing dot for "live," and a streaming-step reveal.

### Iconography
A minimal 1.6px-stroke line set (`agents, key, runs, approvals, tools, mcp, model, providers, audit, …`), rendered from a shared `<Icon>`. No illustrative SVG.

---

## 3. Information architecture

```
Sidebar
├─ Acme Inc · production · us-east   (org / env switcher)
├─ Agents          → fleet overview + agents table
├─ API Keys        → keys + quickstart   ★ centerpiece
├─ Runs            → live run inspector
├─ Approvals  (n)  → human-in-the-loop queue
├─ Configure
│   ├─ Tools & MCP → connected MCP servers
│   ├─ Providers   → model provider credentials
│   └─ Audit log   → immutable event stream
├─ Run usage meter
└─ Account
```

Every screen sits in a persistent **shell**: a fixed left sidebar (nav + env switcher + usage + account) and a sticky **top bar** (breadcrumbs, title, contextual status badge, ⌘K search, theme toggle, per-screen actions).

---

## 4. Screens

### ★ API Keys & Quickstart — the centerpiece
Answers *"get an agent running from your code in under a minute."*

- **Keys table** — name, masked secret (`ar_live_7Qx••••••` with hover-copy), scopes as chips, usage, last-used, revoke.
- **Create-key flow** — modal to name + scope a key, then a **reveal-once** screen: a warning that the secret is shown a single time, a masked value with an eye toggle and copy, and "Done — I saved it." New keys append to the table.
- **Quickstart** — a 4-step rail (*Create key → Install SDK → Run from code → Inspect the run*) beside a sticky code panel with **Node / Python / cURL** tabs, syntax highlighting, and copy.
- **Streaming terminal** — replays a real run: POSTs the run, streams `input → model → tool → mcp`, then **pauses at an approval gate** and surfaces a **View full trace →** link into the Runs inspector.

### Agents — fleet overview
- Metric strip: *Runs today, Active agents, p50 latency, Pending approvals*, each with a mini bar chart and a delta badge.
- Dense agents table: status dot (healthy / degraded / paused, pulsing when live), name + env tag + description, model, runs/24h, p50, error rate (color-coded by threshold), and a sparkline trend. Filter by environment.

### Runs — live run inspector
A three-pane observability view:
- **Left** — run list with status, agent, trigger, age/duration.
- **Center** — run header (agent, trigger/source, tokens, started) + a **vertical step timeline**. Each step is typed (`INPUT / MODEL / TOOL / MCP / APPROVAL / QUEUED`) with duration and token counts. Live runs **stream steps in** and stop at the approval gate.
- **Right** — detail panel for the selected step: status, timing, and the raw payload as a tinted JSON tree. The approval step exposes **Approve / Deny** inline; approving **resumes** the stream.

### Approvals — human-in-the-loop queue
The safety brake. Pending requests list with risk tags (high / medium / low) and live age; a detail view showing the action, **the policy that triggered it**, the **agent's rationale**, and the raw action payload. **Approve & resume** / **Deny** resolve it, advance to the next item, decrement the sidebar badge, and drop into **History**.

### Configure
- **Tools & MCP** — connected MCP servers with status, tool count, latency.
- **Providers** — model-provider credentials (Anthropic / OpenAI / Bedrock) with status, model count, monthly spend.
- **Audit log** — immutable, color-coded stream of every action by every actor (agents and humans): runs, tool/MCP calls, approvals, key creation, failures.

---

## 5. Interaction model

- **Routing** — sidebar/top-bar driven; screens swap inside the shell (no page reloads).
- **Cross-screen flow** — quickstart terminal → Runs; agent row → Runs; approve actions decrement the live **Approvals** badge.
- **Live behaviors** — streaming run steps, the approval gate halt-and-resume, the replayable terminal, pulsing "live" indicators.
- **State** — create-key reveal, approve/deny resolution + history, run/step selection, terminal playback are all real React state.
- **Patterns** — master-detail (Runs, Approvals), reveal-once secret, segmented tabs, hover-revealed row actions, copy-to-clipboard with confirmation.

---

## 6. Tweaks (toolbar → Tweaks)

| Tweak | Options | Default |
|---|---|---|
| Theme | dark / light | dark |
| Accent | green / blue / orange / violet | green |
| Density | compact / regular / comfy | regular |

Theme is also toggleable from the top bar.

---

## 7. File structure

```
AgentRouter Dashboard.html      shell, design tokens, font loading, script order
app/
├─ tweaks-panel.jsx             tweak controls + host protocol (starter)
├─ data.jsx                     mock domain data (agents, keys, runs, steps, approvals…)
├─ ui.jsx                       primitives: Icon, Dot, Badge, Btn, Card, Spark, Tabs,
│                               Sidebar, TopBar, Json
├─ screen_overview.jsx          Agents + fleet metrics
├─ screen_keys.jsx              API Keys & Quickstart (code highlighter, terminal, modal)
├─ screen_run.jsx              Live run inspector
├─ screen_approvals.jsx         Approvals queue
└─ app.jsx                      shell, routing, theme/accent/density, secondary screens
```

Components share scope via `window` (each Babel `<script>` is isolated). Tokens drive every surface, so theme/accent/density changes cascade without per-component overrides.

---

## 8. Notes & next steps

- All content is **mock data** — no backend.
- Candidate follow-ups: an **agent-detail** view, a real **create-agent** flow, an explicit **"Review in queue"** link on a paused run step, MCP **connect** flow, and per-run cost/token analytics.
