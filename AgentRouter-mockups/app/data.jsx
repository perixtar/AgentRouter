// data.jsx — mock domain data for AgentRouter
// Exposed on window for the screen modules.

const AGENTS = [
  {
    id: "agt_7k2p", name: "support-triage", env: "production", status: "healthy",
    model: "claude-sonnet-4.5", desc: "Triages inbound tickets, drafts replies, escalates refunds.",
    runs24h: 1842, p50: 2.1, errRate: 0.4, tools: 6, approvals: 2, color: "ok",
    spark: [12,18,14,22,26,19,31,28,24,33,29,41,37,44,38,52,47,55],
  },
  {
    id: "agt_3m9x", name: "invoice-reconciler", env: "production", status: "healthy",
    model: "claude-sonnet-4.5", desc: "Matches invoices to POs, flags discrepancies, posts to ledger.",
    runs24h: 612, p50: 4.7, errRate: 1.1, tools: 9, approvals: 5, color: "ok",
    spark: [8,9,7,11,10,14,12,9,15,13,11,16,14,18,15,12,17,14],
  },
  {
    id: "agt_qf41", name: "deploy-bot", env: "production", status: "degraded",
    model: "claude-opus-4.1", desc: "Runs CI gates, opens PRs, ships to staging on green.",
    runs24h: 204, p50: 9.3, errRate: 4.8, tools: 12, approvals: 11, color: "warn",
    spark: [22,18,25,19,14,17,12,9,15,8,11,6,9,5,8,4,7,5],
  },
  {
    id: "agt_w8e2", name: "research-scout", env: "staging", status: "healthy",
    model: "claude-haiku-4", desc: "Crawls sources, summarizes, writes a daily brief to Notion.",
    runs24h: 96, p50: 12.8, errRate: 0.0, tools: 4, approvals: 0, color: "ok",
    spark: [3,4,5,4,6,5,7,6,8,7,9,8,7,9,8,10,9,11],
  },
  {
    id: "agt_v0c5", name: "data-migrator", env: "staging", status: "paused",
    model: "claude-sonnet-4.5", desc: "Backfills warehouse tables, dry-run by default.",
    runs24h: 0, p50: 0, errRate: 0, tools: 7, approvals: 3, color: "mute",
    spark: [5,6,4,3,2,1,0,0,0,0,0,0,0,0,0,0,0,0],
  },
];

const RUNS = [
  { id: "run_a91f4c", agent: "support-triage", status: "live", trigger: "api", started: "12s ago", dur: null, tokens: 8420, steps: 7, by: "key · prod-backend" },
  { id: "run_8830ad", agent: "deploy-bot", status: "awaiting", trigger: "schedule", started: "1m ago", dur: null, tokens: 21030, steps: 14, by: "cron · nightly" },
  { id: "run_5521be", agent: "invoice-reconciler", status: "ok", trigger: "api", started: "4m ago", dur: "11.4s", tokens: 14200, steps: 19, by: "key · billing-svc" },
  { id: "run_4410cd", agent: "support-triage", status: "ok", trigger: "api", started: "6m ago", dur: "3.2s", tokens: 6100, steps: 8, by: "key · prod-backend" },
  { id: "run_2290ef", agent: "deploy-bot", status: "error", trigger: "api", started: "9m ago", dur: "8.0s", tokens: 9800, steps: 11, by: "key · ci-runner" },
  { id: "run_1180aa", agent: "research-scout", status: "ok", trigger: "schedule", started: "22m ago", dur: "44.1s", tokens: 31500, steps: 26, by: "cron · daily-brief" },
  { id: "run_0091bb", agent: "support-triage", status: "ok", trigger: "api", started: "31m ago", dur: "2.8s", tokens: 5400, steps: 6, by: "key · prod-backend" },
];

// Step trace for the live run (run_a91f4c). type drives the icon/treatment.
const LIVE_STEPS = [
  { id: 1, type: "input", label: "Run started", detail: "Ticket #48213 — “Refund for duplicate charge”", dur: "0ms", tone: "mute",
    body: { channel: "api", agent: "support-triage", input: { ticket_id: 48213, customer: "cus_9920", subject: "Refund for duplicate charge" } } },
  { id: 2, type: "model", label: "Model reasoning", detail: "claude-sonnet-4.5 · planned 3 tool calls", dur: "1.9s", tone: "info", tokens: "1,204 in / 312 out",
    body: { plan: ["Look up the order", "Verify duplicate charge", "Issue refund (needs approval)"] } },
  { id: 3, type: "tool", label: "orders.lookup", detail: "200 OK · 184ms", dur: "0.2s", tone: "ok",
    body: { args: { customer: "cus_9920" }, result: { orders: 2, latest: "ord_7741", amount: "$49.00", charged_twice: true } } },
  { id: 4, type: "mcp", label: "stripe › charges.list", detail: "MCP · stripe-prod · 312ms", dur: "0.3s", tone: "ok",
    body: { server: "stripe-prod", tool: "charges.list", args: { customer: "cus_9920", limit: 5 }, result: { duplicate: true, charges: ["ch_3a1", "ch_3a2"] } } },
  { id: 5, type: "model", label: "Model reasoning", detail: "Decision: issue refund of $49.00", dur: "1.4s", tone: "info", tokens: "2,010 in / 168 out",
    body: { decision: "refund", amount: "$49.00", confidence: 0.97, rationale: "Two identical charges 40s apart; second is a duplicate." } },
  { id: 6, type: "approval", label: "stripe › refunds.create", detail: "Paused — awaiting approval", dur: null, tone: "warn",
    body: { reason: "matches policy rule: refunds > $25 require human approval", args: { charge: "ch_3a2", amount: "$49.00", reason: "duplicate" } } },
  { id: 7, type: "pending", label: "Reply to customer", detail: "Queued — blocked by approval", dur: null, tone: "mute", body: null },
];

