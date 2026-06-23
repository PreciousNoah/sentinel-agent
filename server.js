import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import pkg from '@croo-network/sdk';
const { AgentClient, EventType, DeliverableType } = pkg;
import fs from 'fs';

const app = express();
app.use(cors());
app.use(express.json({ strict: false }));
app.use(express.text({ type: '*/*' }));

const config = {
  baseURL: process.env.CROO_API_URL || 'https://api.croo.network',
  wsURL:   process.env.CROO_WS_URL  || 'wss://api.croo.network/ws',
  rpcURL:  'https://mainnet.base.org',
  logger:  { debug:()=>{}, info:console.log, warn:console.warn, error:console.error },
};

const SENTINEL_SDK_KEY = process.env.CROO_SDK_KEY || 'croo_sk_65d4e23e8574ed7dd7a94f8ff2911c33';
const AGENT_ID         = process.env.SENTINEL_AGENT_ID  || '6c4b9903-0dad-4515-8d08-77cab19f5967';
const SERVICE_ID       = process.env.SENTINEL_SERVICE_ID || '52ef257f-6efb-46cd-b0db-50638f2fbcf7';
const RENDER_URL       = process.env.RENDER_EXTERNAL_URL || 'https://sentinel-agent.onrender.com';

// ════════════════════════════════════════════════════════════════════
// DECISION ENGINE — deterministic, no LLM on the verdict
// ════════════════════════════════════════════════════════════════════

function runSentinel(input) {
  const {
    trustScore,
    confidence,
    sentiment    = 'neutral',
    riskFactors  = [],
    incidents    = [],
  } = input;

  // ── Hard overrides ───────────────────────────────────────────────
  if (incidents && incidents.length > 0) {
    return {
      verdict:      'AVOID',
      riskClass:    'CRITICAL',
      confidence:   'HIGH',
      reason:       `Hard trust event confirmed: ${incidents[0]}. Engagement not recommended regardless of other signals.`,
      reviewPeriod: 'None — do not engage',
      flags:        ['HARD_TRUST_EVENT'],
      inputs:       { trustScore, confidence, sentiment, riskFactors: riskFactors.length, incidents: incidents.length },
    };
  }

  if (trustScore === null || trustScore === undefined) {
    return {
      verdict:      'INSUFFICIENT DATA',
      riskClass:    'UNKNOWN',
      confidence:   'LOW',
      reason:       'Trust score unavailable. Cannot produce a compliance decision without verified trust data from VERIS.',
      reviewPeriod: 'Re-audit required before engagement',
      flags:        ['NO_TRUST_SCORE'],
      inputs:       { trustScore, confidence, sentiment, riskFactors: riskFactors.length, incidents: 0 },
    };
  }

  const score      = Number(trustScore);
  const conf       = Number(confidence) || 50;
  const isNegative = sentiment === 'negative';
  const isPositive = sentiment === 'positive';
  const highConf   = conf >= 65;
  const lowConf    = conf < 45;

  // ── Decision matrix ──────────────────────────────────────────────
  let verdict, riskClass, reason, reviewPeriod, flags = [];

  if (score >= 80 && highConf && !isNegative) {
    verdict      = 'PROCEED';
    riskClass    = 'LOW';
    reason       = `Strong trust signals (${score}/100) with high confidence (${conf}%). ${isPositive ? 'Positive market sentiment supports engagement.' : 'No negative indicators found.'}`;
    reviewPeriod = '90 days';

  } else if (score >= 75 && !isNegative) {
    verdict      = 'PROCEED';
    riskClass    = 'LOW';
    reason       = `Trust score (${score}/100) exceeds threshold with acceptable confidence (${conf}%). Standard due diligence complete.`;
    reviewPeriod = '60 days';

  } else if (score >= 65 && highConf && !isNegative) {
    verdict      = 'PROCEED WITH CAUTION';
    riskClass    = 'MEDIUM';
    reason       = `Adequate trust signals (${score}/100) but not at the highest tier. ${riskFactors.length > 0 ? `Key risks noted: ${riskFactors.slice(0,2).join('; ')}.` : 'Independent verification recommended.'}`;
    reviewPeriod = '30 days';

  } else if (score >= 65 && (isNegative || lowConf)) {
    verdict      = 'PROCEED WITH CAUTION';
    riskClass    = 'MEDIUM';
    reason       = `Trust score (${score}/100) is adequate but ${isNegative ? 'negative market sentiment' : `low confidence (${conf}%)`} warrants additional scrutiny before full engagement.`;
    reviewPeriod = '30 days';
    flags.push(isNegative ? 'NEGATIVE_SENTIMENT' : 'LOW_CONFIDENCE');

  } else if (score >= 50) {
    verdict      = 'PROCEED WITH CAUTION';
    riskClass    = 'MEDIUM';
    reason       = `Mixed trust signals (${score}/100). ${riskFactors.length > 0 ? `Identified risks: ${riskFactors.slice(0,3).join('; ')}.` : 'Evidence gaps present.'} Limit exposure until additional verification is complete.`;
    reviewPeriod = '14 days';
    flags.push('MIXED_SIGNALS');

  } else if (score >= 30) {
    verdict      = 'HIGH RISK';
    riskClass    = 'HIGH';
    reason       = `Trust score (${score}/100) is below the acceptable threshold. ${riskFactors.length > 0 ? `Specific risks: ${riskFactors.slice(0,3).join('; ')}.` : 'Multiple unverified signals.'} Engagement exposes significant risk.`;
    reviewPeriod = 'Re-audit required — 7 days minimum hold';
    flags.push('BELOW_THRESHOLD');

  } else {
    verdict      = 'AVOID';
    riskClass    = 'CRITICAL';
    reason       = `Trust score (${score}/100) is critically low. ${riskFactors.length > 0 ? `Risk factors: ${riskFactors.slice(0,3).join('; ')}.` : 'Insufficient legitimate signals.'} Do not engage.`;
    reviewPeriod = 'None — re-audit in 90 days if circumstances change';
    flags.push('CRITICAL_SCORE');
  }

  return {
    verdict,
    riskClass,
    confidence: highConf ? 'HIGH' : lowConf ? 'LOW' : 'MEDIUM',
    reason,
    reviewPeriod,
    flags,
    inputs: {
      trustScore: score,
      confidence: conf,
      sentiment,
      riskFactors: riskFactors.length,
      incidents:   0,
    },
  };
}

