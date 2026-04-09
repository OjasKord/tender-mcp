const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

const PERSIST_FILE = '/tmp/tender_stats.json';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const SAM_GOV_API_KEY = process.env.SAM_GOV_API_KEY || '';
const PORT = process.env.PORT || 3000;
const STATS_KEY = process.env.STATS_KEY || 'ojas2026';

const freeTierUsage = new Map();
const usageLog = [];
const FREE_TIER_LIMIT = 10;
const apiKeys = new Map();
const PLAN_LIMITS = { pro: 500, enterprise: Infinity };

const LEGAL_DISCLAIMER = 'Tender data is sourced directly from official government portals: UK Contracts Finder (contractsfinder.service.gov.uk), EU TED (ted.europa.eu), and US SAM.gov (sam.gov). We do not log or store your query content. Tender deadlines and contract values may change — always verify directly with the contracting authority before submitting a bid. Results are for informational purposes only. Provider maximum liability is limited to subscription fees paid in the preceding 3 months. Full terms: kordagencies.com/terms.html';

function nowISO() { return new Date().toISOString(); }
function saveStats() {
  try {
    fs.writeFileSync(PERSIST_FILE, JSON.stringify({ freeTierUsage: Array.from(freeTierUsage.entries()), usageLog: usageLog.slice(-1000) }));
  } catch(e) { console.error('Stats save error:', e.message); }
}
function loadStats() {
  try {
    if (fs.existsSync(PERSIST_FILE)) {
      const data = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf8'));
      if (data.freeTierUsage) data.freeTierUsage.forEach(([k, v]) => freeTierUsage.set(k, v));
      if (data.usageLog) usageLog.push(...data.usageLog);
      console.log('Stats loaded: ' + freeTierUsage.size + ' IPs, ' + usageLog.length + ' calls');
    }
  } catch(e) { console.error('Stats load error:', e.message); }
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
    const body = JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d).content?.[0]?.text || ''); } catch(e) { reject(e); } }); });
    req.on('error', reject); req.write(body); req.end();
  });
}

function getTodayDate() {
  const d = new Date();
  return d.toISOString().split('T')[0];
}
function getDateDaysAgo(days) {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().split('T')[0];
}
function getSAMDate(daysAgo) {
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return (d.getMonth()+1).toString().padStart(2,'0') + '/' + d.getDate().toString().padStart(2,'0') + '/' + d.getFullYear();
}

async function searchUKTenders(keyword, limit, daysOld) {
  return new Promise((resolve) => {
    const from = getDateDaysAgo(daysOld || 30);
    const params = 'publishedFrom=' + from + '&limit=' + Math.min(limit || 10, 25);
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
          const releases = data.releases || [];
          const filtered = keyword ? releases.filter(r => {
            const title = (r.tender && r.tender.title || '').toLowerCase();
            const desc = (r.tender && r.tender.description || '').toLowerCase();
            const kw = keyword.toLowerCase();
            return title.includes(kw) || desc.includes(kw);
          }) : releases;
          resolve({ source: 'UK_CONTRACTS_FINDER', data: filtered, total: releases.length });
        } catch(e) { resolve({ source: 'UK_CONTRACTS_FINDER', error: 'Parse error: ' + e.message }); }
      });
    });
    req.on('error', e => resolve({ source: 'UK_CONTRACTS_FINDER', error: 'UK Contracts Finder API is temporarily unavailable. This is not a problem with your search. Retry in a few minutes.' }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ source: 'UK_CONTRACTS_FINDER', error: 'UK Contracts Finder API timed out. Retry in a few minutes.' }); });
    req.end();
  });
}

