# SENTINEL — Decision Intelligence Agent

> "Trust is verified by VERIS. Intelligence is gathered by ZERU. Decisions are made by SENTINEL."

SENTINEL is the compliance decision layer of the VERIS due diligence system. It operates exclusively as an internal agent — consuming verified trust scores from VERIS and market intelligence from ZERU, then producing deterministic compliance verdicts with full audit trails.

**Live on CROO Agent Store → [agent.croo.network](https://agent.croo.network)**

---

## Role in the Three-Agent System

```
Buyer Order (CROO)
       ↓
   VERIS — Trust Verification & Scoring
       ↓
    ZERU — Research Intelligence
       ↓
  SENTINEL — Compliance Decision  ◄ (this agent)
       ↓
  Combined Report Delivered On-Chain
```

SENTINEL never performs web searches, trust scoring, or evidence collection. It consumes outputs from the other two agents and applies a deterministic decision matrix to produce a final compliance verdict. Every number SENTINEL outputs is traceable to its inputs.

---

## Current Status

| | |
|---|---|
| ✅ | Live on CROO Agent Store |
| ✅ | WebSocket listener active |
| ✅ | POST /decide HTTP endpoint operational |
| ✅ | Deterministic decision matrix operational |
| ✅ | Compliance score breakdown operational |
| ✅ | Hard trust event override operational |
| ✅ | CROO schema object normalization operational |

| | |
|---|---|
| **Agent ID** | `6c4b9903-0dad-4515-8d08-77cab19f5967` |
| **Service ID** | `52ef257f-6efb-46cd-b0db-50638f2fbcf7` |
| **Network** | Base Mainnet |
| **Protocol** | CROO v1 |
| **Deployed** | Render |

---

## What SENTINEL Outputs

Every decision contains:

| Field | Description |
|---|---|
| `verdict` | `PROCEED` / `PROCEED WITH CAUTION` / `HIGH RISK` / `AVOID` / `INSUFFICIENT DATA` |
| `riskClass` | `LOW` / `MEDIUM` / `HIGH` / `CRITICAL` / `UNKNOWN` |
| `complianceScore` | 0–100, adjusted from trust score based on sentiment, confidence, and risk weights |
| `confidence` | `HIGH` / `MEDIUM` / `LOW` |
| `reason` | Plain-language explanation of exactly why this verdict was reached |
| `reviewPeriod` | When to re-assess (90d / 60d / 30d / 14d / re-audit required) |
| `reviewReason` | Why that review period was chosen |
| `recommendedActions` | Specific operational steps (✓ formatted) |
| `complianceBreakdown` | Line-by-line audit trail showing how compliance score was derived |
| `override` | Whether a hard trust event bypassed normal scoring |
| `inputSources` | Attribution showing which data came from VERIS vs ZERU |
| `flags` | Machine-readable signal flags (HARD_TRUST_EVENT, NEGATIVE_SENTIMENT, etc.) |

---

## Decision Framework

SENTINEL applies a deterministic matrix — no LLM makes the verdict decision. The LLM only phrases the `reason` field using already-computed inputs.

```
Score ≥ 80 + high confidence + non-negative sentiment  → PROCEED        (90d review)
Score ≥ 75 + non-negative sentiment                    → PROCEED        (60d review)
Score ≥ 65 + high confidence + non-negative sentiment  → CAUTION        (30d review)
Score ≥ 65 + (low confidence OR negative sentiment)    → CAUTION        (30d review)
Score ≥ 50 + mixed signals                             → CAUTION        (14d review)
Score ≥ 30                                             → HIGH RISK
Score < 30                                             → AVOID
Hard trust event confirmed (fraud/conviction/sanctions) → AVOID (override)
No trust score available                               → INSUFFICIENT DATA
```

### Compliance Score Calculation

The compliance score is derived from the trust score with adjustments:

```
Base:          Trust Score (from VERIS)
Sentiment:     +5 if positive  /  -8 if negative  /  +0 if neutral
Confidence:    -10 if < 45%   /  -5 if < 60%     /  +0 if adequate
Risk Penalty:  weighted per factor (see Risk Weights below)
───────────────────────────────────────────────────────
Final:         Compliance Score (0–100)
```

### Risk Factor Weights

Different risk types carry different compliance penalties:

| Category | Examples | Penalty |
|---|---|---|
| Critical | fraud, scam, criminal conviction, SEC enforcement, sanctions, rug pull | −15 |
| High | regulatory enforcement, lawsuit, hack, exploit, insolvency, bankruptcy | −5 |
| Medium | smart contract risk, governance concentration, custodial risk | −3 |
| Low-Medium | liquidity concentration, market structure complexity | −2 |
| Low | market volatility, competition | −1 |
| Default | any unmatched risk factor | −2 |

Maximum total risk penalty is capped at −20 to prevent edge cases.

### Hard Trust Event Override

If any confirmed hard trust event exists in the incidents list, SENTINEL immediately returns AVOID regardless of trust score or any other signal. No scoring is performed.

Hard events that trigger override:
- `confirmed fraud` / `fraud confirmed`
- `criminal conviction` / `convicted` / `guilty` / `indicted`
- `SEC enforcement` / `sanctions` / `OFAC`
- `rug pull confirmed` / `confirmed scam`
- `criminal charges`

Phrases that do **NOT** trigger override (explicitly excluded):
- `no confirmed fraud`
- `no confirmed hack`
- `no history of fraud`
- `none confirmed`
- `not applicable`

Items with `severity: "none"` or `severity: "low"` are also excluded from override, regardless of type.

---

## CROO Service Configuration

### Requirements Schema (input)

SENTINEL expects structured JSON from CROO orders:

| Field | Type | Required | Description |
|---|---|---|---|
| `trustScore` | number | Yes | VERIS trust score 0–100 |
| `confidence` | number | Yes | VERIS confidence percentage |
| `sentiment` | string | Yes | ZERU sentiment: `positive` / `neutral` / `negative` |
| `riskFactors` | array | No | Risk factors from ZERU (strings or `{type, severity, description}` objects) |
| `incidents` | array | No | Hard trust events from VERIS (strings or objects) |

### Deliverable Schema (output)

SENTINEL delivers a structured compliance report via `DeliverableType.Text`.

The report contains:
- `VERDICT` block with all scores
- `COMPLIANCE SCORE BREAKDOWN` — line-by-line audit trail
- `REASONING` — plain language explanation
- `RECOMMENDED ACTIONS` — operational steps
- `INPUT SOURCE ATTRIBUTION` — VERIS vs ZERU data clearly separated
- `HARD TRUST EVENTS` — confirmed incidents only
- `DECISION FRAMEWORK` — the matrix used to reach this verdict
- `A2A CHAIN` — all three contributors listed

---

## HTTP API

SENTINEL exposes one HTTP endpoint for direct integration (used by VERIS internally):

### `GET /`

Health check. Returns agent status, IDs, and endpoint list.

### `POST /decide`

Runs the decision engine and returns structured JSON.

**Request:**
```json
{
  "trustScore": 77,
  "confidence": 69,
  "sentiment": "neutral",
  "riskFactors": [
    "Smart contract risk (35%) — moderate exposure",
    "Liquidity concentration (30%) — top 5 assets represent 60% of TVL"
  ],
  "incidents": []
}
```

**Response:**
```json
{
  "verdict": "PROCEED",
  "riskClass": "LOW",
  "complianceScore": 71,
  "confidence": "HIGH",
  "reason": "Trust score (77/100, compliance 71/100) exceeds minimum threshold...",
  "reviewPeriod": "60 days",
  "reviewReason": "Strong trust and compliance signals. Standard monitoring cadence.",
  "recommendedActions": [
    "Proceed with standard commercial terms",
    "Schedule 60-day re-audit",
    "Monitor sentiment for changes"
  ],
  "complianceBreakdown": {
    "baseTrustScore": 77,
    "sentimentAdj": "+0 (neutral)",
    "confidenceAdj": "+0 (adequate)",
    "riskPenalty": "-6 (2 risk factors)",
    "riskBreakdown": [
      { "factor": "Smart contract risk (35%)...", "penalty": -3, "matched": "smart contract" },
      { "factor": "Liquidity concentration (30%)...", "penalty": -2, "matched": "liquidity" }
    ],
    "finalScore": 71
  },
  "override": { "triggered": false },
  "inputSources": {
    "veris": { "trustScore": 77, "incidents": [] },
    "zeru": { "sentiment": "neutral", "riskFactors": ["Smart contract risk...", "Liquidity..."] }
  },
  "flags": [],
  "report": "SENTINEL COMPLIANCE DECISION\n══...full text",
  "agentId": "6c4b9903-0dad-4515-8d08-77cab19f5967",
  "serviceId": "52ef257f-6efb-46cd-b0db-50638f2fbcf7",
  "timestamp": "2026-06-27T..."
}
```

---

## Example Outputs

### PROCEED — Established Protocol

```
VERDICT:  ✅  PROCEED

  Trust Score:       77/100
  Compliance Score:  71/100
  Risk Class:        LOW
  Confidence:        HIGH
  Review Period:     60 days
  Review Reason:     Strong trust and compliance signals. Standard monitoring cadence.
```

### PROCEED WITH CAUTION — Mixed Signals

```
VERDICT:  ⚠️  PROCEED WITH CAUTION

  Trust Score:       62/100
  Compliance Score:  52/100
  Risk Class:        MEDIUM
  Confidence:        MEDIUM
  Review Period:     14 days
  Review Reason:     Adequate signals but evidence gaps present.
```

### AVOID — Hard Trust Event

```
VERDICT:  ⛔  AVOID

  Trust Score:       0/100
  Compliance Score:  0/100
  Risk Class:        CRITICAL
  Confidence:        HIGH
  Review Period:     None — do not engage

OVERRIDE TRIGGERED
  Type:    HARD_TRUST_EVENT
  Reason:  Confirmed: Criminal conviction of founders
  Detail:  Hard trust event detected. Normal scoring bypassed.
```

---

## Quick Start

```bash
git clone https://github.com/PreciousNoah/sentinel-agent
cd sentinel-agent
npm install
cp .env.example .env
# Fill in your keys
node server.js
```

---

## Environment Variables

```bash
CROO_API_URL=https://api.croo.network
CROO_WS_URL=wss://api.croo.network/ws
CROO_SDK_KEY=your_sentinel_sdk_key
SENTINEL_AGENT_ID=6c4b9903-0dad-4515-8d08-77cab19f5967
SENTINEL_SERVICE_ID=52ef257f-6efb-46cd-b0db-50638f2fbcf7
RENDER_EXTERNAL_URL=https://sentinel-agent-e787.onrender.com
```

---

## SDK Methods Used

| Method | Purpose |
|---|---|
| `AgentClient` | Runtime agent authentication |
| `EventType.NegotiationCreated` | Accept incoming CROO orders |
| `EventType.OrderPaid` | Trigger decision engine on payment |
| `EventType.OrderCompleted` | Confirm on-chain settlement |
| `DeliverableType.Text` | Deliver compliance report as text on-chain |
| `acceptNegotiation()` | Lock order on-chain |
| `deliverOrder()` | Submit compliance decision on-chain |
| `getOrder()` | Read requirement payload from order |

---

## Design Principles

**Deterministic verdicts.** The verdict is never decided by an LLM. The decision matrix is hardcoded. Given the same inputs, SENTINEL always produces the same verdict.

**Auditable scores.** Every compliance score includes a line-by-line breakdown showing exactly how it was derived. A judge asking "why 71 and not 77?" gets a precise answer.

**Conservative override.** Hard trust events (fraud, conviction, sanctions) immediately override all scoring to AVOID. "No confirmed fraud" and severity-none items never trigger override.

**Schema-agnostic input.** SENTINEL normalizes CROO schema objects `{type, severity, description}` and plain strings identically, preventing `[object Object]` in reports regardless of how CROO formats the requirement payload.

**Graceful degradation.** If trust score is null, verdict is INSUFFICIENT DATA — not AVOID. Missing data is treated as uncertainty, not guilt.

---

## License

MIT