// ════════════════════════════════════════════════════════════════════
// FORMAT REPORT — for CROO text deliverable
// ════════════════════════════════════════════════════════════════════

function formatSentinelReport(decision, input) {
  const verdictSymbol = {
    'PROCEED':               '✅',
    'PROCEED WITH CAUTION':  '⚠️',
    'HIGH RISK':             '🔴',
    'AVOID':                 '⛔',
    'INSUFFICIENT DATA':     '❓',
  }[decision.verdict] || '—';

  const riskColors = {
    'LOW': 'Low', 'MEDIUM': 'Medium', 'HIGH': 'High', 'CRITICAL': 'Critical', 'UNKNOWN': 'Unknown',
  };

  const flags = decision.flags?.length
    ? decision.flags.map(f => `  ⚑ ${f}`).join('\n')
    : '  ✓ None';

  const riskList = (input.riskFactors || []).length
    ? (input.riskFactors || []).slice(0, 5).map(r => `  • ${r}`).join('\n')
    : '  • None identified';

  return `SENTINEL COMPLIANCE DECISION
═══════════════════════════════════════════════
Agent:        SENTINEL — Decision Intelligence Agent
Service:      Compliance Decision Engine
Agent ID:     ${AGENT_ID}
Timestamp:    ${new Date().toISOString()}
═══════════════════════════════════════════════
VERDICT:  ${verdictSymbol}  ${decision.verdict}

Risk Class:     ${riskColors[decision.riskClass] || decision.riskClass}
Confidence:     ${decision.confidence}
Review Period:  ${decision.reviewPeriod}
═══════════════════════════════════════════════
REASONING
${decision.reason}
═══════════════════════════════════════════════
INPUT SIGNALS
  Trust Score:   ${input.trustScore ?? 'N/A'}/100
  Confidence:    ${input.confidence ?? 'N/A'}%
  Sentiment:     ${(input.sentiment || 'neutral').toUpperCase()}
  Risk Factors:  ${(input.riskFactors || []).length}
  Incidents:     ${(input.incidents || []).length}
═══════════════════════════════════════════════
RISK FACTORS NOTED
${riskList}
═══════════════════════════════════════════════
FLAGS
${flags}
═══════════════════════════════════════════════
DECISION FRAMEWORK
  Score ≥ 80 + high confidence + non-negative  → PROCEED
  Score ≥ 75 + non-negative                    → PROCEED
  Score ≥ 65 + adequate signals                → PROCEED WITH CAUTION
  Score ≥ 50 + mixed signals                   → PROCEED WITH CAUTION
  Score ≥ 30                                   → HIGH RISK
  Score < 30                                   → AVOID
  Hard trust event (fraud/sanction)            → AVOID (override)
  No trust score                               → INSUFFICIENT DATA
═══════════════════════════════════════════════
A2A CHAIN
  ZERU  → Research & Intelligence
  VERIS → Trust Verification & Scoring
  SENTINEL → Compliance Decision ◄ (this agent)
═══════════════════════════════════════════════
  SENTINEL is an internal agent of the VERIS due diligence system.
  It operates exclusively in agent-to-agent workflows on CROO.
═══════════════════════════════════════════════`;
}

