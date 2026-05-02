[![smithery badge](https://smithery.ai/badge/OjasKord/tender-mcp)](https://smithery.ai/servers/OjasKord/tender-mcp)

# Tender MCP — Government Opportunity Intelligence for AI Agents

Find, score, and monitor government contract opportunities across UK, EU, and US. AI-powered relevance scoring so your agent surfaces the right opportunities — not just keyword matches.

**Free tier: 10 searches/month. No API key required. Just connect and go.**

## Quick Start

```json
{
  "tender": {
    "url": "https://tender-mcp-production.up.railway.app"
  }
}
```

Or via Smithery:

```bash
npx -y @smithery/cli@latest mcp add OjasKord/tender-mcp
```

## Why Use This

Any business that sells to government needs to monitor tender opportunities. But searching three separate government portals daily, reading hundreds of notices, and manually judging relevance takes hours. Tender MCP does it in seconds — search UK, EU, and US simultaneously, then let AI score which opportunities actually match your capabilities.

## Tools

### `search_tenders`
Search active government tenders across UK Contracts Finder, EU TED, and US SAM.gov simultaneously. Returns normalised results with source_url and checked_at.

```json
{ "keyword": "cybersecurity", "sources": ["uk", "eu"], "days_old": 14 }
```

### `get_tender_detail`
Full details for a specific tender — complete description, all deadlines, contact details, award criteria.

```json
{ "tender_id": "ocds-h6vhtk-...", "source": "uk" }
```

### `score_tender_fit` *(AI-powered — NOT a keyword match)*
AI scores each tender 0-100 against a company capability profile. Returns BID/INVESTIGATE/SKIP recommendation with specific reasons. Saves hours of manual review.

```json
{
  "tenders": [...],
  "company_profile": "We are a 50-person UK cybersecurity firm specialising in penetration testing and SOC services for public sector clients. We hold SC clearance.",
  "min_score": 60
}
```

### `get_daily_digest` *(Paid only)*
All new tenders published in the last 24 hours matching your keywords. Run daily as a morning briefing.

```json
{ "keywords": ["cybersecurity", "managed SOC", "penetration testing"] }
```

### `get_award_history` *(Paid only)*
Past award winners for a keyword. Use for competitive intelligence before bidding.

```json
{ "keyword": "cybersecurity", "sources": ["uk"] }
```

## Recommended Workflow

**Find and score opportunities (3 calls):**
1. `search_tenders` — find active tenders matching your sector
2. `score_tender_fit` — AI ranks by relevance, filters noise
3. `get_tender_detail` — full details on top matches

**Daily monitoring (1 call):**
- `get_daily_digest` — new tenders every morning before competitors see them

## Data Sources

| Source | Coverage | Update Frequency |
|---|---|---|
| UK Contracts Finder (contractsfinder.service.gov.uk) | All UK public sector contracts | Real-time |
| EU TED (ted.europa.eu) | All EU member state procurement | Real-time |
| US SAM.gov (sam.gov) | All US federal opportunities | Daily |

Every response includes `source_url` and `checked_at`.

## Pricing

| Plan | Searches | Price |
|---|---|---|
| Free | 10/month | No API key required |
| Starter | 500-call bundle | $8 |
| Pro | 2,000-call bundle | $28 |

Upgrade at **[kordagencies.com](https://kordagencies.com)**

## Reliability

- Uptime monitored every 5 minutes
- Version history in [CHANGELOG.md](CHANGELOG.md)
- Health endpoint: `GET /health`
- Note: Government portal APIs experience occasional downtime — errors include explanation and retry guidance

## Legal

Tender data sourced directly from official government portals. We do not log or store your query content. **Always verify tender deadlines and details directly with the contracting authority before submitting a bid — deadlines change.** Results are for informational purposes only. Maximum liability limited to 3 months subscription fees. Full terms: [kordagencies.com/terms.html](https://kordagencies.com/terms.html)

## Connect

- Website: [kordagencies.com](https://kordagencies.com)
- Contact: ojas@kordagencies.com
