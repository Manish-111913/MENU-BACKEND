const express = require('express');
const router = express.Router();
const { pool, withTenant } = require('../db');

// POST /api/checkout
// body: { businessId?, diningSessionId?, customerPrepTimeMinutes?, items: [{menuItemId, name, quantity, price}] }
router.post('/', async (req, res) => {
  const { businessId, diningSessionId, customerPrepTimeMinutes = 15, items = [] } = req.body || {};
  try {
    if (!pool) {
      return res.json({ success: true, orderId: 'mock-1', paymentRequired: false, amount: items.reduce((s,i)=>s + (i.price||0)*(i.quantity||0),0) });
    }
    const client = await pool.connect();
    try {
      const tenantId = Number(businessId) || Number(process.env.DEFAULT_BUSINESS_ID) || null;
      await withTenant(client, tenantId);

      // Ensure dining session
      let sessionId = diningSessionId;
      if (!sessionId) {
        const qr = await client.query(`SELECT qr_code_id FROM QRCodes WHERE business_id=$1 LIMIT 1`, [tenantId]);
        const qrId = qr.rows[0]?.qr_code_id || null;
        const ds = await client.query(
          `INSERT INTO DiningSessions (business_id, qr_code_id) VALUES ($1,$2) RETURNING session_id`,
          [tenantId, qrId]
        );
        sessionId = ds.rows[0].session_id;
      }

      // Create order in PLACED
      const ord = await client.query(
        `INSERT INTO Orders (business_id, dining_session_id, status, customer_prep_time_minutes)
         VALUES ($1,$2,'PLACED',$3) RETURNING order_id`,
        [tenantId, sessionId, customerPrepTimeMinutes]
      );
      const orderId = ord.rows[0].order_id;

      // Insert order items (if menuItemId present)
      for (const it of items) {
        if (it.menuItemId) {
          await client.query(
            `INSERT INTO OrderItems (order_id, menu_item_id, item_status, business_id)
             VALUES ($1,$2,'QUEUED',$3)`,
            [orderId, it.menuItemId, tenantId]
          );
        }
      }

      res.json({ success: true, orderId, sessionId });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('POST /api/checkout error:', err);
    res.status(500).json({ error: 'Checkout failed' });
  }
});

module.exports = router;
