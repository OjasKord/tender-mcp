const fs = require('fs');
let c = fs.readFileSync('C:/tender-mcp/src/server.js', 'utf8');

console.log('File size:', c.length);
console.log('Has tender_stats:', c.includes('tender_stats'));
console.log('Version 1.0.2:', c.includes('1.0.2'));
console.log('Has search_tenders:', c.includes('search_tenders'));

if (!c.includes('tender_stats')) {
  console.error('ERROR: Wrong file');
  process.exit(1);
}

// 1. Add FREE_TIER_WARNING constant
c = c.replace(
  'const FREE_TIER_LIMIT = 10;',
  'const FREE_TIER_LIMIT = 10;\nconst FREE_TIER_WARNING = 8; // warn at 80% usage'
);

// 2. Bump version to 1.1.0
c = c.replace(/1\.0\.2/g, '1.1.0');
// Also fix the serverInfo version which says 1.0.1
c = c.replace(/version: '1\.0\.1'/g, "version: '1.1.0'");

// 3. Add partial response logic in tools/call handler
const oldResult = `          const result = await executeTool(name, toolArgs || {});
          if (req._accessWarning) result._notice = req._accessWarning;
          response = { jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } };`;

const newResult = `          const result = await executeTool(name, toolArgs || {});
          if (req._accessWarning) result._notice = req._accessWarning;

          // Partial response for free tier
          if (req._tier === 'free' && !result.error) {
            const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
            const used = freeTierUsage.get(ip) || 0;
            const remaining = FREE_TIER_LIMIT - used;
            const isWarning = used >= FREE_TIER_WARNING;

            if (name === 'search_tenders' && result.tenders && result.tenders.length > 0) {
              // Show 3 results, gate the rest
              const totalFound = result.total_found;
              const gatedCount = Math.max(0, totalFound - 3);
              result.tenders = result.tenders.slice(0, 3);
              result.total_found = totalFound;
              if (gatedCount > 0) {
                result._upgrade_note = 'Free tier: showing 3 of ' + totalFound + ' results (' + gatedCount + ' hidden). ' + remaining + ' of ' + FREE_TIER_LIMIT + ' free searches remaining this month. Upgrade to Pro ($199/month) at kordagencies.com for full results.';
                result._gated_fields = ['tenders[3+]'];
              } else {
                result._upgrade_note = remaining + ' of ' + FREE_TIER_LIMIT + ' free searches remaining this month. Upgrade to Pro ($199/month) at kordagencies.com for unlimited searches.';
              }
            }

            if (name === 'get_tender_detail' && !result.error) {
              const gated = ['description', 'contact'];
              gated.forEach(f => delete result[f]);
              result._upgrade_note = remaining + ' of ' + FREE_TIER_LIMIT + ' free searches remaining. Upgrade to Pro ($199/month) at kordagencies.com for full tender description and contact details.';
              result._gated_fields = gated;
            }

            if (name === 'score_tender_fit' && result.scored_tenders) {
              // Keep scores and recommendations, gate reasons and market insight
              result.scored_tenders = result.scored_tenders.map(t => {
                const { reasons, ...rest } = t;
                return { ...rest, _reasons_gated: true };
              });
              delete result.market_insight;
              result._upgrade_note = remaining + ' of ' + FREE_TIER_LIMIT + ' free searches remaining. Upgrade to Pro ($199/month) at kordagencies.com for full reasoning behind each score and market insights.';
              result._gated_fields = ['scored_tenders[].reasons', 'market_insight'];
            }

            if (isWarning) result._notice = 'Warning: only ' + remaining + ' free search' + (remaining === 1 ? '' : 'es') + ' left this month. Upgrade to Pro at kordagencies.com to avoid interruption.';
          }

          response = { jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } };`;

if (!c.includes(oldResult)) {
  console.error('ERROR: Could not find tool call handler');
  const idx = c.indexOf('executeTool(name');
  console.log('executeTool at:', idx);
  console.log('Context:', c.substring(idx - 20, idx + 150));
  process.exit(1);
}

c = c.replace(oldResult, newResult);

console.log('FREE_TIER_WARNING:', c.includes('FREE_TIER_WARNING'));
console.log('Version 1.1.0:', c.includes('1.1.0'));
console.log('Partial response:', c.includes('_upgrade_note'));
console.log('New size:', c.length);

fs.writeFileSync('C:/tender-mcp/src/server.js', c);
console.log('Done');
