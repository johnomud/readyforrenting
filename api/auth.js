'use strict';

// Ready for Renting - api/auth.js
// GET /api/auth?session_id=xxx
// Validates a Stripe session and returns { valid, product, email, name, customer_id }
//
// Used by the tracker app to verify access

var https = require('https');

function stripeGet(apiPath, key) {
  return new Promise(function(resolve, reject) {
    var opts = {
      hostname: 'api.stripe.com', port: 443, path: '/v1' + apiPath, method: 'GET',
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

module.exports = async function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') return res.status(405).end();

  var sessionId = req.query && req.query.session_id;
  if (!sessionId || !sessionId.startsWith('cs_')) {
    return res.status(400).json({ valid: false, error: 'No session ID' });
  }

  var stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(503).json({ valid: false, error: 'Not configured' });

  try {
    var session = await stripeGet('/checkout/sessions/' + sessionId, stripeKey);

    if (session.payment_status !== 'paid') {
      return res.status(402).json({ valid: false, error: 'Payment not completed' });
    }

    var product = session.metadata && session.metadata.product;
    var isTrackerProduct = product === 'tracker_monthly' || product === 'tracker_yearly';

    if (!isTrackerProduct) {
      return res.status(403).json({ valid: false, error: 'Session is not for the tracker' });
    }

    // For subscriptions, check the subscription is still active
    if (session.subscription) {
      try {
        var sub = await stripeGet('/subscriptions/' + session.subscription, stripeKey);
        if (sub.status !== 'active' && sub.status !== 'trialing') {
          return res.status(403).json({
            valid: false,
            cancelled: true,
            error: 'Subscription is ' + sub.status
          });
        }
      } catch(subErr) {
        console.error('[Auth] Could not check subscription:', subErr.message || subErr.code);
        // Be lenient — session was paid, continue
      }
    }

    var email = session.customer_details && session.customer_details.email;
    var name = session.metadata && session.metadata.name;

    return res.status(200).json({
      valid: true,
      product: product,
      email: email || '',
      name: name || '',
      customer_id: session.customer || '',
      session_id: session.id
    });

  } catch(err) {
    console.error('[Auth] Error:', JSON.stringify(err).substring(0, 100));
    return res.status(404).json({ valid: false, error: 'Session not found' });
  }
};
