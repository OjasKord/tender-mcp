## [1.2.10] - 2026-06-04

### Added
- Upstash Redis persistence: free tier usage, API keys, session logs survive redeploys
- `loadFreeTierFromRedis()` / `saveFreeTierToRedis()` with Math.max merge pattern
- `saveKeyToRedis()` / `loadApiKeysFromRedis()` with prefix `tender`
- `appendSessionLog(ip, tool)` with 24h TTL per IP per day
- `/session-log` endpoint (requires x-stats-key)
- `free_tier_breakdown` per-IP object on `/stats` response
- `getEffectiveLimit(ip)` helper — returns base + trial extension if applicable

### Changed
- Tool descriptions rewritten for orchestral agent runtime selection: state-based triggers, chaining instructions, DO NOT USE conditions
- `VERSION` bumped to `1.2.10`

## [1.2.9] - 2026-06-02

### Fixed
- fix: IP extraction fixed for Cloudflare proxy headers — free tier gate now enforces correctly

## [1.2.5] - 2026-04-28

### Changed
- Payment links updated to prepaid bundle URLs: 500 searches for $8 -- calls never expire
- Free tier limit errors now direct agents to prepaid bundle purchase link directly

## [1.2.4] - 2026-04-27

### Added
- `token_count` field on all tool responses — lets orchestrator budget ledgers track token cost per call
- `/ready` endpoint — returns 200 when `ANTHROPIC_API_KEY` and `SAM_GOV_API_KEY` are present, 503 otherwise
- Phase 4 enhanced error objects: `category`, `retryable`, `retry_after_ms`, `fallback_tool`, `trace_id` on all error paths across both tools

## [1.2.3] - 2026-04-26

### Improved
- search_tenders and get_tender_intelligence descriptions rewritten with TCO framework: deadline-miss consequence, exact government portal hostnames, prepaid bundle pricing last
- Initialize serverInfo description rewritten for both HTTP and stdio transports

## [1.2.2] - 2026-04-26
### Changed
- VERSION constant introduced as single source of truth (was behind package.json)
- Added `agent_action` to all error responses (PROVIDE_REQUIRED_FIELD, RETRY_IN_2_MIN)
- Added stdio transport for Claude Desktop / npm usage
- Fixed em-dash in analysis_type and AI scoring error strings (ASCII --)

## [1.2.0] - 2026-04-21
### Changed
- Consolidated from 5 tools to 2: search_tenders and get_tender_intelligence
- search_tenders now runs AI fit scoring automatically inline
- get_tender_intelligence replaces get_daily_digest and get_award_history with mode parameter (DAILY_DIGEST or AWARD_HISTORY)
- Free tier preview for intelligence tool returns real count before gating full results
- Upgrade hooks in every response with specific conversion messaging

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
