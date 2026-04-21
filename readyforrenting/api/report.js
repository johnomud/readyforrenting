/**
 * Ready for Renting - report.js
 * Vercel serverless function. Plain CommonJS - no bundler, no npm packages needed.
 *
 * ─── ENVIRONMENT VARIABLES ───────────────────────────────────────────────────
 * Set both in Vercel → Project Settings → Environment Variables → Add variable
 *
 *   CLAUDE_API_KEY    Your Anthropic API key (console.anthropic.com)
 *   NOTION_API_KEY    Your Notion integration token (notion.so/my-integrations)
 *
 * ─── NOTION SETUP (one-time, ~5 minutes) ────────────────────────────────────
 * 1. Go to notion.so/my-integrations → New integration
 * 2. Name it "Ready for Renting" → Submit → copy the Internal Integration Token
 * 3. In Notion, open the "User Submissions" database
 * 4. Click ••• (top right) → Connections → Connect to → Ready for Renting
 * 5. Paste the token as NOTION_API_KEY in Vercel env vars
 * 6. Trigger a redeploy
 *
 * ─── HOW NOTION LOGGING WORKS ────────────────────────────────────────────────
 * After every successful report generation, this function creates a new row in
 * your User Submissions Notion database. The email, score, portfolio details,
 * and submission date are all logged automatically. Logging is non-blocking -
 * the report still returns to the user even if Notion logging fails.
 */

'use strict';

// ── Notion database details (from live schema) ────────────────────────────────
var NOTION_DB_ID      = 'a83e5c65-366d-46d3-9e93-b434643547fe';
var NOTION_API_VER    = '2022-06-28';

// ── Map form values → exact Notion select option names ────────────────────────
// These must match the option names in the Notion database exactly.
var PROPERTY_COUNT_MAP = { '1':'1', '2-4':'2-4', '5-9':'5-9', '10+':'10+' };
var HAS_AST_MAP = {
  'Yes some': 'Yes some',
  'Yes all':  'Yes all',
  'No':       'No all periodic',
  'Unsure':   'Unsure'
};
var RENT_ADVANCE_MAP = {
  'Yes 2+ months': 'Yes 2+ months',
  'Sometimes':     'Sometimes',
  'No 1 month':    'No 1 month only',
  'None':          'No advance'
};