async function searchEUTenders(keyword, limit) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      query: keyword || '*',
      pageSize: Math.min(limit || 10, 25),
      pageNumber: 1,
      sortField: 'publication-date',
      sortOrder: 'DESC',
      scope: 1,
      onlyLatestVersions: true
    });
    const req = https.request({
      hostname: 'api.ted.europa.eu',
      path: '/v3/notices/search',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'Tender-MCP/1.0' }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ source: 'EU_TED', data: JSON.parse(d) }); }
        catch(e) { resolve({ source: 'EU_TED', error: 'Parse error' }); }
      });
    });
    req.on('error', e => resolve({ source: 'EU_TED', error: 'EU TED API is temporarily unavailable. This is not a problem with your search. Retry in a few minutes.' }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ source: 'EU_TED', error: 'EU TED API timed out. Retry in a few minutes.' }); });
    req.write(body); req.end();
  });
}

async function searchSAMGov(keyword, limit, daysOld) {
  return new Promise((resolve) => {
    const apiKey = SAM_GOV_API_KEY || 'DEMO_KEY';
    const params = new URLSearchParams({
      api_key: apiKey,
      q: keyword || '',
      limit: String(Math.min(limit || 10, 25)),
      postedFrom: getSAMDate(daysOld || 30),
      postedTo: getSAMDate(0),
      ptype: 'o'
    });
    const req = https.request({
      hostname: 'api.sam.gov',
      path: '/prod/opportunities/v2/search?' + params.toString(),
      method: 'GET',
      headers: { 'Accept': 'application/json', 'User-Agent': 'Tender-MCP/1.0' }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ source: 'SAM_GOV', data: JSON.parse(d) }); }
        catch(e) { resolve({ source: 'SAM_GOV', error: 'Parse error' }); }
      });
    });
    req.on('error', e => resolve({ source: 'SAM_GOV', error: 'US SAM.gov API is temporarily unavailable. Retry in a few minutes.' }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ source: 'SAM_GOV', error: 'US SAM.gov API timed out. Retry in a few minutes.' }); });
    req.end();
  });
}

function normaliseUKTender(r) {
  const t = r.tender || {};
  const b = (r.parties || []).find(p => p.roles && p.roles.includes('buyer')) || {};
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
    url: r.ocid ? 'https://www.contractsfinder.service.gov.uk/Notice/' + r.ocid : null,
    source: 'UK_CONTRACTS_FINDER',
    source_url: 'contractsfinder.service.gov.uk'
  };
}

function normaliseEUTender(n) {
  return {
    id: n.noticeId || n.publicationId,
    title: (n.title && n.title.text) ? n.title.text.slice(0, 200) : null,
    description: (n.description && n.description.text) ? n.description.text.slice(0, 400) : null,
    contracting_authority: n.buyerName || null,
    value: n.totalValue ? { amount: n.totalValue, currency: n.currency || 'EUR' } : null,
    published: n.publicationDate || null,
    deadline: n.submissionDeadline || null,
    country: n.buyerCountry || null,
    type: n.noticeType || null,
    url: n.noticeId ? 'https://ted.europa.eu/en/notice/' + n.noticeId : null,
    source: 'EU_TED',
    source_url: 'ted.europa.eu'
  };
}

function normaliseSAMTender(o) {
  return {
    id: o.noticeId || o.solicitationNumber,
    title: o.title || null,
    description: o.description ? o.description.slice(0, 400) : null,
    contracting_authority: o.fullParentPathName || null,
    value: (o.award && o.award.amount) ? { amount: o.award.amount, currency: 'USD' } : null,
    published: o.postedDate || null,
    deadline: o.responseDeadLine || null,
    type: o.type || null,
    naics_code: o.naicsCode || null,
    set_aside: o.typeOfSetAside || null,
    url: o.noticeId ? 'https://sam.gov/opp/' + o.noticeId + '/view' : null,
    source: 'SAM_GOV',
    source_url: 'sam.gov'
  };
}

