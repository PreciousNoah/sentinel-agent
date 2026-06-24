import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import pkg from '@croo-network/sdk';
const { AgentClient, EventType, DeliverableType } = pkg;

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

const SENTINEL_SDK_KEY = process.env.CROO_SDK_KEY        || 'croo_sk_65d4e23e8574ed7dd7a94f8ff2911c33';
const AGENT_ID         = process.env.SENTINEL_AGENT_ID   || '6c4b9903-0dad-4515-8d08-77cab19f5967';
const SERVICE_ID       = process.env.SENTINEL_SERVICE_ID || '52ef257f-6efb-46cd-b0db-50638f2fbcf7';
const RENDER_URL       = process.env.RENDER_EXTERNAL_URL || 'https://sentinel-agent-e787.onrender.com';

// ════════════════════════════════════════════════════════════════════
// DECISION ENGINE
// ════════════════════════════════════════════════════════════════════

function computeComplianceScore(trustScore, confidence, sentiment, incidents, riskFactors) {
  if (incidents?.length > 0) return 0;
  if (trustScore === null || trustScore === undefined) return null;

  let score = trustScore;

  // Sentiment adjustment (±8 points)
  if (sentiment === 'positive') score = Math.min(100, score + 8);
  if (sentiment === 'negative') score = Math.max(0,   score - 8);

  // Confidence adjustment (low confidence reduces score by up to 10)
  const conf = Number(confidence) || 50;
  if (conf < 45) score = Math.max(0, score - 10);
  else if (conf < 60) score = Math.max(0, score - 5);

  // Risk factor penalty (−2 per confirmed risk, max −12)
  const penalty = Math.min(12, (riskFactors?.length || 0) * 2);
  score = Math.max(0, score - penalty);

  return Math.round(score);
}