// ── Claude system prompt ──────────────────────────────────────────────────────
var SYSTEM_PROMPT = [
  'You are a UK residential property compliance expert with comprehensive knowledge of the',
  "Renters' Rights Act 2025 and all existing Private Rented Sector housing legislation.",
  '',
  "RENTERS' RIGHTS ACT 2025 - KEY PROVISIONS (confirmed March 2026):",
  '',
  'PHASE 1 - FROM 1 MAY 2026:',
  "- Section 21 'no-fault' evictions ABOLISHED. Last valid notice: 30 April 2026.",
  '- All fixed-term Assured Shorthold Tenancies (ASTs) automatically convert to Assured Periodic Tenancies (APTs).',
  '- New tenancies must be Assured Periodic Tenancies - no new fixed-term ASTs.',
  '- Possession only via Section 8 using statutory grounds.',
  '- Written Statement of Terms required before all new tenancies.',
  '- Rent increases: formal Section 13 notice (Form 4A) only; once per year; 2 months minimum notice.',
  '- Rent in advance: capped at 1 month for new tenancies.',
  '- Rental bidding banned.',
  "- No discrimination against tenants with children or on housing benefit.",
  '- Tenants can serve 2 months notice from day one.',
  '',
  'PHASE 1b - BY 31 MAY 2026:',
  '- Government Information Sheet MUST be sent to ALL existing tenants. Penalty: up to £7,000 per tenancy.',
  '- Written Statement of Terms required where verbal agreements exist.',
  '',
  'KEY SECTION 8 GROUNDS (only route to possession from 1 May 2026):',
  '- Ground 8 (mandatory): 3+ months rent arrears at notice and hearing.',
  '- Ground 1A: landlord selling - 4 months notice, not in first 12 months.',
  '- Ground 1: landlord moving in - 4 months notice, not in first 12 months.',
  "- Ground 14: anti-social behaviour - 2 weeks notice, discretionary.",
  '',
  'COMPANY LETS - IMPORTANT DISTINCTION:',
  'Company lets (where the tenant is a company, not an individual) are NOT Assured Shorthold Tenancies and are NOT subject to the Renters\' Rights Act 2025 Phase 1 provisions.',
  'This means:',
  '- Section 21 abolition does NOT apply - company lets are not Assured Shorthold Tenancies',
  '- The Government Information Sheet requirement does NOT apply to company lets',
  '- Section 13 formal rent increase process does NOT apply',
  '- The Assured Periodic Tenancy conversion does NOT apply',
  '- Tenant notice period rules do NOT apply',
  'If a landlord\'s portfolio includes ONLY company lets, they are largely unaffected by Phase 1. However:',
  '- Private Rented Sector (PRS) Database registration in Phase 2 may still apply - confirm when regulations are published',
  '- Safety obligations (Gas Safety Certificate, Energy Performance Certificate, Electrical Installation Condition Report, smoke alarms) still apply to all rented properties regardless of tenancy type',
  '- If they have a MIX of company lets and residential Assured Shorthold Tenancies, apply the Act\'s provisions only to the residential tenancies',
  'When a landlord selects "Company let" as their only tenancy type, make this very clear in the report and avoid incorrectly flagging Renters\' Rights Act 2025 provisions that do not apply to them.',
  '',
  'EXISTING OBLIGATIONS:',
  '- Gas Safety Certificate: annual; to tenant before move-in and within 28 days of each check. Fine up to £6,000.',
  '- Energy Performance Certificate (EPC): minimum E rating; cannot market without one. C rating required by 2030.',
  '- Electrical Installation Condition Report (EICR): every 5 years; copy to tenants. Penalty up to £30,000.',
  '- Smoke alarms: one per storey, working on day 1 of tenancy.',
  '- Carbon monoxide detectors: mandatory where solid fuel appliances.',
  '- Deposit protection: Tenancy Deposit Protection scheme within 30 days; prescribed information within 30 days.',
  "- How to Rent guide: current version at every tenancy start.",
  '- House in Multiple Occupation (HMO) licence: mandatory for 5+ occupants in 2+ households.',
  '',
  'Respond ONLY with valid JSON - no markdown fences, no preamble, no explanation:',
  '{',
  '  "compliance_score": <integer 0-100>,',
  '  "status": <"Critical"|"Needs Attention"|"On Track"|"Compliant">,',
  '  "summary": "<2-3 sentences specific to their portfolio, location, and tenancy situation>",',
  '  "urgent_actions": [',
  '    {"action":"<specific step>","deadline":"<exact date or Before [date]>","consequence":"<specific fine or risk>","category":"<Tenancy Documents|Possession & Eviction|Rent & Deposits|Safety & Standards|Registration & Licensing>"}',
  '  ],',
  '  "required_actions": [',
  '    {"action":"<specific step>","timeline":"<when>","category":"<category>"}',
  '  ],',
  '  "positive_notes": ["<what they already have right, referenced to their answers>"],',
  '  "disclaimer": "This summary provides general information only and does not constitute legal advice. Ready for Renting is not a solicitor. Always verify with gov.uk and consult a qualified solicitor for decisions specific to your situation."',
  '}'
].join('\n');