// ════════════════════════════════════════════════════════════════════
// BODY PARSING — same unwrap logic as VERIS
// ════════════════════════════════════════════════════════════════════

function parseBody(body) {
  if (!body) return null;
  if (typeof body === 'object') return body;
  try { return JSON.parse(body); } catch { return null; }
}

function unwrapCrooPayload(raw) {
  let parsed = parseBody(raw);
  let depth = 0;
  while (parsed && typeof parsed === 'object' && depth < 5) {
    if (parsed.trustScore !== undefined) break; // found the real payload
    if (typeof parsed.text === 'string') {
      const inner = parseBody(parsed.text);
      if (inner && typeof inner === 'object') { parsed = inner; depth++; continue; }
    }
    if (parsed.requirements && typeof parsed.requirements === 'object') {
      parsed = parsed.requirements; depth++; continue;
    }
    if (typeof parsed.requirements === 'string') {
      const inner = parseBody(parsed.requirements);
      if (inner && typeof inner === 'object') { parsed = inner; depth++; continue; }
    }
    break;
  }
  if (depth > 0) console.log(`  📦 Unwrapped ${depth} layer(s) of CROO wrapping`);
  return parsed;
}

// ════════════════════════════════════════════════════════════════════
// HEALTH CHECK
// ════════════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.json({
    status:      'SENTINEL online',
    role:        'Decision Intelligence Agent — VERIS subsystem',
    agentId:     AGENT_ID,
    serviceId:   SERVICE_ID,
    version:     'v1',
    description: 'Converts VERIS trust scores and ZERU research signals into compliance decisions.',
    endpoints: {
      decide: 'POST /decide',
      health: 'GET /',
    },
    chain: 'ZERU → Research | VERIS → Trust | SENTINEL → Decision',
    network:  'Base Mainnet',
    protocol: 'CROO v1',
  });
});

// ════════════════════════════════════════════════════════════════════
// HTTP DECIDE ENDPOINT — for VERIS to call internally
// POST /decide
// Body: { trustScore, confidence, sentiment, riskFactors, incidents }
// ════════════════════════════════════════════════════════════════════