function runSentinel(input) {
  const {
    trustScore,
    confidence,
    sentiment    = 'neutral',
    riskFactors  = [],
    incidents    = [],
  } = input;

  const score      = trustScore !== null && trustScore !== undefined ? Number(trustScore) : null;
  const conf       = Number(confidence) || 50;
  const isNegative = sentiment === 'negative';
  const isPositive = sentiment === 'positive';
  const highConf   = conf >= 65;
  const lowConf    = conf < 45;

  const complianceScore = computeComplianceScore(score, conf, sentiment, incidents, riskFactors);

  // ── Hard override ────────────────────────────────────────────────
  if (incidents?.length > 0) {
    return {
      verdict:          'AVOID',
      riskClass:        'CRITICAL',
      complianceScore:  0,
      confidence:       'HIGH',
      reason:           `Hard trust event confirmed: ${incidents[0]}. Engagement not recommended regardless of other signals.`,
      reviewPeriod:     'None — do not engage',
      recommendedActions: [
        'Do not transact',
        'Do not invest',
        'Do not integrate',
        'Re-evaluate only if criminal/regulatory status materially changes',
      ],
      override: {
        triggered: true,
        type:      'HARD_TRUST_EVENT',
        reason:    `Confirmed: ${incidents[0]}`,
        detail:    'Hard trust event detected. Normal scoring bypassed. Automatic AVOID verdict issued.',
      },
      inputSources: {
        veris: { trustScore: score, incidents },
        zeru:  { sentiment, riskFactors },
      },
      flags: ['HARD_TRUST_EVENT'],
    };
  }

  // ── Insufficient data ────────────────────────────────────────────
  if (score === null || score === undefined) {
    return {
      verdict:          'INSUFFICIENT DATA',
      riskClass:        'UNKNOWN',
      complianceScore:  null,
      confidence:       'LOW',
      reason:           'Trust score unavailable. Cannot produce a compliance decision without verified VERIS data.',
      reviewPeriod:     'Re-audit required before engagement',
      recommendedActions: ['Do not engage until trust data is available', 'Request re-audit from VERIS'],
      override:         { triggered: false },
      inputSources: {
        veris: { trustScore: null, incidents: [] },
        zeru:  { sentiment, riskFactors },
      },
      flags: ['NO_TRUST_SCORE'],
    };
  }

  // ── Decision matrix ──────────────────────────────────────────────
  let verdict, riskClass, reason, reviewPeriod, recommendedActions, flags = [];

  if (score >= 80 && highConf && !isNegative) {
    verdict   = 'PROCEED';
    riskClass = 'LOW';
    reason    = `Strong trust signals (${score}/100, compliance ${complianceScore}/100) with high confidence (${conf}%). ${isPositive ? 'Positive market sentiment further supports engagement.' : 'No adverse indicators found.'} Standard due diligence complete.`;
    reviewPeriod = '90 days';
    recommendedActions = ['Proceed with standard commercial terms', 'Schedule 90-day re-audit', 'Monitor for material changes'];

  } else if (score >= 75 && !isNegative) {
    verdict   = 'PROCEED';
    riskClass = 'LOW';
    reason    = `Trust score (${score}/100, compliance ${complianceScore}/100) exceeds minimum threshold. Confidence at ${conf}% is acceptable. No hard trust events detected.`;
    reviewPeriod = '60 days';
    recommendedActions = ['Proceed with standard commercial terms', 'Schedule 60-day re-audit', 'Monitor sentiment for changes'];

  } else if (score >= 65 && highConf && !isNegative) {
    verdict   = 'PROCEED WITH CAUTION';
    riskClass = 'MEDIUM';
    reason    = `Adequate trust score (${score}/100, compliance ${complianceScore}/100). ${riskFactors.length > 0 ? `Key risks noted: ${riskFactors.slice(0, 2).join('; ')}.` : 'Some evidence gaps present.'} Independent verification recommended before high-value commitment.`;
    reviewPeriod = '30 days';
    recommendedActions = ['Limit initial exposure', 'Request additional verification documents', 'Schedule 30-day re-audit', 'Do not commit large capital without further diligence'];
    flags.push('EVIDENCE_GAPS');

  } else if (score >= 65 && (isNegative || lowConf)) {
    verdict   = 'PROCEED WITH CAUTION';
    riskClass = 'MEDIUM';
    reason    = `Trust score (${score}/100, compliance ${complianceScore}/100) is adequate but ${isNegative ? 'negative market sentiment' : `low confidence (${conf}%)`} warrants additional scrutiny.`;
    reviewPeriod = '30 days';
    recommendedActions = ['Proceed at reduced exposure only', 'Resolve confidence gaps before scaling', 'Re-audit in 30 days'];
    flags.push(isNegative ? 'NEGATIVE_SENTIMENT' : 'LOW_CONFIDENCE');

  } else if (score >= 50) {
    verdict   = 'PROCEED WITH CAUTION';
    riskClass = 'MEDIUM';
    reason    = `Mixed trust signals (${score}/100, compliance ${complianceScore}/100). ${riskFactors.length > 0 ? `Identified risks: ${riskFactors.slice(0, 3).join('; ')}.` : 'Multiple unverified claims.'} Limit exposure until verification complete.`;
    reviewPeriod = '14 days';
    recommendedActions = ['Do not commit significant capital', 'Obtain independent third-party verification', 'Re-audit in 14 days', 'Establish clear exit conditions'];
    flags.push('MIXED_SIGNALS');

  } else if (score >= 30) {
    verdict   = 'HIGH RISK';
    riskClass = 'HIGH';
    reason    = `Trust score (${score}/100, compliance ${complianceScore}/100) is below acceptable threshold. ${riskFactors.length > 0 ? `Specific risks: ${riskFactors.slice(0, 3).join('; ')}.` : 'Significant evidence gaps.'} Engagement carries substantial risk.`;
    reviewPeriod = 'Re-audit required — minimum 7 day hold';
    recommendedActions = ['Do not transact without executive approval', 'Do not invest', 'Obtain legal review before any integration', 'Re-audit after 90 days or material evidence change'];
    flags.push('BELOW_THRESHOLD');

  } else {
    verdict   = 'AVOID';
    riskClass = 'CRITICAL';
    reason    = `Trust score (${score}/100, compliance ${complianceScore}/100) is critically low. ${riskFactors.length > 0 ? `Risk factors: ${riskFactors.slice(0, 3).join('; ')}.` : 'Insufficient legitimate signals.'} Do not engage.`;
    reviewPeriod = 'None — re-audit in 90 days if circumstances change';
    recommendedActions = ['Do not transact', 'Do not invest', 'Do not integrate', 'Re-evaluate only if trust signals materially improve'];
    flags.push('CRITICAL_SCORE');
  }

  return {
    verdict,
    riskClass,
    complianceScore,
    confidence:  highConf ? 'HIGH' : lowConf ? 'LOW' : 'MEDIUM',
    reason,
    reviewPeriod,
    recommendedActions,
    override: { triggered: false },
    inputSources: {
      veris: { trustScore: score, incidents: [] },
      zeru:  { sentiment, riskFactors },
    },
    flags,
  };
}

// ════════════════════════════════════════════════════════════════════
// FORMAT REPORT
// ════════════════════════════════════════════════════════════════════

