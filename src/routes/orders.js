const express = require('express');
const router = express.Router();
const { pool, withTenant } = require('../db');

// GET /api/orders?businessId=&sessionId=&limit=50
// Returns enriched orders with table_number and color status (ash/unpaid -> yellow/active -> green/paid)
router.get('/', async (req, res) => {
  try {
    if (!pool) {
      return res.json({ orders: [] });
    }
    const businessId = Number(req.query.businessId) || Number(process.env.DEFAULT_BUSINESS_ID) || null;
    const sessionId = Number(req.query.sessionId) || null;
    const limit = Math.min(Number(req.query.limit)||50, 200);
    const client = await pool.connect();
    try {
      await withTenant(client, businessId);
      // join to DiningSessions and QRCodes when present
      const params = [];
      let sql = `SELECT o.order_id, o.status, o.placed_at, o.estimated_ready_time, o.actual_ready_time, o.payment_status,
                        o.dining_session_id, ds.qr_code_id, q.table_number
                   FROM Orders o
                   LEFT JOIN DiningSessions ds ON ds.session_id = o.dining_session_id
                   LEFT JOIN QRCodes q ON q.qr_code_id = ds.qr_code_id
                   WHERE 1=1`;
      if (businessId) { params.push(businessId); sql += ` AND o.business_id = $${params.length}`; }
      if (sessionId)  { params.push(sessionId);  sql += ` AND o.dining_session_id = $${params.length}`; }
      sql += ` ORDER BY o.placed_at DESC LIMIT ${limit}`;
      const { rows } = await client.query(sql, params);
      const enriched = rows.map(r => ({
        ...r,
        color: r.payment_status === 'paid' ? 'green' : (r.status && r.status.toLowerCase() === 'placed' ? 'yellow' : 'ash')
      }));
      res.json({ orders: enriched });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('GET /api/orders error:', err);
    res.status(500).json({ error: 'Failed to load orders' });
  }
});

// POST /api/orders/bridge-session-orders
// If session_orders table exists, ensure a summary row for a given session/order
router.post('/bridge-session-orders', async (req,res)=>{
  try {
    if (!pool) return res.status(503).json({ error:'No DB pool' });
    const { sessionId, orderId, businessId } = req.body || {};
    if (!sessionId || !orderId) return res.status(400).json({ error:'sessionId and orderId required' });
    const client = await pool.connect();
    const debug = [];
    try {
      if (businessId) await withTenant(client, Number(businessId));
      const exists = await client.query(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='session_orders' LIMIT 1`);
      if (!exists.rowCount) return res.status(404).json({ error:'session_orders-missing', debug });
      const prior = await client.query(`SELECT id FROM session_orders WHERE session_id=$1 LIMIT 1`, [sessionId]);
      if (prior.rowCount) { debug.push({ step:'already-present', id: prior.rows[0].id }); return res.json({ ok:true, already:true, id: prior.rows[0].id, debug }); }
      const ord = await client.query(`SELECT payment_status FROM Orders WHERE order_id=$1`, [orderId]);
      const pay = ord.rows[0]?.payment_status || 'unpaid';
      const ins = await client.query(`INSERT INTO session_orders (session_id, order_status, payment_status, total_amount, created_at) VALUES ($1,'completed',$2,0,NOW()) RETURNING id`, [sessionId, pay]);
      debug.push({ step:'inserted', id: ins.rows[0].id });
      res.json({ ok:true, id: ins.rows[0].id, payment_status: pay, debug });
    } finally { client.release(); }
  } catch(e) { console.error('bridge-session-orders error', e); res.status(500).json({ error:e.message }); }
});

module.exports = router;
