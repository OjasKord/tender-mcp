# Changelog — Tender MCP

## v1.0.0 — 2026-04-09

### Added
- Initial release
- `search_tenders` — keyword search across UK Contracts Finder, EU TED, US SAM.gov simultaneously
- `get_tender_detail` — full tender details by ID from any source
- `score_tender_fit` — AI-powered relevance scoring 0-100 with BID/INVESTIGATE/SKIP recommendation
- `get_daily_digest` — new tenders in last 24 hours matching keywords (paid only)
- `get_award_history` — past award winners for competitive intelligence (paid only)
- Free tier: 10 searches/month, no API key required
- source_url and checked_at in every response
- Honest timeout error messages for all three government APIs
- Legal disclaimer in every response
- Stats endpoint protected by STATS_KEY
- Stripe webhook API key email delivery