const APPROVALS = [
  {
    id: "apv_55x", agent: "support-triage", run: "run_a91f4c", risk: "high",
    action: "stripe › refunds.create", title: "Refund $49.00 to cus_9920",
    rule: "refunds > $25 require human approval", age: "12s",
    args: { charge: "ch_3a2", amount: "$49.00", currency: "usd", reason: "duplicate_charge" },
    rationale: "Two identical $49.00 charges 40s apart; second is a confirmed duplicate.",
  },
  {
    id: "apv_38q", agent: "deploy-bot", run: "run_8830ad", risk: "high",
    action: "shell › kubectl apply", title: "Deploy api-gateway:v2.4.1 to staging",
    rule: "infrastructure writes always require approval", age: "1m",
    args: { cluster: "staging-eu", manifest: "api-gateway/deploy.yaml", replicas: 4 },
    rationale: "All CI gates green; image scanned, 0 critical CVEs.",
  },
  {
    id: "apv_21t", agent: "invoice-reconciler", run: "run_5521be", risk: "medium",
    action: "ledger › journal.post", title: "Post adjusting entry — $1,204.50",
    rule: "ledger writes > $1,000 require approval", age: "3m",
    args: { account: "4010-AR", debit: "$1,204.50", memo: "PO-8841 variance" },
    rationale: "Invoice INV-2231 exceeds PO by $1,204.50 (freight not on PO).",
  },
  {
    id: "apv_09k", agent: "deploy-bot", run: "run_2290ef", risk: "low",
    action: "github › pulls.create", title: "Open PR: bump deps (patch only)",
    rule: "external writes require approval in production", age: "8m",
    args: { repo: "acme/api", base: "main", head: "bot/deps-patch", files: 3 },
    rationale: "Patch-level bumps only; lockfile diff reviewed, tests pass.",
  },
];

const APPROVAL_HISTORY = [
  { id: "h1", action: "stripe › refunds.create", title: "Refund $18.00 to cus_8810", decision: "approved", by: "you", age: "14m" },
  { id: "h2", action: "shell › kubectl rollback", title: "Rollback api-gateway to v2.4.0", decision: "denied", by: "m.chen", age: "1h" },
  { id: "h3", action: "email › messages.send", title: "Send dunning notice to 12 accounts", decision: "approved", by: "you", age: "2h" },
];

const KEYS = [
  { id: "key_live_prod", name: "prod-backend", prefix: "ar_live_7Qx", env: "production", scopes: ["agents:run", "runs:read"], created: "Mar 2, 2026", lastUsed: "12s ago", reqs: "1.8M", color: "ok" },
  { id: "key_live_bill", name: "billing-svc", prefix: "ar_live_2Mk", env: "production", scopes: ["agents:run"], created: "Jan 18, 2026", lastUsed: "4m ago", reqs: "612K", color: "ok" },
  { id: "key_live_ci", name: "ci-runner", prefix: "ar_live_9Fp", env: "production", scopes: ["agents:run", "runs:read", "approvals:write"], created: "Feb 9, 2026", lastUsed: "9m ago", reqs: "204K", color: "warn" },
  { id: "key_test_dev", name: "local-dev", prefix: "ar_test_Vc0", env: "test", scopes: ["agents:run", "runs:read"], created: "May 22, 2026", lastUsed: "2h ago", reqs: "41K", color: "mute" },
];

const TOOLS_MCP = [
  { id: "stripe-prod", name: "stripe-prod", kind: "MCP", status: "connected", tools: 14, latency: "180ms" },
  { id: "github", name: "github", kind: "MCP", status: "connected", tools: 22, latency: "240ms" },
  { id: "postgres-ro", name: "warehouse (read-only)", kind: "MCP", status: "connected", tools: 5, latency: "60ms" },
  { id: "slack", name: "slack", kind: "MCP", status: "degraded", tools: 8, latency: "920ms" },
];

const PROVIDERS = [
  { id: "anthropic", name: "Anthropic", status: "active", models: 4, spend: "$4,210" },
  { id: "openai", name: "OpenAI", status: "active", models: 3, spend: "$880" },
  { id: "bedrock", name: "AWS Bedrock", status: "inactive", models: 0, spend: "$0" },
];

window.AR_DATA = { AGENTS, RUNS, LIVE_STEPS, APPROVALS, APPROVAL_HISTORY, KEYS, TOOLS_MCP, PROVIDERS };
