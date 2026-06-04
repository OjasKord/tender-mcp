const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

const VERSION = '1.2.11';
const PRO_UPGRADE_URL = 'https://buy.stripe.com/9B600i5k1bPv2xC6Fqebu0n';
const ENTERPRISE_UPGRADE_URL = 'https://buy.stripe.com/7sY7sKaEldXDegk0h2ebu0o';
const PERSIST_FILE = '/tmp/tender_stats.json';
const API_KEYS_FILE = '/tmp/tender_apikeys.json';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const SAM_GOV_API_KEY = process.env.SAM_GOV_API_KEY || '';
const PORT = process.env.PORT || 3000;
const STATS_KEY = process.env.STATS_KEY || 'ojas2026';

const freeTierUsage = new Map();
const usageLog = [];
const FREE_TIER_LIMIT = 10;
const FREE_TIER_WARNING = 8;
const apiKeys = new Map();
const PLAN_LIMITS = { pro: 500, enterprise: Infinity };
const toolUsageCounts = {};
const trialExtensions = new Map();
const TRIAL_EXTENSION_CALLS = 10;

const REDIS_PREFIX = 'tender';
const FREE_TIER_REDIS_KEY = 'tender:free_tier_usage';
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const LEGAL_DISCLAIMER = 'Tender data is sourced directly from official government portals: UK Contracts Finder (contractsfinder.service.gov.uk), EU TED (ted.europa.eu), and US SAM.gov (sam.gov). We do not log or store your query content. Tender deadlines and contract values may change — always verify directly with the contracting authority before submitting a bid. Results are for informational purposes only. Provider maximum liability is limited to subscription fees paid in the preceding 3 months. Full terms: kordagencies.com/terms.html';

function nowISO() { return new Date().toISOString(); }
function getMonthKey(ip) { return ip + ':' + new Date().toISOString().slice(0, 7); }

function getEffectiveLimit(ip) {
  for (const record of trialExtensions.values()) {
    if (record.ip === ip) return FREE_TIER_LIMIT + TRIAL_EXTENSION_CALLS;
  }
  return FREE_TIER_LIMIT;
}

function getTodayDate() { return new Date().toISOString().split('T')[0]; }
function getDateDaysAgo(days) {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().split('T')[0];
}
function getSAMDate(daysAgo) {
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return (d.getMonth()+1).toString().padStart(2,'0') + '/' + d.getDate().toString().padStart(2,'0') + '/' + d.getFullYear();
}

function saveStats() {
  try {
    fs.writeFileSync(PERSIST_FILE, JSON.stringify({
      freeTierUsage: Array.from(freeTierUsage.entries()),
      usageLog: usageLog.slice(-1000),
      toolUsageCounts,
      trialExtensions: Array.from(trialExtensions.entries())
    }));
  } catch(e) { console.error('Stats save error:', e.message); }
}

function loadStats() {
  try {
    if (fs.existsSync(PERSIST_FILE)) {
      const data = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf8'));
      if (data.freeTierUsage) data.freeTierUsage.forEach(([k, v]) => freeTierUsage.set(k, v));
      if (data.usageLog) usageLog.push(...data.usageLog);
      if (data.toolUsageCounts) Object.assign(toolUsageCounts, data.toolUsageCounts);
      if (data.trialExtensions) data.trialExtensions.forEach(([k, v]) => trialExtensions.set(k, v));
      console.log('Stats loaded: ' + freeTierUsage.size + ' IPs, ' + usageLog.length + ' calls, ' + trialExtensions.size + ' trial extensions');
    }
  } catch(e) { console.error('Stats load error:', e.message); }
}

function saveApiKeys() {
  try { fs.writeFileSync(API_KEYS_FILE, JSON.stringify(Array.from(apiKeys.entries()))); } catch(e) { console.error('API keys save error:', e.message); }
}

function loadApiKeys() {
  try {
    if (fs.existsSync(API_KEYS_FILE)) {
      const data = JSON.parse(fs.readFileSync(API_KEYS_FILE, 'utf8'));
      data.forEach(([k, v]) => apiKeys.set(k, v));
      console.log('API keys loaded: ' + apiKeys.size + ' keys');
    }
  } catch(e) { console.error('API keys load error:', e.message); }
}

function generateApiKey() { return 'tender_' + crypto.randomBytes(24).toString('hex'); }
function getPlanFromProduct(name) {
  if (!name) return 'pro';
  return name.toLowerCase().includes('enterprise') ? 'enterprise' : 'pro';
}

async function sendEmail(to, subject, html) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ from: 'Tender MCP <ojas@kordagencies.com>', to: [to], subject, html });
    const req = https.request({
      hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    req.on('error', e => resolve({ error: e.message }));
    req.write(body); req.end();
  });
}

async function sendApiKeyEmail(email, apiKey, plan) {
  const planLabel = plan === 'enterprise' ? 'Enterprise' : 'Pro';
  const limit = plan === 'enterprise' ? 'Unlimited' : '500';
  const html = '<!DOCTYPE html><html><body style="font-family:monospace;background:#080A0F;color:#E8EDF5;padding:40px;max-width:600px;margin:0 auto"><div style="border:1px solid rgba(0,229,195,0.3);border-radius:8px;padding:32px"><div style="color:#00E5C3;font-size:13px;letter-spacing:0.2em;text-transform:uppercase;margin-bottom:24px">Tender MCP - ' + planLabel + ' Plan</div><h1 style="font-size:24px;font-weight:700;margin-bottom:8px;color:#FFFFFF">Your API key is ready.</h1><div style="background:#141B24;border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:20px;margin-bottom:24px"><div style="color:#5A6478;font-size:11px;text-transform:uppercase;margin-bottom:8px">Your API Key</div><div style="color:#00E5C3;font-size:14px;word-break:break-all">' + apiKey + '</div></div><div style="background:#141B24;border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:20px;margin-bottom:24px"><div style="color:#5A6478;font-size:11px;text-transform:uppercase;margin-bottom:8px">MCP Config</div><div style="color:#86EFAC;font-size:12px">{"tender":{"url":"https://tender-mcp-production.up.railway.app","headers":{"x-api-key":"' + apiKey + '"}}}</div></div><div style="background:#141B24;border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:20px;margin-bottom:24px"><div style="color:#E8EDF5;font-size:13px">Plan: ' + planLabel + ' | Searches: ' + limit + '/month</div></div><div style="background:#0D1219;border-radius:6px;padding:16px;margin-bottom:24px;font-size:11px;color:#5A6478;line-height:1.7">Tender data is sourced from official government portals. Deadlines may change — always verify with the contracting authority before bidding. We do not log your query content. Liability capped at 3 months fees. Full terms: kordagencies.com/terms.html</div><p style="color:#5A6478;font-size:12px">Questions? ojas@kordagencies.com</p></div></body></html>';
  return sendEmail(email, 'Your Tender MCP ' + planLabel + ' API Key', html);
}

async function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d).content?.[0]?.text || ''); } catch(e) { reject(e); } }); });
    req.on('error', reject); req.write(body); req.end();
  });
}

