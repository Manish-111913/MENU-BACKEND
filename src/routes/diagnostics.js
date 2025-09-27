const express = require('express');
const router = express.Router();
const { pool, withTenant } = require('../db');

// Lightweight diagnostics for production debugging.
router.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Returns basic insight about tables & active sessions for a business
router.get('/table-state', async (req, res) => {
  const businessId = Number(req.query.businessId || req.query.bid || req.query.b) || null;
  const debug = [];
  if (!pool) return res.json({ error: 'no-pool', debug });
  const client = await pool.connect();
  try {
    if (businessId) { await withTenant(client, businessId); debug.push({ step:'tenant-set', businessId }); }
    // Collect QR codes & sessions
    let qrCodes = [];
    try {
      const qr = await client.query(`SELECT qr_code_id, business_id, table_number, current_session_id FROM QRCodes ORDER BY qr_code_id ASC LIMIT 200`);
      qrCodes = qr.rows;
    } catch(e) { debug.push({ step:'qrcodes-error', error:e.message }); }
    let sessions = [];
    try {
      const ds = await client.query(`SELECT session_id, business_id, qr_code_id, status, created_at FROM DiningSessions ORDER BY session_id DESC LIMIT 200`);
      sessions = ds.rows;
    } catch(e) { debug.push({ step:'sessions-error', error:e.message }); }
    let orders = [];
    try {
      const ord = await client.query(`SELECT order_id, dining_session_id, payment_status, status, created_at FROM Orders ORDER BY order_id DESC LIMIT 200`);
      orders = ord.rows;
    } catch(e) { debug.push({ step:'orders-error', error:e.message }); }

    // Derive simple table color logic (legacy-style)
    const tableColors = {};
    for (const qr of qrCodes) {
      const t = qr.table_number || 'GEN';
      tableColors[t] = 'ash';
    }
    for (const ord of orders) {
      const ds = sessions.find(s => s.session_id === ord.dining_session_id);
      if (!ds) continue;
      const qr = qrCodes.find(q => q.qr_code_id === ds.qr_code_id);
      const tableNum = qr?.table_number || 'GEN';
      if (!tableColors[tableNum]) tableColors[tableNum] = 'ash';
      if (ord.payment_status === 'paid') tableColors[tableNum] = 'green';
      else if (tableColors[tableNum] !== 'green') tableColors[tableNum] = 'yellow';
    }
    res.json({ ok:true, tableColors, counts:{ qrCodes: qrCodes.length, sessions: sessions.length, orders: orders.length }, debug });
  } catch(err) {
    debug.push({ step:'fatal', error: err.message });
    res.status(500).json({ error:'diagnostics-failed', debug });
  } finally { client.release(); }
});

// Echo config to verify frontend base matching
router.get('/config', (req,res) => {
  res.json({ frontendOrigin: process.env.FRONTEND_ORIGIN, nodeEnv: process.env.NODE_ENV, additionalOrigins: process.env.ADDITIONAL_ORIGINS });
});

module.exports = router;