function formatSentinelReport(decision, input) {
  const symbol = {
    'PROCEED':              '✅',
    'PROCEED WITH CAUTION': '⚠️',
    'HIGH RISK':            '🔴',
    'AVOID':                '⛔',
    'INSUFFICIENT DATA':    '❓',
  }[decision.verdict] || '—';

  // Review period reasoning
  const reviewReason = {
    'PROCEED':              'Strong trust and compliance signals. Standard monitoring cadence.',
    'PROCEED WITH CAUTION': 'Adequate signals but evidence gaps present. Closer monitoring required.',
    'HIGH RISK':            'Below acceptable threshold. Re-audit required before re-engagement.',
    'AVOID':                'Critical risk detected. No review scheduled until circumstances materially change.',
    'INSUFFICIENT DATA':    'Cannot assess without complete trust data.',
  }[decision.verdict] || '';

  const actions = (decision.recommendedActions || [])
    .map(a => `  ✓ ${a}`).join('\n');

  const flags = decision.flags?.length
    ? decision.flags.map(f => `  ⚑ ${f}`).join('\n')
    : '  ✓ None';

  const overrideBlock = decision.override?.triggered
    ? `
══════════════════════════════════════════════
OVERRIDE TRIGGERED
  Type:    ${decision.override.type}
  Reason:  ${decision.override.reason}
  Detail:  ${decision.override.detail}`
    : '';

  const riskList = (input.riskFactors || []).length
    ? (input.riskFactors || []).slice(0, 5).map(r => `  • ${r}`).join('\n')
    : '  • None identified';

  const incidentList = (input.incidents || []).length
    ? (input.incidents || []).map(i => `  ⛔ ${i}`).join('\n')
    : '  ✓ None';

  return `SENTINEL COMPLIANCE DECISION
═══════════════════════════════════════════════
Agent:        SENTINEL — Decision Intelligence Agent
Service:      Compliance Decision Engine
Agent ID:     ${AGENT_ID}
Timestamp:    ${new Date().toISOString()}
═══════════════════════════════════════════════
VERDICT:  ${symbol}  ${decision.verdict}

Trust Score:       ${input.trustScore ?? 'N/A'}/100
Compliance Score:  ${decision.complianceScore ?? 'N/A'}/100
Risk Class:        ${decision.riskClass}
Confidence:        ${decision.confidence}
Review Period:     ${decision.reviewPeriod}
  Review Reason:     ${reviewReason}
═══════════════════════════════════════════════
REASONING
${decision.reason}
${overrideBlock}
══════════════════════════════════════════════
RECOMMENDED ACTIONS
${actions}
══════════════════════════════════════════════
INPUT SOURCE ATTRIBUTION
  VERIS (Trust Engine):
    • Trust Score:  ${input.trustScore ?? 'N/A'}/100
    • Incidents:    ${(input.incidents || []).length > 0 ? (input.incidents || []).map(i => `\n      ⛔ ${i}`).join('') : '✓ None'}
  ZERU (Research Agent):
    • Sentiment:    ${(input.sentiment || 'neutral').toUpperCase()}
    • Risk Factors: ${(input.riskFactors || []).length}
${riskList}
══════════════════════════════════════════════
HARD TRUST EVENTS
${incidentList}
══════════════════════════════════════════════
FLAGS
${flags}
══════════════════════════════════════════════
DECISION FRAMEWORK
  Score ≥ 80 + high confidence + non-negative  → PROCEED (90d review)
  Score ≥ 75 + non-negative                    → PROCEED (60d review)
  Score ≥ 65 + adequate signals                → PROCEED WITH CAUTION (30d)
  Score ≥ 50 + mixed signals                   → PROCEED WITH CAUTION (14d)
  Score ≥ 30                                   → HIGH RISK
  Score < 30                                   → AVOID
  Hard trust event (fraud/sanction/conviction) → AVOID (hard override)
  No trust score                               → INSUFFICIENT DATA
══════════════════════════════════════════════
A2A CHAIN
  ZERU     → Research & Intelligence
  VERIS    → Trust Verification & Scoring
  SENTINEL → Compliance Decision ◄ (this agent)

  This audit was processed by three autonomous agents
  cooperating on the CROO network — demonstrating
  agent-to-agent composability (A2A).
══════════════════════════════════════════════
  SENTINEL is an internal agent of the VERIS due diligence system.
  It operates exclusively in agent-to-agent workflows on CROO.
═══════════════════════════════════════════════`;
}

// ════════════════════════════════════════════════════════════════════
// BODY PARSING
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
    if (parsed.trustScore !== undefined) break;
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
  if (depth > 0) console.log(`  📦 Unwrapped ${depth} layer(s)`);
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
    version:     'v2',
    description: 'Converts VERIS trust scores and ZERU research signals into compliance decisions.',
    endpoints:   { decide: 'POST /decide', health: 'GET /' },
    chain:       'ZERU → Research | VERIS → Trust | SENTINEL → Decision',
    network:     'Base Mainnet',
    protocol:    'CROO v1',
  });
});

// ════════════════════════════════════════════════════════════════════
// POST /decide
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

    const rawReq = order.requirement || order.requirements || order.requirementText || order.input || order.data || '';
    const input  = unwrapCrooPayload(rawReq) || {};
    console.log('📋 Parsed input:', JSON.stringify(input));

    const decision = runSentinel(input);
    const report   = formatSentinelReport(decision, input);

    const delivery = await provider.deliverOrder(orderId, {
      deliverableType: DeliverableType.Text,
      deliverableText: report,
    });
    console.log('📦 SENTINEL delivered:', delivery.txHash);
    console.log(`   Verdict: ${decision.verdict} | Risk: ${decision.riskClass} | Compliance: ${decision.complianceScore}/100`);
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
  if (activeConnections.has(SENTINEL_SDK_KEY)) return;
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
  try   { await fetch(RENDER_URL); console.log('✅ SENTINEL keep-alive'); }
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