app.post('/decide', async (req, res) => {
  const body = parseBody(req.body);
  if (!body) return res.status(400).json({ error: 'Request body required' });

  const input = {
    trustScore:  body.trustScore  ?? body.trust_score,
    confidence:  body.confidence,
    sentiment:   body.sentiment   || 'neutral',
    riskFactors: body.riskFactors || body.risk_factors || [],
    incidents:   body.incidents   || [],
  };

  try {
    const decision = runSentinel(input);
    res.json({
      ...decision,
      report:    formatSentinelReport(decision, input),
      agentId:   AGENT_ID,
      serviceId: SERVICE_ID,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('/decide error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════
// CROO ORDER HANDLER
// ════════════════════════════════════════════════════════════════════

async function handleOrder(provider, orderId) {
  try {
    const order = await provider.getOrder(orderId);
    console.log('📋 SENTINEL order received:', orderId);

    const rawReq =
      order.requirement     ||
      order.requirements    ||
      order.requirementText ||
      order.input           ||
      order.data            ||
      '';

    const input = unwrapCrooPayload(rawReq) || {};
    console.log('📋 Parsed input:', JSON.stringify(input));

    const decision = runSentinel(input);
    const report   = formatSentinelReport(decision, input);

    const delivery = await provider.deliverOrder(orderId, {
      deliverableType: DeliverableType.Text,
      deliverableText: report,
    });
    console.log('📦 SENTINEL delivered:', delivery.txHash);
    console.log(`   Verdict: ${decision.verdict} | Risk: ${decision.riskClass}`);
  } catch (err) {
    console.error('SENTINEL order error:', err.message);
  }
}

// ════════════════════════════════════════════════════════════════════
// PROVIDER LISTENER
// ════════════════════════════════════════════════════════════════════

const activeConnections = new Set();
let reconnectAttempts   = 0;

async function startProvider() {
  if (activeConnections.has(SENTINEL_SDK_KEY)) {
    console.log('SENTINEL already connected — skipping');
    return;
  }
  activeConnections.add(SENTINEL_SDK_KEY);

  try {
    console.log('Starting SENTINEL provider...');
    const provider = new AgentClient(config, SENTINEL_SDK_KEY);
    const stream   = await provider.connectWebSocket();
    reconnectAttempts = 0;
    console.log('✅ SENTINEL WebSocket connected');

    stream.on(EventType.NegotiationCreated, async (e) => {
      console.log('📨 SENTINEL negotiation:', e.negotiation_id);
      try {
        const result = await provider.acceptNegotiation(e.negotiation_id);
        console.log('✅ Accepted, order:', result.order.orderId);
      } catch (err) { console.error('Accept error:', err.message); }
    });

    stream.on(EventType.OrderPaid, async (e) => {
      console.log('💰 SENTINEL payment received:', e.order_id);
      await handleOrder(provider, e.order_id);
    });

    stream.on(EventType.OrderCompleted, (e) => {
      console.log('🎉 SENTINEL order settled:', e.order_id);
    });

    stream.on('close', () => {
      activeConnections.delete(SENTINEL_SDK_KEY);
      reconnectAttempts++;
      const delay = Math.min(5000 * reconnectAttempts, 30000);
      console.log(`SENTINEL closed — reconnecting in ${delay / 1000}s`);
      setTimeout(startProvider, delay);
    });

    stream.on('error', (err) => console.error('SENTINEL WS error:', err.message));
  } catch (err) {
    activeConnections.delete(SENTINEL_SDK_KEY);
    reconnectAttempts++;
    const delay = Math.min(5000 * reconnectAttempts, 30000);
    console.error(`SENTINEL failed: ${err.message} — retrying in ${delay / 1000}s`);
    setTimeout(startProvider, delay);
  }
}

// ════════════════════════════════════════════════════════════════════
// KEEP-ALIVE
// ════════════════════════════════════════════════════════════════════

setInterval(async () => {
  try   { await fetch(RENDER_URL); console.log('✅ SENTINEL keep-alive ping'); }
  catch (e) { console.log('Keep-alive failed:', e.message); }
}, 14 * 60 * 1000);

// ════════════════════════════════════════════════════════════════════
// START
// ════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`SENTINEL backend running on port ${PORT}`);
  console.log(`Agent ID:   ${AGENT_ID}`);
  console.log(`Service ID: ${SERVICE_ID}`);
  await startProvider();
});