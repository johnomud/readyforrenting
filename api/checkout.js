'use strict';

// Ready for Renting - api/checkout.js
// POST /api/checkout — creates Stripe Checkout sessions for both products
// Body: { product: 'pack'|'tracker_monthly'|'tracker_yearly', email, name }
//
// ENV VARS NEEDED:
//   STRIPE_SECRET_KEY
//   STRIPE_PACK_PRICE_ID
//   STRIPE_TRACKER_MONTHLY_ID
//   STRIPE_TRACKER_YEARLY_ID
//   NEXT_PUBLIC_SITE_URL

var https = require('https');

function stripePost(path, data, key) {
  return new Promise(function(resolve, reject) {
    var body = Object.entries(data).map(function(e) {
      return encodeURIComponent(e[0]) + '=' + encodeURIComponent(e[1]);
    }).join('&');
    var opts = {
      hostname: 'api.stripe.com', port: 443, path: '/v1' + path, method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Stripe-Version': '2024-06-20'
      }
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
    req.write(body);
    req.end();
  });
}

module.exports = async function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var key = process.env.STRIPE_SECRET_KEY;
  if (!key) return res.status(503).json({ error: 'Payment not configured', setup_required: true });

  var body = req.body || {};
  var product = body.product;
  var email = (body.email || '').trim();
  var name = (body.name || '').trim().substring(0, 50);
  var siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://readyforrenting.uk';

  var priceId, mode, successUrl, cancelUrl;

  if (product === 'pack') {
    priceId = process.env.STRIPE_PACK_PRICE_ID;
    if (!priceId) return res.status(503).json({ error: 'Document pack not yet configured', setup_required: true });
    mode = 'payment';
    successUrl = siteUrl + '/download?session_id={CHECKOUT_SESSION_ID}';
    cancelUrl = siteUrl + '/#products';

  } else if (product === 'tracker_monthly' || product === 'tracker_yearly') {
    priceId = product === 'tracker_monthly'
      ? process.env.STRIPE_TRACKER_MONTHLY_ID
      : process.env.STRIPE_TRACKER_YEARLY_ID;
    if (!priceId) return res.status(503).json({ error: 'Tracker not yet configured', setup_required: true });
    mode = 'subscription';
    successUrl = siteUrl + '/tracker?session_id={CHECKOUT_SESSION_ID}';
    cancelUrl = siteUrl + '/#tracker';

  } else {
    return res.status(400).json({ error: 'Unknown product' });
  }

  var params = {
    'mode': mode,
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    'success_url': successUrl,
    'cancel_url': cancelUrl,
    'allow_promotion_codes': 'true',
    'metadata[product]': product,
    'metadata[name]': name
  };
  if (email) params['customer_email'] = email;
  if (mode === 'subscription') {
    params['subscription_data[metadata][product]'] = 'tracker';
    params['subscription_data[metadata][customer_name]'] = name;
  }

  try {
    var session = await stripePost('/checkout/sessions', params, key);
    return res.status(200).json({ url: session.url, session_id: session.id });
  } catch(err) {
    console.error('[Checkout] Stripe error:', JSON.stringify(err).substring(0, 200));
    return res.status(502).json({ error: 'Payment error. Please try again.' });
  }
};