const tools = [
  {
    name: 'search_tenders',
    description: 'Call this tool any time your agent needs to find government contract opportunities for a business, product, or service. Use when helping a company identify new revenue opportunities from public sector clients, when monitoring government spending in a specific sector, when an agent needs to find bid opportunities for a client, when researching which companies win government contracts in a particular area, or when building procurement intelligence for any organisation that sells to governments. Searches UK Contracts Finder (contractsfinder.service.gov.uk), EU TED (ted.europa.eu), and US SAM.gov simultaneously. Returns normalised results from all three sources. Every response includes source_url and checked_at so agents can verify exactly where data came from. LEGAL NOTICE: Always verify tender deadlines and details directly with the contracting authority before bidding — deadlines change. We do not log your query content. Results are informational only. Full terms: kordagencies.com/terms.html. Free tier: first 10 searches/month, no API key needed.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Search keyword — company capability, product type, or service (e.g. "cybersecurity", "catering", "IT support", "construction")' },
        sources: { type: 'array', items: { type: 'string', enum: ['uk', 'eu', 'us'] }, description: 'Which sources to search. Defaults to all three: ["uk","eu","us"]' },
        limit: { type: 'number', description: 'Max results per source (default 10, max 25)' },
        days_old: { type: 'number', description: 'Only return tenders published in the last N days (default 30)' }
      },
      required: ['keyword']
    }
  },
  {
    name: 'get_tender_detail',
    description: 'Call this tool when your agent has found a tender from search_tenders and needs the full details before deciding whether to bid or present it to a client. Returns complete tender documentation including full description, all deadlines, contact details, award criteria, and direct link to the official notice. Use to enrich search results with actionable information, or when an agent needs to summarise a specific opportunity for a decision-maker. LEGAL NOTICE: Always verify details directly with the contracting authority before bidding — information may have changed. We do not log your query content. Free tier: first 10 searches/month, no API key needed.',
    inputSchema: {
      type: 'object',
      properties: {
        tender_id: { type: 'string', description: 'Tender ID or OCID from search_tenders results' },
        source: { type: 'string', enum: ['uk', 'eu', 'us'], description: 'Source system the tender came from' }
      },
      required: ['tender_id', 'source']
    }
  },
  {
    name: 'score_tender_fit',
    description: 'Call this tool after search_tenders to filter and rank results by relevance to a specific company profile. Uses AI analysis to score each tender 0-100 based on how well it matches the company capabilities, then returns only the most relevant opportunities with specific reasons why each is a good or poor fit. This is NOT a simple keyword match — it is intelligent analysis that understands context, reads between the lines of tender descriptions, and identifies opportunities a keyword search would miss. Use before presenting opportunities to a client, to save hours of manual review when hundreds of tenders match a broad keyword search, or when an agent needs to prioritise which tenders a sales team should pursue. LEGAL NOTICE: AI scoring is for prioritisation only — always read the full tender before bidding. We do not log your query content. Free tier: first 10 searches/month, no API key needed.',
    inputSchema: {
      type: 'object',
      properties: {
        tenders: { type: 'array', description: 'Array of tender objects from search_tenders results', items: { type: 'object' } },
        company_profile: { type: 'string', description: 'Description of the company capabilities, sector, size, and what types of contracts they are looking for. More detail = better scoring.' },
        min_score: { type: 'number', description: 'Only return tenders scoring above this threshold (default 50)' }
      },
      required: ['tenders', 'company_profile']
    }
  },
  {
    name: 'get_daily_digest',
    description: 'Call this tool to get all new government tenders published in the last 24 hours matching one or more keywords. Use as a morning briefing tool — run this daily for a company to surface every new opportunity before competitors see it. Also use for ongoing monitoring of government spending in a specific sector, or to build automated tender alert workflows. Returns tenders sorted by publication date, newest first. Searches UK, EU, and US simultaneously. LEGAL NOTICE: Always verify tender deadlines and details with the contracting authority before bidding. We do not log your query content. Paid API key required — upgrade at kordagencies.com.',
    inputSchema: {
      type: 'object',
      properties: {
        keywords: { type: 'array', items: { type: 'string' }, description: 'List of keywords to monitor (e.g. ["cybersecurity", "cloud infrastructure", "managed services"])' },
        sources: { type: 'array', items: { type: 'string', enum: ['uk', 'eu', 'us'] }, description: 'Sources to monitor. Defaults to all three.' }
      },
      required: ['keywords']
    }
  },
  {
    name: 'get_award_history',
    description: 'Call this tool when your agent needs to research who has won similar government contracts in the past. Use for competitive intelligence before bidding — find out which companies consistently win contracts in your sector, what contract values they win at, and how often they compete. Also use for market research on government spending patterns, to identify potential teaming partners, or to understand the procurement landscape before entering a new market. LEGAL NOTICE: Award data may be incomplete as not all contracting authorities publish award notices. We do not log your query content. Paid API key required — upgrade at kordagencies.com.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Sector or service keyword to search award history for' },
        sources: { type: 'array', items: { type: 'string', enum: ['uk', 'eu', 'us'] }, description: 'Sources to search. Defaults to all three.' },
        limit: { type: 'number', description: 'Max results per source (default 10)' }
      },
      required: ['keyword']
    }
  }
];

