'use strict';

// Ready for Renting - api/reminders.js
// GET /api/reminders?secret=xxx
// Called by a cron job (Vercel Cron or external) to send certificate expiry reminders
// Scans tracker data and sends emails at 60, 30, and 7 days before expiry
//
// ENV VARS NEEDED:
//   CRON_SECRET       Random secret to authenticate cron calls
//   RESEND_API_KEY    For sending reminder emails
//   STRIPE_SECRET_KEY For validating active subscriptions

var https = require('https');

function sendEmail(apiKey, to, subject, html) {
  return new Promise(function(resolve, reject) {
    var body = JSON.stringify({
      from: 'Ready for Renting Reminders <reminders@readyforrenting.uk>',
      to: [to], subject: subject, html: html
    });
    var opts = {
      hostname: 'api.resend.com', port: 443, path: '/emails', method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    var req = https.request(opts, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() { resolve(JSON.parse(Buffer.concat(chunks).toString())); });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function reminderEmail(name, certType, propName, daysUntil, siteUrl) {
  var urgency = daysUntil <= 7 ? 'URGENT' : daysUntil <= 30 ? 'Action required' : 'Reminder';
  var badgeColor = daysUntil <= 7 ? '#b31b1b' : daysUntil <= 30 ? '#c45400' : '#5B21B6';
  var daysText = daysUntil <= 0 ? 'has EXPIRED' :
    daysUntil === 1 ? 'expires TOMORROW' :
    'expires in ' + daysUntil + ' days';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F8FAFC;font-family:'Inter',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F8FAFC;padding:40px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;">
<tr><td style="background:#111111;padding:24px 40px;display:flex;align-items:center;justify-content:space-between;">
  <p style="margin:0;font-size:18px;font-weight:700;color:#fff;">Ready <span style="color:#5B21B6;">for</span> Renting</p>
</td></tr>
<tr><td style="padding:32px 40px;">
  <div style="background:${badgeColor};color:#fff;display:inline-block;font-size:12px;font-weight:700;padding:4px 12px;border-radius:50px;letter-spacing:.05em;text-transform:uppercase;margin-bottom:16px;">${urgency}</div>
  <h1 style="margin:0 0 8px;font-size:22px;color:#111111;">${certType} ${daysText}</h1>
  <p style="margin:0 0 24px;color:#6b7280;font-size:15px;line-height:1.6;">
    ${name ? 'Hi ' + name + ', your ' : 'Your '}<strong>${certType}</strong> for
    <strong>${propName}</strong> ${daysText}.
    ${daysUntil <= 0 ? ' <strong>Immediate action required.</strong>' : ' Please arrange renewal now.'}
  </p>
  <a href="${siteUrl}/tracker" style="display:inline-block;background:#5B21B6;color:#ffffff;font-weight:700;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none;margin-bottom:24px;">
    Open Certificate Tracker &rarr;
  </a>
  <div style="background:#F8FAFC;border-radius:8px;padding:16px;font-size:13px;color:#374151;line-height:1.6;">
    <strong>Why this matters:</strong><br>
    ${getCertPenalty(certType)}
  </div>
  <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;">
  <p style="margin:0;color:#9ca3af;font-size:12px;">Ready for Renting &#183; readyforrenting.uk &#183;
  <a href="${siteUrl}/tracker" style="color:#9ca3af;">Manage reminders</a></p>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

function getCertPenalty(certType) {
  var penalties = {
    'Gas Safety Certificate': 'Landlords can be fined up to &#163;6,000 and may face prosecution for failing to provide a valid Gas Safety Certificate.',
    'EICR': 'Failure to provide a valid Electrical Installation Condition Report carries a civil penalty of up to &#163;30,000.',
    'EPC': 'You cannot legally market a property to let without a valid Energy Performance Certificate.',
    'HMO Licence': 'Letting an unlicensed House in Multiple Occupation is a criminal offence and can result in a rent repayment order.',
    'PRS Registration': 'Landlords without Private Rented Sector Database registration cannot use key possession grounds under Section 8.',
  };
  return penalties[certType] || 'Keeping all certificates up to date is a legal requirement for private landlords.';
}

// NOTE: In production, tracker data is stored in the browser (localStorage).
// This endpoint is a framework for server-side reminders.
// For full server-side reminders, integrate with a database like Supabase or PlanetScale
// where tracker data is synced on each app session.
// For now this endpoint validates auth and can be called to trigger a reminder
// for a specific certificate via POST.

module.exports = async function(req, res) {
  // Validate cron secret
  var secret = req.query && req.query.secret;
  var cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    console.error('[Reminders] CRON_SECRET not set');
    return res.status(503).json({ error: 'Not configured' });
  }

  if (secret !== cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // POST: send a specific reminder (called from tracker app)
  if (req.method === 'POST') {
    var body = req.body || {};
    var { email, name, certType, propName, daysUntil } = body;

    if (!email || !certType || !propName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    var resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) {
      return res.status(503).json({ error: 'Email not configured' });
    }

    var siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://readyforrenting.uk';
    var days = parseInt(daysUntil) || 0;
    var urgency = days <= 7 ? 'URGENT: ' : days <= 30 ? 'Action needed: ' : 'Reminder: ';
    var subject = urgency + certType + ' for ' + propName;

    try {
      var result = await sendEmail(resendKey, email, subject,
        reminderEmail(name, certType, propName, days, siteUrl));
      console.log('[Reminders] Sent to:', email, 'cert:', certType);
      return res.status(200).json({ sent: true, id: result.id });
    } catch(e) {
      console.error('[Reminders] Email error:', e.message);
      return res.status(500).json({ error: 'Failed to send email' });
    }
  }

  return res.status(200).json({ status: 'ok', message: 'Reminders endpoint ready' });
};
