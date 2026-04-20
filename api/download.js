'use strict';

// Ready for Renting - api/download.js
// GET /api/download?session_id=xxx
// Validates Stripe session ID and streams the document pack ZIP
//
// ENV VARS NEEDED:
//   STRIPE_SECRET_KEY

var https = require('https');
var fs = require('fs');
var path = require('path');

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
  if (req.method !== 'GET') return res.status(405).end();

  var sessionId = req.query && req.query.session_id;
  if (!sessionId || typeof sessionId !== 'string' || !sessionId.startsWith('cs_')) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }

  var stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return res.status(503).json({ error: 'Service not configured' });
  }

  // Validate session with Stripe
  var session;
  try {
    session = await stripeGet('/checkout/sessions/' + sessionId, stripeKey);
  } catch(err) {
    console.error('[Download] Stripe session lookup failed:', JSON.stringify(err).substring(0, 100));
    return res.status(404).json({ error: 'Session not found' });
  }

  // Check payment was successful
  if (session.payment_status !== 'paid') {
    return res.status(402).json({ error: 'Payment not completed' });
  }

  // Check it was for the document pack
  // Payment Links don't set metadata.product, so we also accept sessions
  // where metadata is absent/empty (any paid session is valid for download).
  if (session.metadata && session.metadata.product && session.metadata.product !== 'pack') {
    return res.status(403).json({ error: 'This session is not for the document pack' });
  }

  // Check session isn't too old (48 hours)
  var sessionAge = Date.now() / 1000 - session.created;
  if (sessionAge > 48 * 3600) {
    return res.status(410).json({
      error: 'Download link expired. Please email help@readyforrenting.uk for a fresh link.',
      expired: true
    });
  }

  // Serve the ZIP (bundled via vercel.json includeFiles)
  var zipPath = path.join(process.cwd(), 'private/docs/readyforrenting-document-pack.zip');

  if (!fs.existsSync(zipPath)) {
    console.error('[Download] ZIP not found at:', zipPath);
    return res.status(500).json({ error: 'Download file not found' });
  }

  var stat = fs.statSync(zipPath);
  var email = session.customer_details && session.customer_details.email;

  console.log('[Download] Serving document pack to:', email, 'session:', sessionId.substring(0, 20));

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="ReadyForRenting-Document-Pack.zip"');
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Cache-Control', 'no-store');

  var stream = fs.createReadStream(zipPath);
  stream.pipe(res);
};