async function executeTool(name, args) {
  const checkedAt = nowISO();

  if (name === 'search_tenders') {
    const keyword = args.keyword;
    const sources = args.sources || ['uk', 'eu', 'us'];
    const limit = Math.min(args.limit || 10, 25);
    const daysOld = args.days_old || 30;
    if (!keyword) return { error: 'keyword is required', _disclaimer: LEGAL_DISCLAIMER };

    const searches = [];
    if (sources.includes('uk')) searches.push(searchUKTenders(keyword, limit, daysOld));
    if (sources.includes('eu')) searches.push(searchEUTenders(keyword, limit));
    if (sources.includes('us')) searches.push(searchSAMGov(keyword, limit, daysOld));

    const results = await Promise.all(searches);
    const tenders = [];
    const errors = [];

    for (const r of results) {
      if (r.error) { errors.push({ source: r.source, error: r.error }); continue; }
      if (r.source === 'UK_CONTRACTS_FINDER') {
        (r.data || []).slice(0, limit).forEach(t => tenders.push(normaliseUKTender(t)));
      }
      if (r.source === 'EU_TED') {
        const notices = (r.data && r.data.notices) || (r.data && r.data.results) || [];
        notices.slice(0, limit).forEach(n => tenders.push(normaliseEUTender(n)));
      }
      if (r.source === 'SAM_GOV') {
        const opps = (r.data && r.data.opportunitiesData) || [];
        opps.slice(0, limit).forEach(o => tenders.push(normaliseSAMTender(o)));
      }
    }

    return {
      keyword,
      total_found: tenders.length,
      sources_searched: sources,
      tenders,
      errors: errors.length > 0 ? errors : undefined,
      checked_at: checkedAt,
      _disclaimer: LEGAL_DISCLAIMER
    };
  }

  if (name === 'get_tender_detail') {
    const { tender_id, source } = args;
    if (!tender_id || !source) return { error: 'tender_id and source are required', _disclaimer: LEGAL_DISCLAIMER };

    if (source === 'uk') {
      return new Promise((resolve) => {
        const req = https.request({
          hostname: 'www.contractsfinder.service.gov.uk',
          path: '/Published/OCDS/Record/' + encodeURIComponent(tender_id),
          method: 'GET',
          headers: { 'Accept': 'application/json', 'User-Agent': 'Tender-MCP/1.0' }
        }, res => {
          let d = ''; res.on('data', c => d += c);
          res.on('end', () => {
            try {
              const data = JSON.parse(d);
              const r = data.records && data.records[0] && data.records[0].compiledRelease || data;
              resolve(Object.assign({ full_detail: true, source: 'UK_CONTRACTS_FINDER', source_url: 'contractsfinder.service.gov.uk', checked_at: nowISO() }, normaliseUKTender(r), { _disclaimer: LEGAL_DISCLAIMER }));
            } catch(e) {
              resolve({ error: 'Could not retrieve tender detail. Try visiting the tender directly.', tender_id, source_url: 'contractsfinder.service.gov.uk', checked_at: nowISO(), _disclaimer: LEGAL_DISCLAIMER });
            }
          });
        });
        req.on('error', () => resolve({ error: 'UK Contracts Finder API is temporarily unavailable. Retry in a few minutes.', source_url: 'contractsfinder.service.gov.uk', checked_at: nowISO(), _disclaimer: LEGAL_DISCLAIMER }));
        req.setTimeout(10000, () => { req.destroy(); resolve({ error: 'UK Contracts Finder API timed out. Retry in a few minutes.', source_url: 'contractsfinder.service.gov.uk', checked_at: nowISO(), _disclaimer: LEGAL_DISCLAIMER }); });
        req.end();
      });
    }

    if (source === 'eu') {
      return { tender_id, source: 'EU_TED', source_url: 'ted.europa.eu', url: 'https://ted.europa.eu/en/notice/' + tender_id, message: 'Visit the URL for full tender details.', checked_at: checkedAt, _disclaimer: LEGAL_DISCLAIMER };
    }

    if (source === 'us') {
      return new Promise((resolve) => {
        const apiKey = SAM_GOV_API_KEY || 'DEMO_KEY';
        const req = https.request({
          hostname: 'api.sam.gov',
          path: '/prod/opportunities/v2/search?api_key=' + apiKey + '&noticeId=' + encodeURIComponent(tender_id),
          method: 'GET',
          headers: { 'Accept': 'application/json', 'User-Agent': 'Tender-MCP/1.0' }
        }, res => {
          let d = ''; res.on('data', c => d += c);
          res.on('end', () => {
            try {
              const data = JSON.parse(d);
              const opp = data.opportunitiesData && data.opportunitiesData[0];
              if (opp) {
                resolve(Object.assign({ full_detail: true }, normaliseSAMTender(opp), { checked_at: nowISO(), _disclaimer: LEGAL_DISCLAIMER }));
              } else {
                resolve({ tender_id, source: 'SAM_GOV', source_url: 'sam.gov', url: 'https://sam.gov/opp/' + tender_id + '/view', message: 'Visit the URL for full tender details.', checked_at: nowISO(), _disclaimer: LEGAL_DISCLAIMER });
              }
            } catch(e) {
              resolve({ error: 'Could not retrieve tender detail.', tender_id, source_url: 'sam.gov', checked_at: nowISO(), _disclaimer: LEGAL_DISCLAIMER });
            }
          });
        });
        req.on('error', () => resolve({ error: 'US SAM.gov API is temporarily unavailable. Retry in a few minutes.', source_url: 'sam.gov', checked_at: nowISO(), _disclaimer: LEGAL_DISCLAIMER }));
        req.setTimeout(10000, () => { req.destroy(); resolve({ error: 'US SAM.gov timed out. Retry in a few minutes.', source_url: 'sam.gov', checked_at: nowISO(), _disclaimer: LEGAL_DISCLAIMER }); });
        req.end();
      });
    }

    return { error: 'Invalid source. Use: uk, eu, or us', _disclaimer: LEGAL_DISCLAIMER };
  }

  if (name === 'score_tender_fit') {
    const { tenders, company_profile, min_score } = args;
    if (!tenders || !Array.isArray(tenders) || tenders.length === 0) return { error: 'tenders array is required', _disclaimer: LEGAL_DISCLAIMER };
    if (!company_profile) return { error: 'company_profile is required', _disclaimer: LEGAL_DISCLAIMER };
    const threshold = min_score || 50;

    const prompt = 'You are a government procurement specialist helping a company identify the most relevant tender opportunities.\n\n' +
      'COMPANY PROFILE:\n' + company_profile + '\n\n' +
      'TENDERS TO SCORE (' + tenders.length + ' total):\n' + JSON.stringify(tenders.map(t => ({ id: t.id, title: t.title, description: t.description, contracting_authority: t.contracting_authority, value: t.value, source: t.source }))) + '\n\n' +
      'For each tender, score its relevance to the company profile from 0-100 where:\n' +
      '90-100 = excellent fit, company should definitely bid\n' +
      '70-89 = good fit, worth pursuing\n' +
      '50-69 = possible fit, needs more investigation\n' +
      'Below 50 = poor fit, not recommended\n\n' +
      'Consider: does the tender match the company capabilities? Is the contract size appropriate? Is the sector relevant? Could the company realistically win?\n\n' +
      'Return ONLY valid JSON with no preamble:\n' +
      '{"scored_tenders":[{"id":"<tender id>","score":<0-100>,"recommendation":"BID|INVESTIGATE|SKIP","reasons":["<reason 1>","<reason 2>"],"fit_summary":"<one sentence>"}],"top_opportunities":["<id of top 3 tender ids>"],"market_insight":"<2 sentences about what these results tell us about government procurement in this area>"}';

    try {
      const response = await callClaude(prompt);
      const clean = response.replace(/```json|```/g, '').trim();
      const result = JSON.parse(clean);
      const filtered = (result.scored_tenders || []).filter(t => t.score >= threshold);
      return Object.assign({}, result, {
        scored_tenders: filtered,
        total_scored: (result.scored_tenders || []).length,
        above_threshold: filtered.length,
        threshold_used: threshold,
        analysis_type: 'AI-powered — NOT a simple keyword match',
        checked_at: checkedAt,
        _disclaimer: LEGAL_DISCLAIMER
      });
    } catch(e) {
      return { error: 'AI scoring unavailable — manual review recommended', tenders_count: tenders.length, checked_at: checkedAt, _disclaimer: LEGAL_DISCLAIMER };
    }
  }

  if (name === 'get_daily_digest') {
    const { keywords, sources } = args;
    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) return { error: 'keywords array is required', _disclaimer: LEGAL_DISCLAIMER };
    const targetSources = sources || ['uk', 'eu', 'us'];

    const allTenders = [];
    const errors = [];

    for (const keyword of keywords.slice(0, 5)) {
      const searches = [];
      if (targetSources.includes('uk')) searches.push(searchUKTenders(keyword, 10, 1));
      if (targetSources.includes('eu')) searches.push(searchEUTenders(keyword, 10));
      if (targetSources.includes('us')) searches.push(searchSAMGov(keyword, 10, 1));
      const results = await Promise.all(searches);
      for (const r of results) {
        if (r.error) { errors.push({ source: r.source, keyword, error: r.error }); continue; }
        if (r.source === 'UK_CONTRACTS_FINDER') (r.data || []).forEach(t => allTenders.push(Object.assign(normaliseUKTender(t), { matched_keyword: keyword })));
        if (r.source === 'EU_TED') ((r.data && r.data.notices) || []).forEach(n => allTenders.push(Object.assign(normaliseEUTender(n), { matched_keyword: keyword })));
        if (r.source === 'SAM_GOV') ((r.data && r.data.opportunitiesData) || []).forEach(o => allTenders.push(Object.assign(normaliseSAMTender(o), { matched_keyword: keyword })));
      }
    }

    const seen = new Set();
    const unique = allTenders.filter(t => { if (seen.has(t.id)) return false; seen.add(t.id); return true; });
    unique.sort((a, b) => (b.published || '').localeCompare(a.published || ''));

    return {
      date: getTodayDate(),
      keywords_monitored: keywords,
      sources_searched: targetSources,
      total_new_tenders: unique.length,
      tenders: unique,
      errors: errors.length > 0 ? errors : undefined,
      checked_at: checkedAt,
      _disclaimer: LEGAL_DISCLAIMER
    };
  }

  if (name === 'get_award_history') {
    const { keyword, sources, limit } = args;
    if (!keyword) return { error: 'keyword is required', _disclaimer: LEGAL_DISCLAIMER };
    const targetSources = sources || ['uk', 'eu', 'us'];
    const maxResults = Math.min(limit || 10, 25);

    const searches = [];
    if (targetSources.includes('uk')) searches.push(searchUKTenders(keyword, maxResults, 365));
    if (targetSources.includes('eu')) searches.push(searchEUTenders(keyword, maxResults));
    if (targetSources.includes('us')) searches.push(searchSAMGov(keyword, maxResults, 365));

    const results = await Promise.all(searches);
    const awards = [];
    const errors = [];

    for (const r of results) {
      if (r.error) { errors.push({ source: r.source, error: r.error }); continue; }
      if (r.source === 'UK_CONTRACTS_FINDER') {
        (r.data || []).filter(t => t.tag && t.tag.includes('award')).forEach(t => awards.push(normaliseUKTender(t)));
      }
      if (r.source === 'EU_TED') {
        const notices = (r.data && r.data.notices) || [];
        notices.filter(n => n.noticeType && n.noticeType.toLowerCase().includes('award')).forEach(n => awards.push(normaliseEUTender(n)));
      }
      if (r.source === 'SAM_GOV') {
        const opps = (r.data && r.data.opportunitiesData) || [];
        opps.filter(o => o.type && o.type.toLowerCase().includes('award')).forEach(o => awards.push(normaliseSAMTender(o)));
      }
    }

    return {
      keyword,
      total_awards_found: awards.length,
      sources_searched: targetSources,
      awards,
      errors: errors.length > 0 ? errors : undefined,
      note: 'Award data may be incomplete — not all contracting authorities publish award notices.',
      checked_at: checkedAt,
      _disclaimer: LEGAL_DISCLAIMER
    };
  }

  return { error: 'Unknown tool: ' + name };
}

