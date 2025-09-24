const express = require('express');
const router = express.Router();
const { pool, withTenant } = require('../db');

// GET /api/orders?businessId=&sessionId=
router.get('/', async (req, res) => {
  try {
    if (!pool) {
      return res.json({ orders: [] });
    }
    const businessId = Number(req.query.businessId) || Number(process.env.DEFAULT_BUSINESS_ID) || null;
    const sessionId = Number(req.query.sessionId) || null;
    const client = await pool.connect();
    try {
      await withTenant(client, businessId);
      const params = [];
      let sql = `SELECT o.order_id, o.status, o.placed_at, o.estimated_ready_time, o.actual_ready_time, o.payment_status
                 FROM Orders o
                 WHERE 1=1`;
      if (businessId) { params.push(businessId); sql += ` AND o.business_id = $${params.length}`; }
      if (sessionId)  { params.push(sessionId);  sql += ` AND o.dining_session_id = $${params.length}`; }
      sql += ' ORDER BY o.placed_at DESC LIMIT 50';
      const { rows } = await client.query(sql, params);
      res.json({ orders: rows });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('GET /api/orders error:', err);
    res.status(500).json({ error: 'Failed to load orders' });
  }
});

module.exports = router;