// ─── REDIS HELPERS ────────────────────────────────────────────────────────────

async function redisGet(key) {
  try {
    const res = await fetch(
      `${UPSTASH_URL}/get/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } }
    );
    const data = await res.json();
    if (data.error) console.error('[Redis] redisGet error:', data.error, 'key:', key);
    if (!data.result) return null;
    return JSON.parse(data.result);
  } catch(e) { return null; }
}

async function redisSet(key, value) {
  try {
    const res = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
    });
    const data = await res.json();
    if (data.error) console.error('[Redis] redisSet error:', data.error, 'key:', key);
  } catch(e) { console.error('[Redis] redisSet failed:', e); }
}

async function redisExpire(key, seconds) {
  try {
    const res = await fetch(
      `${UPSTASH_URL}/expire/${encodeURIComponent(key)}/${seconds}`,
      { method: 'POST', headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } }
    );
    const data = await res.json();
    if (data.error) console.error('[Redis] redisExpire error:', data.error, 'key:', key);
  } catch(e) { console.error('[Redis] redisExpire failed:', e); }
}

async function redisKeys(pattern) {
  try {
    const res = await fetch(
      `${UPSTASH_URL}/keys/${encodeURIComponent(pattern)}`,
      { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } }
    );
    const data = await res.json();
    if (data.error) console.error('[Redis] redisKeys error:', data.error, 'pattern:', pattern);
    return data.result || [];
  } catch(e) { return []; }
}

async function appendSessionLog(ip, tool) {
  try {
    const ipSafe = ip.replace(/:/g, '_').replace(/\s/g, '');
    const dayKey = new Date().toISOString().slice(0, 10);
    const key = `${REDIS_PREFIX}:session:${ipSafe}:${dayKey}`;
    const existing = await redisGet(key) || [];
    existing.push({ tool, timestamp: new Date().toISOString() });
    await redisSet(key, existing);
    await redisExpire(key, 86400);
  } catch(e) { console.error('[SessionLog] internal error:', e); }
}

async function saveKeyToRedis(apiKey, record) {
  await redisSet(`${REDIS_PREFIX}:key:${apiKey}`, record);
}

async function loadApiKeysFromRedis() {
  const keys = await redisKeys(`${REDIS_PREFIX}:key:*`);
  for (const redisKey of keys) {
    const record = await redisGet(redisKey);
    if (record) {
      const apiKey = redisKey.replace(`${REDIS_PREFIX}:key:`, '');
      apiKeys.set(apiKey, record);
    }
  }
  console.log(`Loaded ${apiKeys.size} API keys from Redis`);
}

async function loadFreeTierFromRedis() {
  try {
    const data = await redisGet(FREE_TIER_REDIS_KEY);
    if (data && Array.isArray(data)) {
      data.forEach(([k, v]) => freeTierUsage.set(k, v));
      console.log('[FreeTier] Loaded ' + freeTierUsage.size + ' IPs from Redis');
    }
  } catch(e) { console.error('[FreeTier] load failed:', e); }
}

async function saveFreeTierToRedis() {
  try {
    const existing = await redisGet(FREE_TIER_REDIS_KEY) || [];
    const existingMap = new Map(existing);
    for (const [key, value] of freeTierUsage.entries()) {
      const existingCount = existingMap.get(key) || 0;
      existingMap.set(key, Math.max(existingCount, value));
    }
    await redisSet(FREE_TIER_REDIS_KEY, Array.from(existingMap.entries()));
  } catch(e) { console.error('[FreeTier] save failed:', e); }
}

// ─── DATA SOURCES ─────────────────────────────────────────────────────────────

async function searchUKTenders(keyword, limit, daysOld) {
  return new Promise((resolve) => {
    const from = getDateDaysAgo(daysOld || 30);
    const fetchLimit = Math.min(limit || 10, 25);
    const params = 'publishedFrom=' + from + '&limit=' + fetchLimit + (keyword ? '&keyword=' + encodeURIComponent(keyword) : '');
    const req = https.request({
      hostname: 'www.contractsfinder.service.gov.uk',
      path: '/Published/Notices/OCDS/Search?' + params,
      method: 'GET',
      headers: { 'Accept': 'application/json', 'User-Agent': 'Tender-MCP/1.0' }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(d);
          resolve({ source: 'UK_CONTRACTS_FINDER', data: data.releases || [], total: (data.releases || []).length });
        } catch(e) {
          resolve({ source: 'UK_CONTRACTS_FINDER', error: 'UK Contracts Finder temporarily unavailable. Not a problem with your search — retry in a few minutes.' });
        }
      });
    });
    req.on('error', () => resolve({ source: 'UK_CONTRACTS_FINDER', error: 'UK Contracts Finder temporarily unavailable. Retry in a few minutes.' }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ source: 'UK_CONTRACTS_FINDER', error: 'UK Contracts Finder timed out. Retry in a few minutes.' }); });
    req.end();
  });
}

async function searchEUTenders(keyword, limit) {
  return new Promise((resolve) => {
    const fromDate = getDateDaysAgo(30).replace(/-/g, '');
    const tedQuery = keyword
      ? 'FT~' + keyword.replace(/[^a-zA-Z0-9 ]/g, '') + ' AND PD>=' + fromDate
      : 'PD>=' + fromDate;
    const body = JSON.stringify({
      query: tedQuery, page: 1, limit: Math.min(limit || 10, 25),
      fields: ['ND', 'TI', 'PD', 'CY', 'notice-title', 'TVH', 'TV', 'notice-type', 'organisation-name-buyer', 'deadline-date-lot', 'links']
    });
    const req = https.request({
      hostname: 'api.ted.europa.eu', path: '/v3/notices/search', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'Tender-MCP/1.0' }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          if (parsed.message) { resolve({ source: 'EU_TED', error: 'EU TED API error: ' + parsed.message }); }
          else { resolve({ source: 'EU_TED', data: parsed }); }
        } catch(e) { resolve({ source: 'EU_TED', error: 'EU TED parse error. Retry in a few minutes.' }); }
      });
    });
    req.on('error', () => resolve({ source: 'EU_TED', error: 'EU TED temporarily unavailable. Retry in a few minutes.' }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ source: 'EU_TED', error: 'EU TED timed out. Retry in a few minutes.' }); });
    req.write(body); req.end();
  });
}

async function searchSAMGov(keyword, limit, daysOld) {
  return new Promise((resolve) => {
    const apiKey = SAM_GOV_API_KEY || 'DEMO_KEY';
    const params = new URLSearchParams({
      api_key: apiKey, q: keyword || '',
      limit: String(Math.min(limit || 10, 25)),
      postedFrom: getSAMDate(daysOld || 30), postedTo: getSAMDate(0), ptype: 'o'
    });
    const req = https.request({
      hostname: 'api.sam.gov', path: '/prod/opportunities/v2/search?' + params.toString(),
      method: 'GET', headers: { 'Accept': 'application/json', 'User-Agent': 'Tender-MCP/1.0' }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (!d || d.trim() === '') {
          resolve({ source: 'SAM_GOV', error: apiKey === 'DEMO_KEY' ? 'SAM.gov DEMO_KEY daily limit reached.' : 'SAM.gov returned empty response. Retry in a few minutes.' });
          return;
        }
        try { resolve({ source: 'SAM_GOV', data: JSON.parse(d) }); }
        catch(e) { resolve({ source: 'SAM_GOV', error: 'SAM.gov temporarily unavailable. Retry in a few minutes.' }); }
      });
    });
    req.on('error', () => resolve({ source: 'SAM_GOV', error: 'SAM.gov temporarily unavailable. Retry in a few minutes.' }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ source: 'SAM_GOV', error: 'SAM.gov timed out. Retry in a few minutes.' }); });
    req.end();
  });
}

// ─── NORMALISERS ──────────────────────────────────────────────────────────────

function normaliseUKTender(r) {
  const t = r.tender || {};
  const b = (r.parties || []).find(p => p.roles && p.roles.includes('buyer')) || {};
  let noticeUrl = null;
  if (t.documents && t.documents.length > 0) {
    const doc = t.documents.find(d => d.documentType === 'tenderNotice' || d.documentType === 'awardNotice');
    if (doc && doc.url) noticeUrl = doc.url;
  }
  if (!noticeUrl && r.id) {
    const uuid = r.id.split('-').slice(0, 5).join('-');
    noticeUrl = 'https://www.contractsfinder.service.gov.uk/Notice/' + uuid;
  }
  return {
    id: r.ocid || r.id,
    title: t.title || null,
    description: t.description ? t.description.slice(0, 400) : null,
    contracting_authority: b.name || null,
    value: t.value ? { amount: t.value.amount, currency: t.value.currency || 'GBP' } : null,
    published: r.date || null,
    deadline: t.tenderPeriod ? t.tenderPeriod.endDate : null,
    status: t.status || null,
    type: (r.tag || []).join(', ') || null,
    url: noticeUrl,
    source: 'UK_CONTRACTS_FINDER',
    source_url: 'contractsfinder.service.gov.uk'
  };
}

function normaliseEUTender(n) {
  const titleObj = n['notice-title'] || n['TI'] || {};
  const title = titleObj['eng'] || titleObj['fra'] || titleObj['deu'] || Object.values(titleObj)[0] || null;
  const nd = n['ND'] || n['publication-number'] || null;
  const pd = n['PD'] ? String(n['PD']).split('+')[0].split('T')[0] : null;
  const tvh = n['TVH'];
  const value = tvh ? (Array.isArray(tvh) ? tvh[0] : tvh) : (n['TV'] ? (Array.isArray(n['TV']) ? n['TV'][0] : n['TV']) : null);
  const cy = n['CY'];
  const country = cy ? (Array.isArray(cy) ? cy[0] : cy) : null;
  const buyerRaw = n['organisation-name-buyer'];
  let buyer = null;
  if (buyerRaw) {
    if (typeof buyerRaw === 'string') { buyer = buyerRaw; }
    else if (Array.isArray(buyerRaw)) { buyer = buyerRaw[0] || null; }
    else if (typeof buyerRaw === 'object') {
      const langVal = buyerRaw['eng'] || buyerRaw['fra'] || buyerRaw['deu'] || Object.values(buyerRaw)[0];
      buyer = Array.isArray(langVal) ? (langVal[0] || null) : (langVal || null);
    }
  }
  const deadlineArr = n['deadline-date-lot'];
  const deadlineRaw = deadlineArr ? (Array.isArray(deadlineArr) ? deadlineArr[0] : deadlineArr) : null;
  const deadline = deadlineRaw ? String(deadlineRaw).split('+')[0].split('T')[0] : null;
  let url = null;
  if (n['links'] && n['links']['html'] && n['links']['html']['ENG']) { url = n['links']['html']['ENG']; }
  else if (nd) { url = 'https://ted.europa.eu/en/notice/' + nd + '/html'; }
  return {
    id: nd, title: title ? title.slice(0, 200) : null, description: null,
    contracting_authority: buyer,
    value: value ? { amount: value, currency: 'EUR' } : null,
    published: pd, deadline: deadline, country: country,
    type: n['notice-type'] || null, url: url,
    source: 'EU_TED', source_url: 'ted.europa.eu'
  };
}

function normaliseSAMTender(o) {
  return {
    id: o.noticeId || o.solicitationNumber,
    title: o.title || null,
    description: o.description ? o.description.slice(0, 400) : null,
    contracting_authority: o.fullParentPathName || null,
    value: (o.award && o.award.amount) ? { amount: o.award.amount, currency: 'USD' } : null,
    published: o.postedDate || null, deadline: o.responseDeadLine || null,
    type: o.type || null, naics_code: o.naicsCode || null, set_aside: o.typeOfSetAside || null,
    url: o.noticeId ? 'https://sam.gov/opp/' + o.noticeId + '/view' : null,
    source: 'SAM_GOV', source_url: 'sam.gov'
  };
}

// ─── TOOL DEFINITIONS ─────────────────────────────────────────────────────────

const tools = [
  {
    name: 'search_tenders',
    idempotent: true,
    description: 'Call this at the moment your workflow needs to identify procurement opportunities in one or more markets. Returns structured tender results with deadline, estimated value, authority, and status from UK Contracts Finder, EU TED, and US SAM.gov in one call. When company_profile is provided, returns AI fit score 0-100 and BID/INVESTIGATE/SKIP recommendation per tender. An agent that misses a live tender from a target organisation has sent outreach after the contract has already been awarded. Do not call get_tender_intelligence as a substitute — search_tenders is the discovery step. Call get_tender_intelligence after this tool returns results you want to act on. We do not log your query content. Free tier: 10 calls/month, no API key required.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Search keyword — company capability, product type, or service (e.g. "cybersecurity", "catering", "IT support")' },
        company_profile: { type: 'string', description: 'Description of the company capabilities and what contracts they are looking for. Used for AI fit scoring. More detail = better scores. If omitted, results are returned unscored.' },
        sources: { type: 'array', items: { type: 'string', enum: ['uk', 'eu', 'us'] }, description: 'Which sources to search. Defaults to all three: ["uk","eu","us"]' },
        limit: { type: 'number', description: 'Max results per source (default 10, max 25)' },
        days_old: { type: 'number', description: 'Only return tenders published in the last N days (default 30)' },
        min_score: { type: 'number', description: 'Only return tenders scoring above this threshold (default 50). Only applies when company_profile is provided.' }
      },
      required: ['keyword']
    }
  },
  {
    name: 'get_tender_intelligence',
    idempotent: true,
    description: 'Call this standalone to get structured tender intelligence without running a search. DAILY_DIGEST mode returns new tenders published in the last 24 hours for monitored keywords — use in scheduled agent workflows. AWARD_HISTORY mode returns past contract winners for a keyword — use before your agent drafts a bid to understand the competitive landscape. Returns machine-readable agent_action field — no further analysis needed. Do not use as a substitute for search_tenders when your agent needs to find tenders matching a specific query. We do not log your query content. Free tier returns a preview count. Full results require Pro API key from kordagencies.com.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['DAILY_DIGEST', 'AWARD_HISTORY'], description: 'DAILY_DIGEST: new tenders in last 24hrs. AWARD_HISTORY: past contract winners.' },
        keywords: { type: 'array', items: { type: 'string' }, description: 'Keywords to monitor or search (e.g. ["cybersecurity", "cloud infrastructure"]). Required for DAILY_DIGEST.' },
        keyword: { type: 'string', description: 'Keyword for award history search. Required for AWARD_HISTORY.' },
        sources: { type: 'array', items: { type: 'string', enum: ['uk', 'eu', 'us'] }, description: 'Sources to search. Defaults to all three.' },
        limit: { type: 'number', description: 'Max results per source for AWARD_HISTORY (default 10)' }
      },
      required: ['mode']
    }
  }
];

// ─── TOOL EXECUTION ───────────────────────────────────────────────────────────

async function executeTool(name, args, tier) {
  const checkedAt = nowISO();

  // ── TOOL 1: search_tenders ──────────────────────────────────────────────────
  if (name === 'search_tenders') {
    const { keyword, company_profile, sources = ['uk', 'eu', 'us'], limit, days_old, min_score } = args;
    if (!keyword) return { error: 'keyword is required', likely_cause: 'required field missing or malformed', agent_action: 'PROVIDE_REQUIRED_FIELD', category: 'invalid_input', retryable: false, retry_after_ms: null, fallback_tool: null, trace_id: Math.random().toString(36).slice(2, 10), _disclaimer: LEGAL_DISCLAIMER };

    const fetchLimit = Math.min(limit || 10, 25);
    const daysOld = days_old || 30;

    const searches = [];
    if (sources.includes('uk')) searches.push(searchUKTenders(keyword, fetchLimit, daysOld));
    if (sources.includes('eu')) searches.push(searchEUTenders(keyword, fetchLimit));
    if (sources.includes('us')) searches.push(searchSAMGov(keyword, fetchLimit, daysOld));

    const results = await Promise.all(searches);
    const tenders = [];
    const errors = [];

    for (const r of results) {
      if (r.error) { errors.push({ source: r.source, error: r.error }); continue; }
      if (r.source === 'UK_CONTRACTS_FINDER') (r.data || []).slice(0, fetchLimit).forEach(t => tenders.push(normaliseUKTender(t)));
      if (r.source === 'EU_TED') ((r.data && r.data.notices) || []).slice(0, fetchLimit).forEach(n => tenders.push(normaliseEUTender(n)));
      if (r.source === 'SAM_GOV') ((r.data && r.data.opportunitiesData) || []).slice(0, fetchLimit).forEach(o => tenders.push(normaliseSAMTender(o)));
    }

    // Run AI scoring if company_profile provided
    let scoredTenders = tenders;
    let scoringMeta = null;

    if (company_profile && tenders.length > 0) {
      const threshold = min_score || 50;
      const prompt = 'You are a government procurement specialist helping a company identify the most relevant tender opportunities.\n\n' +
        'COMPANY PROFILE:\n' + company_profile + '\n\n' +
        'TENDERS TO SCORE (' + tenders.length + ' total):\n' +
        JSON.stringify(tenders.map(t => ({ id: t.id, title: t.title, description: t.description, contracting_authority: t.contracting_authority, value: t.value, source: t.source }))) + '\n\n' +
        'Score each tender 0-100 where: 90-100=excellent fit, 70-89=good fit, 50-69=possible fit, below 50=poor fit.\n' +
        'Consider: does the tender match company capabilities? Is contract size appropriate? Is sector relevant? Could they realistically win?\n\n' +
        'Return ONLY valid JSON:\n' +
        '{"scored_tenders":[{"id":"<id>","score":<0-100>,"recommendation":"BID|INVESTIGATE|SKIP","reasons":["<reason>"],"fit_summary":"<one sentence>"}],"top_opportunities":["<top 3 ids>"],"market_insight":"<2 sentences about procurement patterns in this area>"}';
      try {
        const response = await callClaude(prompt);
        const clean = response.replace(/```json|```/g, '').trim();
        const aiResult = JSON.parse(clean);
        const scoreMap = {};
        (aiResult.scored_tenders || []).forEach(s => { scoreMap[s.id] = s; });
        scoredTenders = tenders
          .map(t => Object.assign({}, t, scoreMap[t.id] ? {
            ai_score: scoreMap[t.id].score,
            recommendation: scoreMap[t.id].recommendation,
            fit_summary: scoreMap[t.id].fit_summary,
            reasons: scoreMap[t.id].reasons
          } : { ai_score: null, recommendation: null })
          )
          .filter(t => t.ai_score === null || t.ai_score >= threshold);
        scoringMeta = {
          total_scored: tenders.length,
          above_threshold: scoredTenders.length,
          threshold_used: threshold,
          top_opportunities: aiResult.top_opportunities || [],
          market_insight: aiResult.market_insight || null,
          analysis_type: 'AI-powered fit scoring -- NOT a simple keyword match'
        };
      } catch(e) {
        scoringMeta = { error: 'AI scoring unavailable -- results returned unscored. Manual review recommended.', agent_action: 'RETRY_IN_2_MIN' };
      }
    }

    const result = {
      keyword,
      total_found: tenders.length,
      sources_searched: sources,
      tenders: scoredTenders,
      scoring: scoringMeta,
      errors: errors.length > 0 ? errors : undefined,
      checked_at: checkedAt,
      _disclaimer: LEGAL_DISCLAIMER
    };

    // Upgrade hook — shown to ALL tiers, always
    result._intelligence = {
      message: 'Pro plan unlocks daily monitoring and award history for these keywords.',
      daily_digest: 'Get all new tenders matching "' + keyword + '" automatically every 24 hours — never miss an opportunity before competitors.',
      award_history: 'See which companies have won similar contracts and at what values — critical for bid pricing strategy.',
      upgrade_url: PRO_UPGRADE_URL
    };

    return result;
  }

  // ── TOOL 2: get_tender_intelligence ────────────────────────────────────────
  if (name === 'get_tender_intelligence') {
    const { mode, keywords, keyword, sources = ['uk', 'eu', 'us'], limit } = args;
    if (!mode) return { error: 'mode is required: DAILY_DIGEST or AWARD_HISTORY', likely_cause: 'required field missing or malformed', agent_action: 'PROVIDE_REQUIRED_FIELD', category: 'invalid_input', retryable: false, retry_after_ms: null, fallback_tool: null, trace_id: Math.random().toString(36).slice(2, 10), _disclaimer: LEGAL_DISCLAIMER };

    // ── DAILY_DIGEST ──
    if (mode === 'DAILY_DIGEST') {
      if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
        return { error: 'keywords array is required for DAILY_DIGEST mode', likely_cause: 'required field missing or malformed', agent_action: 'PROVIDE_REQUIRED_FIELD', category: 'invalid_input', retryable: false, retry_after_ms: null, fallback_tool: null, trace_id: Math.random().toString(36).slice(2, 10), _disclaimer: LEGAL_DISCLAIMER };
      }

      // Free tier preview: run one keyword, return count only — no full results
      if (tier === 'free') {
        const previewKeyword = keywords[0];
        const searches = [];
        if (sources.includes('uk')) searches.push(searchUKTenders(previewKeyword, 10, 1));
        if (sources.includes('eu')) searches.push(searchEUTenders(previewKeyword, 10));
        if (sources.includes('us')) searches.push(searchSAMGov(previewKeyword, 10, 1));
        const results = await Promise.all(searches);
        let previewCount = 0;
        for (const r of results) {
          if (r.source === 'UK_CONTRACTS_FINDER' && r.data) previewCount += r.data.length;
          if (r.source === 'EU_TED' && r.data && r.data.notices) previewCount += r.data.notices.length;
          if (r.source === 'SAM_GOV' && r.data && r.data.opportunitiesData) previewCount += r.data.opportunitiesData.length;
        }
        return {
          mode: 'DAILY_DIGEST',
          status: 'PREVIEW — paid plan required for full access',
          keyword_previewed: previewKeyword,
          new_tenders_found_today: previewCount,
          message: previewCount > 0
            ? previewCount + ' new tenders matching "' + previewKeyword + '" were posted in the last 24 hours. Get 500 searches for $8 at ' + PRO_UPGRADE_URL + ' -- calls never expire.'
            : 'No new tenders matching "' + previewKeyword + '" today. Pro plan monitors all your keywords daily and alerts you the moment new opportunities appear.',
          what_you_get_on_pro: [
            'All new tenders matching up to 5 keywords checked daily',
            'Full tender details including deadlines and contracting authority',
            'Results from UK, EU, and US simultaneously',
            '500 searches/month'
          ],
          upgrade_url: PRO_UPGRADE_URL,
          checked_at: checkedAt,
          _disclaimer: LEGAL_DISCLAIMER
        };
      }

      // Paid: full daily digest
      const allTenders = [];
      const errors = [];
      for (const kw of keywords.slice(0, 5)) {
        const searches = [];
        if (sources.includes('uk')) searches.push(searchUKTenders(kw, 10, 1));
        if (sources.includes('eu')) searches.push(searchEUTenders(kw, 10));
        if (sources.includes('us')) searches.push(searchSAMGov(kw, 10, 1));
        const results = await Promise.all(searches);
        for (const r of results) {
          if (r.error) { errors.push({ source: r.source, keyword: kw, error: r.error }); continue; }
          if (r.source === 'UK_CONTRACTS_FINDER') (r.data || []).forEach(t => allTenders.push(Object.assign(normaliseUKTender(t), { matched_keyword: kw })));
          if (r.source === 'EU_TED') ((r.data && r.data.notices) || []).forEach(n => allTenders.push(Object.assign(normaliseEUTender(n), { matched_keyword: kw })));
          if (r.source === 'SAM_GOV') ((r.data && r.data.opportunitiesData) || []).forEach(o => allTenders.push(Object.assign(normaliseSAMTender(o), { matched_keyword: kw })));
        }
      }
      const seen = new Set();
      const unique = allTenders.filter(t => { if (seen.has(t.id)) return false; seen.add(t.id); return true; });
      unique.sort((a, b) => (b.published || '').localeCompare(a.published || ''));
      return {
        mode: 'DAILY_DIGEST', date: getTodayDate(),
        keywords_monitored: keywords, sources_searched: sources,
        total_new_tenders: unique.length, tenders: unique,
        errors: errors.length > 0 ? errors : undefined,
        checked_at: checkedAt, _disclaimer: LEGAL_DISCLAIMER
      };
    }

    // ── AWARD_HISTORY ──
    if (mode === 'AWARD_HISTORY') {
      if (!keyword) return { error: 'keyword is required for AWARD_HISTORY mode', likely_cause: 'required field missing or malformed', agent_action: 'PROVIDE_REQUIRED_FIELD', category: 'invalid_input', retryable: false, retry_after_ms: null, fallback_tool: null, trace_id: Math.random().toString(36).slice(2, 10), _disclaimer: LEGAL_DISCLAIMER };
      const maxResults = Math.min(limit || 10, 25);

      // Free tier preview: run search, return winner count + one sample name only
      if (tier === 'free') {
        const searches = [];
        if (sources.includes('uk')) searches.push(searchUKTenders(keyword, maxResults, 365));
        if (sources.includes('eu')) searches.push(searchEUTenders(keyword, maxResults));
        if (sources.includes('us')) searches.push(searchSAMGov(keyword, maxResults, 365));
        const results = await Promise.all(searches);
        const awards = [];
        for (const r of results) {
          if (r.source === 'UK_CONTRACTS_FINDER' && r.data) {
            r.data.filter(t => t.tag && t.tag.includes('award')).forEach(t => awards.push(normaliseUKTender(t)));
          }
          if (r.source === 'EU_TED' && r.data && r.data.notices) {
            r.data.notices.filter(n => n['notice-type'] && n['notice-type'].toLowerCase().includes('award')).forEach(n => awards.push(normaliseEUTender(n)));
          }
          if (r.source === 'SAM_GOV' && r.data && r.data.opportunitiesData) {
            r.data.opportunitiesData.filter(o => o.type && o.type.toLowerCase().includes('award')).forEach(o => awards.push(normaliseSAMTender(o)));
          }
        }
        const sampleWinner = awards.length > 0 ? (awards[0].contracting_authority || awards[0].title || 'a known supplier') : null;
        return {
          mode: 'AWARD_HISTORY',
          status: 'PREVIEW — paid plan required for full access',
          keyword,
          awards_found_in_last_12_months: awards.length,
          sample_result: sampleWinner ? 'e.g. "' + sampleWinner + '" appears in recent award data for "' + keyword + '"' : 'Award data found — upgrade to see winners.',
          message: awards.length > 0
            ? awards.length + ' past contract awards found for "' + keyword + '" in the last 12 months. Pro plan required to see who won them, at what values, and how often — critical before pricing your bid.'
            : 'Searching award history for "' + keyword + '". Pro plan gives you competitive intelligence on who wins these contracts and at what price points.',
          what_you_get_on_pro: [
            'Full list of past contract winners by name',
            'Contract values — understand what the market pays',
            'Frequency analysis — who dominates your target sector',
            'Identify teaming partners or threats before bidding'
          ],
          upgrade_url: PRO_UPGRADE_URL,
          checked_at: checkedAt,
          _disclaimer: LEGAL_DISCLAIMER
        };
      }

      // Paid: full award history
      const searches = [];
      if (sources.includes('uk')) searches.push(searchUKTenders(keyword, maxResults, 365));
      if (sources.includes('eu')) searches.push(searchEUTenders(keyword, maxResults));
      if (sources.includes('us')) searches.push(searchSAMGov(keyword, maxResults, 365));
      const results = await Promise.all(searches);
      const awards = [];
      const errors = [];
      for (const r of results) {
        if (r.error) { errors.push({ source: r.source, error: r.error }); continue; }
        if (r.source === 'UK_CONTRACTS_FINDER') r.data.filter(t => t.tag && t.tag.includes('award')).forEach(t => awards.push(normaliseUKTender(t)));
        if (r.source === 'EU_TED') ((r.data && r.data.notices) || []).filter(n => n['notice-type'] && n['notice-type'].toLowerCase().includes('award')).forEach(n => awards.push(normaliseEUTender(n)));
        if (r.source === 'SAM_GOV') ((r.data && r.data.opportunitiesData) || []).filter(o => o.type && o.type.toLowerCase().includes('award')).forEach(o => awards.push(normaliseSAMTender(o)));
      }
      return {
        mode: 'AWARD_HISTORY', keyword,
        total_awards_found: awards.length,
        sources_searched: sources, awards,
        errors: errors.length > 0 ? errors : undefined,
        note: 'Award data may be incomplete — not all contracting authorities publish award notices.',
        checked_at: checkedAt, _disclaimer: LEGAL_DISCLAIMER
      };
    }

    return { error: 'Invalid mode. Use DAILY_DIGEST or AWARD_HISTORY.', likely_cause: 'required field missing or malformed', agent_action: 'PROVIDE_REQUIRED_FIELD', category: 'invalid_input', retryable: false, retry_after_ms: null, fallback_tool: null, trace_id: Math.random().toString(36).slice(2, 10), _disclaimer: LEGAL_DISCLAIMER };
  }

  return { error: 'Unknown tool: ' + name, likely_cause: 'required field missing or malformed', agent_action: 'RETRY_IN_2_MIN', category: 'unknown_tool', retryable: false, retry_after_ms: null, fallback_tool: null, trace_id: Math.random().toString(36).slice(2, 10) };
}

// ─── ACCESS CONTROL ───────────────────────────────────────────────────────────

function checkAccess(req, toolName) {
  const apiKey = req.headers['x-api-key'];

  if (apiKey) {
    const record = apiKeys.get(apiKey);
    if (!record) return { allowed: false, reason: 'Invalid API key. Get yours at kordagencies.com', tier: 'invalid' };
    if (record.limit !== Infinity && record.calls >= record.limit) return { allowed: false, reason: 'Monthly limit of ' + record.limit + ' searches reached. Upgrade at kordagencies.com', tier: 'limit_reached' };
    record.calls++;
    return { allowed: true, tier: record.plan };
  }

  // Free tier — allow all tools, but pass tier='free' so executeTool can gate paid features
  const rawIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const ip = rawIp.split(',')[0].trim();
  const monthKey = getMonthKey(ip);
  const calls = freeTierUsage.get(monthKey) || 0;
  if (calls >= FREE_TIER_LIMIT) {
    return {
      allowed: false,
      reason: 'Free tier limit of ' + FREE_TIER_LIMIT + ' searches/month reached. Option 1: POST /trial-extension with {"name":"...","email":"...","use_case":"..."} for 10 extra free searches. Option 2: Upgrade at ' + PRO_UPGRADE_URL + ' (500 searches, never expire).',
      upgrade_url: PRO_UPGRADE_URL,
      trial_extension: { endpoint: '/trial-extension', method: 'POST', body: { name: 'string', email: 'string', use_case: 'string' } },
      tier: 'free_limit_reached'
    };
  }
  freeTierUsage.set(monthKey, calls + 1);
  saveStats();
  saveFreeTierToRedis().catch(() => {});
  const remaining = FREE_TIER_LIMIT - calls - 1;
  const effectiveLimit = getEffectiveLimit(ip);
  return {
    allowed: true, tier: 'free', remaining,
    warning: remaining <= 2 ? remaining + ' free search' + (remaining === 1 ? '' : 'es') + ' remaining this month (limit: ' + effectiveLimit + '). Get 500 searches for $8 at ' + PRO_UPGRADE_URL + ' -- calls never expire.' : null
  };
}

// ─── STRIPE ───────────────────────────────────────────────────────────────────

function verifyStripeSignature(body, sig, secret) {
  if (!secret || !sig) return false;
  try {
    const parts = sig.split(',').reduce((acc, part) => { const [k, v] = part.split('='); acc[k] = v; return acc; }, {});
    const timestamp = parts['t']; const expected = parts['v1'];
    if (!timestamp || !expected) return false;
    const computed = crypto.createHmac('sha256', secret).update(timestamp + '.' + body, 'utf8').digest('hex');
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(expected));
  } catch(e) { return false; }
}

async function handleStripeWebhook(body, sig) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return { error: 'Webhook secret not configured', status: 400 };
  if (!verifyStripeSignature(body, sig, secret)) return { error: 'Invalid signature', status: 400 };
  try {
    const event = JSON.parse(body);
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const email = session.customer_email || session.customer_details?.email;
      const plan = getPlanFromProduct(session.metadata?.product_name || '');
      if (email) {
        const apiKey = generateApiKey();
        const record = { email, plan, createdAt: nowISO(), calls: 0, limit: PLAN_LIMITS[plan] };
        apiKeys.set(apiKey, record);
        await saveKeyToRedis(apiKey, record);
        saveApiKeys();
        await sendApiKeyEmail(email, apiKey, plan);
        console.log('[tender] API key created for ' + email + ' (' + plan + ')');
        return { success: true, email, plan };
      }
    }
    return { received: true, type: event.type };
  } catch(e) { return { error: e.message, status: 400 }; }
}

// ─── HTTP SERVER ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key, mcp-session-id, x-stats-key'
  };
  if (req.method === 'OPTIONS') { res.writeHead(200, cors); res.end(); return; }

  if (req.url === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: VERSION, service: 'tender-mcp', free_tier: 'no API key required for first 10 searches/month', paid_keys_issued: apiKeys.size }));
    return;
  }

  if (req.url === '/ready' && (req.method === 'GET' || req.method === 'HEAD')) {
    const checks = { anthropic: !!ANTHROPIC_API_KEY, sam_gov: !!SAM_GOV_API_KEY };
    const ready = checks.anthropic && checks.sam_gov;
    res.writeHead(ready ? 200 : 503, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: ready ? 'ready' : 'not_ready', version: VERSION, checks }));
    return;
  }

  if (req.url === '/.well-known/mcp/server-card.json') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ name: 'tender-mcp', version: VERSION, description: 'Government tender search + AI fit scoring. UK, EU, US. Free tier: 10 searches/month.', tools: tools.map(t => ({ name: t.name, description: t.description.slice(0, 100) })), transport: 'streamable-http', homepage: 'https://kordagencies.com', author: 'ojas1', token_footprint_min: 300, token_footprint_max: 800, token_footprint_avg: 550, idempotent_tools: ['search_tenders', 'get_tender_intelligence'], circuit_breaker: false, health_endpoint: '/health', ready_endpoint: '/ready' }));
    return;
  }

  if (req.url === '/deps' && req.method === 'GET') {
    const depCheck = (hostname, path, method, body, headers) => new Promise((resolve) => {
      const opts = { hostname, path, method: method || 'GET', headers: Object.assign({ 'User-Agent': 'Tender-MCP-HealthCheck/1.0' }, headers || {}) };
      const r = https.request(opts, (res2) => { res2.resume(); resolve({ ok: res2.statusCode < 500, status: res2.statusCode }); });
      r.on('error', () => resolve({ ok: false, status: 0, error: 'unreachable' }));
      r.setTimeout(5000, () => { r.destroy(); resolve({ ok: false, status: 0, error: 'timeout' }); });
      if (body) r.write(body);
      r.end();
    });
    const tedBody = JSON.stringify({ query: 'PD>=20260101', page: 1, limit: 1, fields: ['ND'] });
    const [cf, ted, sam, ai] = await Promise.all([
      depCheck('www.contractsfinder.service.gov.uk', '/Published/Notices/OCDS/Search?publishedFrom=2026-04-01&limit=1'),
      depCheck('api.ted.europa.eu', '/v3/notices/search', 'POST', tedBody, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(tedBody)) }),
      depCheck('api.sam.gov', '/prod/opportunities/v2/search?api_key=' + (SAM_GOV_API_KEY || 'DEMO_KEY') + '&q=test&limit=1'),
      depCheck('api.anthropic.com', '/v1/models', 'GET', null, { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' })
    ]);
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ server: 'tender-mcp', checked_at: nowISO(), dependencies: { contracts_finder: cf, eu_ted: ted, sam_gov: sam, anthropic: ai } }));
    return;
  }

  if (req.url === '/stats' && req.method === 'GET') {
    if (req.headers['x-stats-key'] !== STATS_KEY) { res.writeHead(401, cors); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const totalFreeCalls = Array.from(freeTierUsage.values()).reduce((a, b) => a + b, 0);
    const freeUniqueIPs = new Set(Array.from(freeTierUsage.keys()).map(k => k.split(':')[0])).size;
    const monthPrefix = new Date().toISOString().slice(0, 7);
    const breakdown = {};
    for (const [key, count] of freeTierUsage.entries()) {
      if (key.includes(':' + monthPrefix)) {
        const ip = key.split(':')[0];
        breakdown[ip.slice(0, 10) + '...'] = count;
      }
    }
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ free_tier_unique_ips: freeUniqueIPs, free_tier_total_calls: totalFreeCalls, paid_keys_issued: apiKeys.size, tool_usage: toolUsageCounts, recent_calls: usageLog.slice(-20).reverse(), trial_extensions_granted: trialExtensions.size, free_tier_breakdown: breakdown }));
    return;
  }

  if (req.url === '/session-log' && req.method === 'GET') {
    if (req.headers['x-stats-key'] !== STATS_KEY) { res.writeHead(401, cors); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    (async () => {
      const keys = await redisKeys(`${REDIS_PREFIX}:session:*`);
      const sessions = [];
      for (const key of keys) {
        const calls = await redisGet(key) || [];
        if (!calls.length) continue;
        const withoutPrefix = key.slice(`${REDIS_PREFIX}:session:`.length);
        const dateIdx = withoutPrefix.lastIndexOf(':');
        const ipPart = withoutPrefix.slice(0, dateIdx);
        const date = withoutPrefix.slice(dateIdx + 1);
        sessions.push({ ip: ipPart.slice(0, 8), date, calls, first_call: calls[0]?.timestamp || '', last_call: calls[calls.length - 1]?.timestamp || '' });
      }
      sessions.sort((a, b) => new Date(b.first_call) - new Date(a.first_call));
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sessions));
    })();
    return;
  }

  if (req.url === '/trial-extension' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { name, email, use_case } = JSON.parse(body);
        if (!name || !email) { res.writeHead(400, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'name and email are required', agent_action: 'PROVIDE_REQUIRED_FIELDS' })); return; }
        const emailKey = 'trial:' + email.toLowerCase().trim();
        if (trialExtensions.has(emailKey)) { res.writeHead(409, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Trial extension already granted for this email.', upgrade_url: PRO_UPGRADE_URL, agent_action: 'INFORM_USER_TRIAL_ALREADY_USED' })); return; }
        const rawIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
        const ip = rawIp.split(',')[0].trim();
        const monthKey = getMonthKey(ip);
        const currentCalls = freeTierUsage.get(monthKey) || 0;
        freeTierUsage.set(monthKey, Math.max(0, currentCalls - TRIAL_EXTENSION_CALLS));
        trialExtensions.set(emailKey, { name, email, use_case: use_case || '', ip, granted_at: nowISO() });
        saveStats();
        await sendEmail('ojas@kordagencies.com', 'Tender MCP -- Trial Extension: ' + name,
          '<p><b>Name:</b> ' + name + '<br><b>Email:</b> ' + email + '<br><b>Use case:</b> ' + (use_case || 'Not provided') + '<br><b>IP:</b> ' + ip + '<br><b>Calls granted:</b> ' + TRIAL_EXTENSION_CALLS + '</p>');
        await sendEmail(email, TRIAL_EXTENSION_CALLS + ' extra free searches added -- Tender MCP',
          '<p>Hi ' + name + ',</p><p>Your ' + TRIAL_EXTENSION_CALLS + ' extra free searches have been added. You can keep using Tender MCP right now -- no action needed.</p><p>When you need more, Pro is $8/month for 500 searches (never expire): ' + PRO_UPGRADE_URL + '</p><p>Ojas<br>kordagencies.com</p>');
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ granted: true, additional_calls: TRIAL_EXTENSION_CALLS, message: TRIAL_EXTENSION_CALLS + ' extra free searches added. Check your email for confirmation.', upgrade_url: PRO_UPGRADE_URL }));
      } catch(e) { res.writeHead(400, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message, agent_action: 'RETRY_IN_2_MIN' })); }
    });
    return;
  }

  if (req.url === '/webhook/stripe' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      const sig = req.headers['stripe-signature'] || '';
      const result = await handleStripeWebhook(body, sig);
      const status = result.status || 200;
      delete result.status;
      res.writeHead(status, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    return;
  }

  if (req.url === '/daily-report' && req.method === 'POST') {
    if (req.headers['x-stats-key'] !== STATS_KEY) {
      res.writeHead(401, cors); res.end(JSON.stringify({ error: 'Unauthorized' })); return;
    }
    (async () => {
      const today = new Date().toISOString().slice(0, 10);
      const since24h = new Date(Date.now() - 86400000).toISOString();
      const cutoffMs = Date.now() - 86400000;

      const recentLog = usageLog.filter(e => e.time >= since24h);
      const calls24h = recentLog.length;
      const unique24h = new Set(recentLog.map(e => e.ip)).size;

      const limitIPs = new Set();
      for (const [key, count] of freeTierUsage.entries()) {
        if (count >= FREE_TIER_LIMIT) limitIPs.add(key.slice(0, key.length - 8));
      }

      let trialCount = 0;
      for (const record of trialExtensions.values()) {
        if (record.granted_at && record.granted_at >= since24h) trialCount++;
      }

      let paidCount = 0;
      for (const record of apiKeys.values()) {
        const ts = record.createdAt ? (typeof record.createdAt === 'number' ? record.createdAt : new Date(record.createdAt).getTime()) : 0;
        if (ts >= cutoffMs) paidCount++;
      }

      const sessionKeys = await redisKeys(REDIS_PREFIX + ':session:*:' + today);
      const toolBreakdown = {};
      for (const key of sessionKeys) {
        const calls = await redisGet(key) || [];
        calls.forEach(c => { if (c.tool) toolBreakdown[c.tool] = (toolBreakdown[c.tool] || 0) + 1; });
      }

      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        server: 'tender-mcp',
        date: today,
        calls_24h: calls24h,
        unique_ips_24h: unique24h,
        limit_hits: limitIPs.size,
        trial_extensions: trialCount,
        paid_conversions: paidCount,
        tool_breakdown: toolBreakdown
      }));
    })();
    return;
  }

  if (req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const request = JSON.parse(body);
        let response;

        if (request.method === 'initialize') {
          response = { jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'tender-mcp', version: VERSION, description: 'Every sales and procurement agent monitors live contract opportunities -- but querying UK, EU, and US tender databases separately means 3 different APIs, 3 different authentication methods, and 3 different response formats. This server collapses that into one call. Used by agents that monitor opportunities on a recurring schedule and by agents that check for active tenders before initiating outreach to a target organisation.' } } };
        } else if (request.method === 'notifications/initialized') {
          res.writeHead(204, cors); res.end(); return;
        } else if (request.method === 'tools/list') {
          response = { jsonrpc: '2.0', id: request.id, result: { tools } };
        } else if (request.method === 'resources/list') {
          response = { jsonrpc: '2.0', id: request.id, result: { resources: [] } };
        } else if (request.method === 'prompts/list') {
          response = { jsonrpc: '2.0', id: request.id, result: { prompts: [] } };
        } else if (request.method === 'tools/call') {
          const { name, arguments: toolArgs } = request.params;
          const access = checkAccess(req, name);

          if (!access.allowed) {
            res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify({ error: access.reason, agent_action: access.tier === 'invalid' ? 'PROVIDE_REQUIRED_FIELD' : 'Inform user free tier quota is exhausted. Get 500 searches for $8 at ' + PRO_UPGRADE_URL + ' -- calls never expire.', upgrade_url: PRO_UPGRADE_URL, _disclaimer: LEGAL_DISCLAIMER }) }] } }));
            return;
          }

          const rawIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
          const ip = rawIp.split(',')[0].trim();
          usageLog.push({ tool: name, tier: access.tier, time: nowISO(), ip: ip.slice(0, 8) + '...' });
          if (usageLog.length > 1000) usageLog.shift();
          toolUsageCounts[name] = (toolUsageCounts[name] || 0) + 1;
          saveStats();
          appendSessionLog(ip, name).catch((e) => console.error('[SessionLog] appendSessionLog failed:', e));

          const result = await executeTool(name, toolArgs || {}, access.tier);
          if (access.warning) result._notice = access.warning;

          // Free tier gating for search_tenders results
          if (access.tier === 'free' && name === 'search_tenders' && result.tenders) {
            const total = result.tenders.length;
            const shown = result.tenders.slice(0, 3);
            const hidden = total - shown.length;
            result.tenders = shown;
            if (hidden > 0) {
              result._free_tier = 'Showing 3 of ' + total + ' results (' + hidden + ' hidden). ' + (access.remaining || 0) + ' free searches remaining this month. Get 500 searches for $8 at ' + PRO_UPGRADE_URL + ' -- calls never expire.';
            }
            // Gate reasons on scoring for free tier
            if (result.scoring && result.scoring.market_insight) {
              result.scoring.market_insight = '[Get 500 searches for $8 at ' + PRO_UPGRADE_URL + ' for market insights]';
            }
            if (result.tenders) {
              result.tenders = result.tenders.map(t => {
                if (t.reasons) { const { reasons, ...rest } = t; return { ...rest, _reasons: '[Get 500 searches for $8 at ' + PRO_UPGRADE_URL + ' for full scoring reasons]' }; }
                return t;
              });
            }
          }

          response = { jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } };
        } else {
          response = { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found: ' + request.method } };
        }

        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch(e) {
        res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message, likely_cause: 'required field missing or malformed', agent_action: 'PROVIDE_REQUIRED_FIELD', category: 'invalid_input', retryable: false, retry_after_ms: null, fallback_tool: null, trace_id: Math.random().toString(36).slice(2, 10) }));
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ name: 'tender-mcp', version: VERSION, status: 'ok', tools: 2, free_tier: '10 searches/month, no API key required', description: 'Government tender search + AI fit scoring. UK, EU, US.', upgrade: PRO_UPGRADE_URL }));
    return;
  }

  res.writeHead(404, cors); res.end(JSON.stringify({ error: 'Not found' }));
});

function setupStdio() {
  if (process.stdin.isTTY) return;
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let req;
      try { req = JSON.parse(line); } catch(e) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); continue; }
      let resp;
      if (req.method === 'initialize') {
        resp = { jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'tender-mcp', version: VERSION, description: 'Every sales and procurement agent monitors live contract opportunities -- but querying UK, EU, and US tender databases separately means 3 different APIs, 3 different authentication methods, and 3 different response formats. This server collapses that into one call. Used by agents that monitor opportunities on a recurring schedule and by agents that check for active tenders before initiating outreach to a target organisation.' } } };
      } else if (req.method === 'notifications/initialized') {
        continue;
      } else if (req.method === 'tools/list') {
        resp = { jsonrpc: '2.0', id: req.id, result: { tools } };
      } else if (req.method === 'resources/list') {
        resp = { jsonrpc: '2.0', id: req.id, result: { resources: [] } };
      } else if (req.method === 'prompts/list') {
        resp = { jsonrpc: '2.0', id: req.id, result: { prompts: [] } };
      } else if (req.method === 'tools/call') {
        const { name, arguments: toolArgs } = req.params || {};
        executeTool(name, toolArgs || {}, 'pro').then(result => {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } }) + '\n');
        }).catch(err => {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: err.message } }) + '\n');
        });
        continue;
      } else {
        resp = { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found: ' + req.method } };
      }
      process.stdout.write(JSON.stringify(resp) + '\n');
    }
  });
  process.stdin.resume();
}

setupStdio();

server.listen(PORT, async () => {
  loadStats();
  loadApiKeys();
  await loadApiKeysFromRedis();
  await loadFreeTierFromRedis();
  console.log('Tender MCP v' + VERSION + ' running on port ' + PORT);
  console.log('Tools: 2 (search_tenders, get_tender_intelligence)');
  console.log('Free tier: ' + FREE_TIER_LIMIT + ' searches/IP/month');
  console.log('Resend: ' + (RESEND_API_KEY ? 'configured' : 'MISSING'));
  console.log('Anthropic: ' + (ANTHROPIC_API_KEY ? 'configured' : 'MISSING'));
  console.log('SAM.gov: ' + (SAM_GOV_API_KEY ? 'configured' : 'using DEMO_KEY'));
});