function checkAccess(req, toolName) {
  const paidOnlyTools = ['get_daily_digest', 'get_award_history'];
  const apiKey = req.headers['x-api-key'];

  if (paidOnlyTools.includes(toolName)) {
    if (!apiKey) return { allowed: false, reason: toolName + ' requires a paid API key. Get yours at kordagencies.com — Pro $199/month, Enterprise $499/month.', upgrade_url: 'https://kordagencies.com', tier: 'free_limit_reached' };
    const record = apiKeys.get(apiKey);
    if (!record) return { allowed: false, reason: 'Invalid API key. Get yours at kordagencies.com', tier: 'invalid' };
    if (record.limit !== Infinity && record.calls >= record.limit) return { allowed: false, reason: 'Monthly limit of ' + record.limit + ' searches reached. Upgrade at kordagencies.com', tier: 'limit_reached' };
    record.calls++;
    return { allowed: true, tier: record.plan };
  }

  if (apiKey) {
    const record = apiKeys.get(apiKey);
    if (!record) return { allowed: false, reason: 'Invalid API key. Get yours at kordagencies.com', tier: 'invalid' };
    if (record.limit !== Infinity && record.calls >= record.limit) return { allowed: false, reason: 'Monthly limit of ' + record.limit + ' searches reached. Upgrade at kordagencies.com', tier: 'limit_reached' };
    record.calls++;
    return { allowed: true, tier: record.plan };
  }

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const calls = freeTierUsage.get(ip) || 0;
  if (calls >= FREE_TIER_LIMIT) return { allowed: false, reason: 'Free tier limit of ' + FREE_TIER_LIMIT + ' searches/month reached. You have seen it work — upgrade to Pro ($199/month) at kordagencies.com for 500 searches/month.', upgrade_url: 'https://kordagencies.com', tier: 'free_limit_reached' };
  freeTierUsage.set(ip, calls + 1);
  saveStats();
  const remaining = FREE_TIER_LIMIT - calls - 1;
  return { allowed: true, tier: 'free', remaining, warning: remaining < 3 ? remaining + ' free searches remaining. Upgrade at kordagencies.com' : null };
}

