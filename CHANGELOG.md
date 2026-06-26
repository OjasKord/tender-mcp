## [1.2.27] - 2026-06-26
- fix: trial extension requests now written to Redis (tender:trial:{email}) on grant -- permanent audit trail that survives redeploys; previously in-memory only

## [1.2.26] - 2026-06-26
- feat: gate response now includes direct email contact option (ojas@kordagencies.com) for custom plans, visible in agent error output

## [1.2.25] - 2026-06-25
- audit: purpose verb + required fields already present on both tools from prior ATO optimisation pass -- no changes needed
- feat: calls_remaining field added to every tool response -- "unlimited" for paid keys, numeric free-tier headroom otherwise
- feat: verdict_ttl field added to search_tenders and get_tender_intelligence responses (3600s/1hr -- live contracts change fast)
- feat: data_source_status field added (full/degraded/partial) -- "degraded" when the only requested source fails or all requested sources fail, "partial" when some (not all) of multiple requested sources fail

## [1.2.24] - 2026-06-24
- feat: unauthenticated /public-stats endpoint -- first_deployed, lifetime tool calls, uptime %, version, for agent orchestrators evaluating server trustworthiness
- feat: /process-trial-followups endpoint + 24h follow-up record on trial-extension grant
- feat: gate responses now self-contained (server + workflow impact + upgrade path in one sentence) and detect cross-server operators via shared fleet Redis, with cross-server trial-extension note
- feat: outputSchema added to both tools (additive, response format unchanged)
- audit: smithery.yaml description rewritten to pre-condition/consequence/verdict format; glama.json, server.json, README checked against live tools array -- no phantom tools or false data-source claims found, already accurate

## [1.2.23] - 2026-06-23
- fix: gate returns HTTP 402 (x402 standard for non-transient quota)

## [1.2.22] - 2026-06-20
- feat: email notification on free tier gate hit
- fix: remove duplicate/non-existent pay-as-you-go Stripe link from free tier gate message

## [1.2.21] - 2026-06-18
- feat: revoke API key on Stripe refund

## [1.2.20] - 2026-06-17
- fix: sendEmail now logs Resend HTTP errors in Railway logs

## [1.2.19] - 2026-06-17
- fix: Stripe webhook now validates payment_link ID — ignores events not belonging to this server

## [1.2.18] - 2026-06-17
- feat: SmitheryBot detection on search_tenders and get_tender_intelligence — returns mock empty results without consuming SAM.gov/UK/EU TED API credits

## [1.2.17] - 2026-06-16
- feat: ATO optimisation — purpose verb, usage context, required fields, ToolRank badge

## [1.2.16] - 2026-06-11
- feat: add /.well-known/mcp/server-card.json static metadata endpoint

## [1.2.15] - 2026-06-11
- fix: bump version past existing npm publish (1.2.14 already on registry)

## [1.2.14] - 2026-06-11
- feat: per-tool kill switch + per-minute rate limiting on AI tools

## [1.2.13] - 2026-06-08
- fix: BEFORE trigger language, consequence-first limit error

## [1.2.12] - 2026-06-05
- feat: Smithery optimisation - updated package.json description/keywords and smithery.yaml with system prompt

## [1.2.11] - 2026-06-04
- feat: /daily-report endpoint for consolidated daily summary

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
