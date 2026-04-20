'use strict';

// Ready for Renting - api/webhook.js
// Stripe webhook handler — fires after payment
// Handles: checkout.session.completed, customer.subscription.deleted
//
// ENV VARS NEEDED:
//   STRIPE_WEBHOOK_SECRET   Webhook signing secret from Stripe dashboard
//   STRIPE_SECRET_KEY       For API calls back to Stripe
//   RESEND_API_KEY          For sending emails
//   NOTION_API_KEY          For logging to Notion
//   NEXT_PUBLIC_SITE_URL    Site URL

var crypto = require('crypto');
var https = require('https');

module.exports.config = { api: { bodyParser: false } };

function getRawBody(req) {
  return new Promise(function(resolve, reject) {
    var chunks = [];
    req.on('data', function(c) { chunks.push(c); });
    req.on('end', function() { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

function verifyStripeSignature(payload, header, secret) {
  var parts = header.split(',').reduce(function(acc, part) {
    var kv = part.split('=');
    acc[kv[0]] = kv[1];
    return acc;
  }, {});
  var timestamp = parts['t'];
  var sig = parts['v1'];
  if (!timestamp || !sig) throw new Error('Invalid signature header');
  var expected = crypto.createHmac('sha256', secret)
    .update(timestamp + '.' + payload)
    .digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    throw new Error('Signature mismatch');
  }
}

function sendEmail(apiKey, to, subject, html) {
  return new Promise(function(resolve, reject) {
    var body = JSON.stringify({
      from: 'Ready for Renting <noreply@readyforrenting.uk>',
      to: [to],
      subject: subject,
      html: html
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

function stripeGet(path, key) {
  return new Promise(function(resolve, reject) {
    var opts = {
      hostname: 'api.stripe.com', port: 443, path: '/v1' + path, method: 'GET',
      headers: { 'Authorization': 'Bearer ' + key, 'Stripe-Version': '2024-06-20' }
    };
    var req = https.request(opts, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        var json = JSON.parse(Buffer.concat(chunks).toString());
        res.statusCode >= 400 ? reject(json) : resolve(json);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function logPurchaseToNotion(notionKey, data) {
  var NOTION_DB_ORDERS = process.env.NOTION_ORDERS_DB_ID || '971331b17eb44c3a9a2497c5e04cc62c';
  if (!NOTION_DB_ORDERS) return;

  var props = {
    'Email': { title: [{ text: { content: data.email || 'unknown' } }] },
    'Name': { rich_text: [{ text: { content: data.name || '' } }] },
    'Product': { select: { name: data.product || 'unknown' } },
    'Amount': { number: data.amount || 0 },
    'Stripe Session': { rich_text: [{ text: { content: data.session_id || '' } }] },
    'Purchased': { date: { start: new Date().toISOString().split('T')[0] } }
  };

  var body = JSON.stringify({ parent: { database_id: NOTION_DB_ORDERS }, properties: props });
  await new Promise(function(resolve) {
    var opts = {
      hostname: 'api.notion.com', port: 443, path: '/v1/pages', method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + notionKey,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    var req = https.request(opts, function(res) {
      res.on('data', function() {});
      res.on('end', resolve);
    });
    req.on('error', function(e) { console.error('[Notion] Order log error:', e.message); resolve(); });
    req.write(body);
    req.end();
  });
}

function packDownloadEmail(name, siteUrl, sessionId) {
  var downloadUrl = siteUrl + '/download?session_id=' + sessionId;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#F8FAFC;font-family:'Inter',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F8FAFC;padding:40px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(17,17,17,0.08);">
<tr><td style="background:#111111;padding:32px 40px;">
  <p style="margin:0;font-size:20px;font-weight:700;color:#ffffff;">Ready <span style="color:#5B21B6;">for</span> Renting</p>
</td></tr>
<tr><td style="padding:40px;">
  <h1 style="margin:0 0 8px;font-size:24px;color:#111111;">Your document pack is ready, ${name || 'there'}.</h1>
  <p style="margin:0 0 24px;color:#6b7280;font-size:15px;line-height:1.6;">
    Thank you for your purchase. Your Ready for Renting Renters&#8217; Rights Act 2025 Document Pack is ready to download.
  </p>
  <div style="background:#F8FAFC;border-radius:8px;padding:20px;margin-bottom:24px;">
    <p style="margin:0 0 8px;font-weight:700;color:#111111;font-size:14px;">Your pack includes:</p>
    <ul style="margin:0;padding-left:20px;color:#374151;font-size:14px;line-height:1.8;">
      <li>Assured Periodic Tenancy Agreement (post-May 2026)</li>
      <li>Section 8 Possession Notice templates (all key grounds)</li>
      <li>Government Information Sheet (due to all tenants by 31 May 2026)</li>
      <li>Section 13 Rent Increase Notice (Form 4A format)</li>
      <li>Compliance Action Checklist (printable)</li>
    </ul>
  </div>
  <a href="${downloadUrl}" style="display:inline-block;background:#5B21B6;color:#ffffff;font-weight:700;font-size:15px;padding:14px 28px;border-radius:8px;text-decoration:none;margin-bottom:16px;">
    Download Document Pack &rarr;
  </a>
  <p style="margin:0 0 24px;color:#6b7280;font-size:13px;">
    This link is valid for 48 hours. If it expires, reply to this email and we&#8217;ll send a fresh link.
  </p>
  <div style="border-left:3px solid #5B21B6;padding:12px 16px;background:#f5e9cc;border-radius:0 8px 8px 0;margin-bottom:24px;">
    <p style="margin:0;font-size:13px;color:#5c3a00;line-height:1.6;">
      <strong>Reminder:</strong> The Government Information Sheet (Document 3) must be sent to all existing tenants by <strong>31 May 2026</strong>.
      Civil penalty up to &#163;7,000 per tenancy for non-compliance.
    </p>
  </div>
  <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;">
  <p style="margin:0;color:#9ca3af;font-size:12px;line-height:1.6;">
    Ready for Renting &#183; readyforrenting.uk<br>
    This email and the documents are general information only &#8212; not legal advice. Always verify with gov.uk.
  </p>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

function trackerWelcomeEmail(name, siteUrl, sessionId) {
  var trackerUrl = siteUrl + '/tracker?session_id=' + sessionId;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#F8FAFC;font-family:'Inter',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F8FAFC;padding:40px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(17,17,17,0.08);">
<tr><td style="background:#111111;padding:32px 40px;">
  <p style="margin:0;font-size:20px;font-weight:700;color:#ffffff;">Ready <span style="color:#5B21B6;">for</span> Renting</p>
</td></tr>
<tr><td style="padding:40px;">
  <h1 style="margin:0 0 8px;font-size:24px;color:#111111;">Welcome to the Certificate Tracker, ${name || 'there'}.</h1>
  <p style="margin:0 0 24px;color:#6b7280;font-size:15px;line-height:1.6;">
    Your subscription is active. Add your properties and certificate expiry dates and we&#8217;ll send you
    automated reminders at 60, 30, and 7 days before anything lapses.
  </p>
  <a href="${trackerUrl}" style="display:inline-block;background:#5B21B6;color:#ffffff;font-weight:700;font-size:15px;padding:14px 28px;border-radius:8px;text-decoration:none;margin-bottom:24px;">
    Open Your Tracker &rarr;
  </a>
  <div style="background:#F8FAFC;border-radius:8px;padding:20px;margin-bottom:24px;">
    <p style="margin:0 0 8px;font-weight:700;color:#111111;font-size:14px;">What the tracker monitors:</p>
    <ul style="margin:0;padding-left:20px;color:#374151;font-size:14px;line-height:1.8;">
      <li>Gas Safety Certificate (annual &#8212; fine up to &#163;6,000 if lapsed)</li>
      <li>Electrical Installation Condition Report (every 5 years)</li>
      <li>Energy Performance Certificate (every 10 years &#8212; C rating by 2030)</li>
      <li>House in Multiple Occupation licence (every 5 years)</li>
      <li>Private Rented Sector Database registration (opens late 2026)</li>
      <li>Smoke &amp; carbon monoxide alarm checks</li>
    </ul>
  </div>
  <p style="margin:0 0 8px;font-size:14px;color:#374151;">
    <strong>Bookmark your tracker link</strong> &#8212; you can access it any time from the link in this email
    or by clicking &#8220;Access my tracker&#8221; on the website.
  </p>
  <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;">
  <p style="margin:0;color:#9ca3af;font-size:12px;line-height:1.6;">
    Ready for Renting &#183; readyforrenting.uk &#183; &#163;7/month &#8212; cancel anytime from your account.<br>
    Questions? Reply to this email.
  </p>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

module.exports = async function(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  var webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[Webhook] STRIPE_WEBHOOK_SECRET not set');
    return res.status(503).end();
  }

  var rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch(e) {
    return res.status(400).end();
  }

  var sig = req.headers['stripe-signature'];
  try {
    verifyStripeSignature(rawBody.toString(), sig, webhookSecret);
  } catch(e) {
    console.error('[Webhook] Signature verification failed:', e.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  var event;
  try {
    event = JSON.parse(rawBody.toString());
  } catch(e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  var siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://readyforrenting.uk';
  var resendKey = process.env.RESEND_API_KEY;
  var notionKey = process.env.NOTION_API_KEY;
  var stripeKey = process.env.STRIPE_SECRET_KEY;

  if (event.type === 'checkout.session.completed') {
    var session = event.data.object;
    var email = session.customer_details && session.customer_details.email;
    var name = (session.metadata && session.metadata.name) || '';
    var sessionId = session.id;
    var product = session.metadata && session.metadata.product;

    // Fallback: Payment Links don't set metadata.product automatically.
    // If product is still unknown, look up the line items by price ID.
    if (!product && stripeKey) {
      try {
        var lineItems = await stripeGet('/checkout/sessions/' + sessionId + '/line_items?limit=5', stripeKey);
        var priceMap = {
          'price_1TMVx2I9VlhtlGA1bYJ1AjAF': 'pack',
          'price_1TMVy7I9VlhtlGA1rZRBGzZZ': 'tracker_monthly',
          'price_1TMVylI9VlhtlGA1swKIxws5': 'tracker_yearly'
        };
        var items = lineItems && lineItems.data;
        if (items && items.length > 0) {
          var priceId = items[0].price && items[0].price.id;
          if (priceId && priceMap[priceId]) {
            product = priceMap[priceId];
            console.log('[Webhook] Product identified from price ID:', priceId, '->', product);
          }
        }
      } catch(e) {
        console.error('[Webhook] Failed to fetch line items:', e.message);
      }
    }
    var amountTotal = session.amount_total ? session.amount_total / 100 : 0;

    console.log('[Webhook] Payment complete:', product, email, '£' + amountTotal);

    // Log to Notion
    if (notionKey && email) {
      try {
        await logPurchaseToNotion(notionKey, {
          email, name, product, amount: amountTotal, session_id: sessionId
        });
      } catch(e) {
        console.error('[Webhook] Notion log error:', e.message);
      }
    }

    // Send email
    if (resendKey && email) {
      try {
        if (product === 'pack') {
          var html = packDownloadEmail(name, siteUrl, sessionId);
          await sendEmail(resendKey, email, 'Your Ready for Renting Document Pack is ready', html);
          console.log('[Webhook] Pack download email sent to:', email);

        } else if (product === 'tracker_monthly' || product === 'tracker_yearly') {
          var welcomeHtml = trackerWelcomeEmail(name, siteUrl, sessionId);
          await sendEmail(resendKey, email, 'Welcome to Ready for Renting Certificate Tracker', welcomeHtml);
          console.log('[Webhook] Tracker welcome email sent to:', email);
        }
      } catch(e) {
        console.error('[Webhook] Email error:', e.message);
      }
    } else if (!resendKey) {
      console.warn('[Webhook] RESEND_API_KEY not set — skipping email');
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    // Subscription cancelled — log it
    var sub = event.data.object;
    console.log('[Webhook] Subscription cancelled:', sub.id, sub.customer);
    // Could send cancellation email here if we have customer email
  }

  return res.status(200).json({ received: true });
};