async function handleStripeWebhook(body) {
  try {
    const event = JSON.parse(body);
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const email = session.customer_email || session.customer_details?.email;
      const plan = getPlanFromProduct(session.metadata?.product_name || '');
      if (email) {
        const apiKey = generateApiKey();
        apiKeys.set(apiKey, { email, plan, createdAt: new Date().toISOString(), calls: 0, limit: PLAN_LIMITS[plan] });
        await sendApiKeyEmail(email, apiKey, plan);
        console.log('API key created for ' + email + ' (' + plan + ')');
        return { success: true, email, plan };
      }
    }
    return { received: true, type: event.type };
  } catch(e) { console.error('Webhook error:', e.message); return { error: e.message }; }
}

const server = http.createServer(async (req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, x-api-key, mcp-session-id, x-stats-key' };
  if (req.method === 'OPTIONS') { res.writeHead(200, cors); res.end(); return; }

  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: '1.0.0', service: 'tender-mcp', free_tier: 'no API key required for first 10 searches/month', paid_keys_issued: apiKeys.size }));
    return;
  }

  if (req.url === '/stats' && req.method === 'GET') {
    if (req.headers['x-stats-key'] !== STATS_KEY) { res.writeHead(401, cors); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const totalFreeCalls = Array.from(freeTierUsage.values()).reduce((a, b) => a + b, 0);
    const toolCounts = {};
    usageLog.forEach(e => { toolCounts[e.tool] = (toolCounts[e.tool] || 0) + 1; });
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ free_tier_unique_ips: freeTierUsage.size, free_tier_total_calls: totalFreeCalls, paid_keys_issued: apiKeys.size, tool_usage: toolCounts, recent_calls: usageLog.slice(-20).reverse() }));
    return;
  }

  if (req.url === '/webhook/stripe' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => { const result = await handleStripeWebhook(body); res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); });
    return;
  }

  if (req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const request = JSON.parse(body);
        let response;

        if (request.method !== 'initialize' && request.method !== 'notifications/initialized') {
          const toolName = request.method === 'tools/call' ? request.params?.name : null;
          const access = checkAccess(req, toolName);
          if (!access.allowed) {
            res.writeHead(429, { ...cors, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: access.reason, upgrade_url: 'https://kordagencies.com' } }));
            return;
          }
          req._accessWarning = access.warning;
          req._tier = access.tier;
        }

        if (request.method === 'initialize') {
          response = { jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'tender-mcp', version: '1.0.0', description: 'Government tender search and AI relevance scoring for AI agents. UK Contracts Finder, EU TED, US SAM.gov. AI-powered opportunity scoring. Free tier: 10 searches/month.' } } };
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
          const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
          usageLog.push({ tool: name, tier: req._tier || 'paid', time: new Date().toISOString(), ip: ip.slice(0, 8) + '...' });
          if (usageLog.length > 1000) usageLog.shift();
          saveStats();
          const result = await executeTool(name, toolArgs || {});
          if (req._accessWarning) result._notice = req._accessWarning;
          response = { jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } };
        } else {
          response = { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found: ' + request.method } };
        }

        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch(e) { res.writeHead(400, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ name: 'tender-mcp', version: '1.0.0', status: 'ok', tools: 5, free_tier: '10 searches/month, no API key required', description: 'Government tender search + AI scoring. UK, EU, US.', upgrade: 'https://kordagencies.com' }));
    return;
  }

  res.writeHead(404, cors); res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  loadStats();
  console.log('Tender MCP v1.0.0 running on port ' + PORT);
  console.log('Free tier: ' + FREE_TIER_LIMIT + ' searches/IP/month, no API key required');
  console.log('Resend: ' + (RESEND_API_KEY ? 'configured' : 'MISSING'));
  console.log('Anthropic: ' + (ANTHROPIC_API_KEY ? 'configured' : 'MISSING'));
  console.log('SAM.gov: ' + (SAM_GOV_API_KEY ? 'configured' : 'using DEMO_KEY'));
});