// ── Build Claude user message ──────────────────────────────────────────────────
function buildPrompt(data) {
  var ALL_CHECKS = [
    'Written tenancy agreement for all properties',
    'Valid Gas Safety Certificate',
    'Valid EPC rated E or above',
    'Smoke alarms on every floor',
    'Carbon monoxide detectors where required',
    'Deposit protected within 30 days',
    "How to Rent guide provided",
    'EICR within last 5 years'
  ];
  var confirmed = Array.isArray(data.checks) ? data.checks : [];
  var gaps = ALL_CHECKS.filter(function(c) { return confirmed.indexOf(c) === -1; });

  return [
    'Landlord name: ' + (data.name || 'not provided'),
    'Portfolio:',
    '- Number of properties: ' + (data.propertyCount || 'not specified'),
    '- Tenancy types: ' + (Array.isArray(data.propertyTypes) && data.propertyTypes.length ? data.propertyTypes.join(', ') : 'not specified'),
    '- Includes company let(s): ' + (Array.isArray(data.propertyTypes) && data.propertyTypes.indexOf('Company let') !== -1 ? 'YES - company lets are not Assured Shorthold Tenancies; Renters\' Rights Act 2025 Phase 1 does not apply to them' : 'No'),
    '- Location: ' + (data.location || 'not specified'),
    '',
    'Tenancy setup:',
    '- Fixed-term Assured Shorthold Tenancies in place: ' + (data.hasAST || 'unknown'),
    '- Current rent increase method: ' + (data.rentIncrease || 'unknown'),
    '- Rent in advance practice: ' + (data.rentAdvance || 'unknown'),
    '- Section 21 activity: ' + (data.s21 || 'unknown'),
    '',
    'Compliance items confirmed:',
    confirmed.length ? confirmed.map(function(c) { return '\u2713 ' + c; }).join('\n') : 'None confirmed',
    '',
    'Compliance gaps (not confirmed):',
    gaps.length ? gaps.map(function(c) { return '\u2717 ' + c; }).join('\n') : 'None identified',
    '',
    'Generate a specific, personalised compliance report for this landlord.',
    'Reference exact deadlines, fine amounts, and which provisions apply based on their answers.'
  ].join('\n');
}

// ── Sanitise input ─────────────────────────────────────────────────────────────
function sanitise(v) {
  if (typeof v === 'string') return v.replace(/<[^>]*>/g, '').substring(0, 200);
  if (Array.isArray(v)) return v.map(sanitise).slice(0, 10);
  return v;
}

// ── Log submission to Notion ───────────────────────────────────────────────────
// Property names here match the exact Notion database schema.
// The Notion REST API uses the display name of the property, NOT the MCP internal name.
// So "Submitted" not "date:Submitted:start", etc.
async function logToNotion(notionKey, name, email, formData, report) {
  var today = new Date().toISOString().split('T')[0];

  console.log('[Notion] Logging submission for:', email, 'DB:', NOTION_DB_ID);

  // Store the full report JSON so we can generate a PDF later when they purchase
  var reportJson = '';
  try { reportJson = JSON.stringify(report); } catch(e) { reportJson = '{}'; }

  // Build properties — only include what we're confident about
  // Title property is required; rich_text is safest for everything else
  var props = {
    'Email': { title: [{ text: { content: email || 'unknown' } }] },
    'Name': { rich_text: [{ text: { content: name || '' } }] },
    'Compliance Score': { number: typeof report.compliance_score === 'number' ? report.compliance_score : 0 },
    'Status': { select: { name: report.status || 'Needs Attention' } },
    'Lead Stage': { select: { name: 'Free User' } },
    'Location': { rich_text: [{ text: { content: formData.location || '' } }] },
    'Property Types': { rich_text: [{ text: { content: Array.isArray(formData.propertyTypes) ? formData.propertyTypes.join(', ') : '' } }] },
    'Notes': { rich_text: [{ text: { content: 'Free compliance check. ' + new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) } }] },
    'Submitted': { date: { start: today } },
    'Full Report': { rich_text: [{ text: { content: reportJson.substring(0, 2000) } }] }
  };

  // Optional selects
  var pcVal = PROPERTY_COUNT_MAP[formData.propertyCount];
  if (pcVal) props['Property Count'] = { select: { name: pcVal } };
  var astVal = HAS_AST_MAP[formData.hasAST];
  if (astVal) props['Has Fixed Term AST'] = { select: { name: astVal } };
  var raVal = RENT_ADVANCE_MAP[formData.rentAdvance];
  if (raVal) props['Rent In Advance'] = { select: { name: raVal } };

  var body = JSON.stringify({ parent: { database_id: NOTION_DB_ID }, properties: props });

  // First attempt: with all properties
  var res;
  try {
    res = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + notionKey,
        'Content-Type': 'application/json',
        'Notion-Version': NOTION_API_VER
      },
      body: body
    });
  } catch (err) {
    console.error('[Notion] Network error:', err.message);
    return;
  }

  if (!res.ok) {
    var errText = await res.text();
    console.error('[Notion] First attempt error ' + res.status + ':', errText.substring(0, 500));

    // Retry with minimal properties (in case some property names don't exist in the DB)
    console.log('[Notion] Retrying with minimal properties...');
    var minProps = {
      'Email': { title: [{ text: { content: email || 'unknown' } }] },
      'Name': { rich_text: [{ text: { content: name || '' } }] }
    };
    var minBody = JSON.stringify({ parent: { database_id: NOTION_DB_ID }, properties: minProps });

    try {
      var res2 = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + notionKey,
          'Content-Type': 'application/json',
          'Notion-Version': NOTION_API_VER
        },
        body: minBody
      });
      if (!res2.ok) {
        var errText2 = await res2.text();
        console.error('[Notion] Minimal retry also failed ' + res2.status + ':', errText2.substring(0, 500));
        console.error('[Notion] LIKELY CAUSE: DB ID wrong, integration not connected, or "Email" is not the title property.');
      } else {
        console.log('[Notion] Minimal row created for:', email, '(some fields missing — check DB property names)');
      }
    } catch(err2) {
      console.error('[Notion] Minimal retry network error:', err2.message);
    }
  } else {
    console.log('[Notion] Row created for:', email, '— score:', report.compliance_score);
  }
}

// ── Main handler (Vercel format) ──────────────────────────────────────────────
module.exports = async function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Parse body
  var body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  if (!body.formData || typeof body.formData !== 'object') {
    return res.status(400).json({ error: 'Missing formData' });
  }

  // Check Claude API key
  var claudeKey = process.env.CLAUDE_API_KEY;
  if (!claudeKey) {
    console.error('[Setup] CLAUDE_API_KEY not set in Vercel environment variables');
    return res.status(503).json({ error: 'Service not configured', setup_required: true });
  }

  // Extract name and email before sanitising
  var name = typeof body.formData.name === 'string' ? body.formData.name.trim().substring(0, 50) : '';
  var email = typeof body.formData.email === 'string' ? body.formData.email.trim() : '';

  // Sanitise everything except email before passing to Claude
  var formData = {};
  for (var key in body.formData) {
    if (key !== 'email' && key !== 'name') formData[key] = sanitise(body.formData[key]);
  }

  // Call Claude API
  var claudeRes;
  try {
    claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildPrompt(formData) }]
      })
    });
  } catch (err) {
    console.error('[Claude] Fetch error:', err.message);
    return res.status(503).json({ error: 'Could not reach AI service' });
  }

  if (!claudeRes.ok) {
    var errText = await claudeRes.text();
    console.error('[Claude] API error ' + claudeRes.status + ':', errText.substring(0, 200));
    return res.status(502).json({ error: 'AI service returned an error' });
  }

  var claudeData = await claudeRes.json();
  var raw = (claudeData.content && claudeData.content[0] && claudeData.content[0].text) || '';

  // Parse JSON from Claude response
  var report;
  try {
    var clean = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    report = JSON.parse(clean);
  } catch (e) {
    var match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      console.error('[Claude] Cannot extract JSON from response:', raw.substring(0, 200));
      return res.status(500).json({ error: 'Could not parse AI response' });
    }
    try {
      report = JSON.parse(match[0]);
    } catch (e2) {
      return res.status(500).json({ error: 'Invalid AI response format' });
    }
  }

  if (typeof report.compliance_score !== 'number' || !report.status) {
    return res.status(500).json({ error: 'Malformed report from AI' });
  }

  // Log to Notion - awaited so Vercel doesn't kill it before it completes
  var notionKey = process.env.NOTION_API_KEY;
  if (notionKey && email) {
    try {
      await logToNotion(notionKey, name, email, formData, report);
    } catch(err) {
      console.error('[Notion] Unexpected error:', err.message);
    }
  } else if (!notionKey) {
    console.warn('[Setup] NOTION_API_KEY not set - skipping Notion logging.');
  } else {
    console.warn('[Notion] No email in submission - skipping Notion logging.');
  }

  return res.status(200).json({ success: true, report: report });
};
