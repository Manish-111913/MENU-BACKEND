const express = require('express');
const router = express.Router();
const { pool, withTenant } = require('../db');

// PATCH /api/orders/:id/payment { businessId, status }
router.patch('/:id/payment', async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'DB not configured' });
    const orderId = Number(req.params.id);
    const { businessId, status } = req.body || {};
    if (!orderId || !businessId || !['paid','unpaid','partially_paid'].includes(status)) {
      return res.status(400).json({ error: 'Invalid orderId/businessId/status' });
    }
    const client = await pool.connect();
    try {
      await withTenant(client, Number(businessId));
      const upd = await client.query(`UPDATE Orders SET payment_status=$1, updated_at=NOW() WHERE order_id=$2 RETURNING order_id, payment_status`, [status, orderId]);
      if (!upd.rowCount) return res.status(404).json({ error: 'Order not found' });
      res.json({ success: true, order: upd.rows[0] });
    } finally { client.release(); }
  } catch (err) {
    console.error('PATCH /orders/:id/payment error', err);
    res.status(500).json({ error: 'Payment update failed' });
  }
});

// PATCH /api/orders/:id/status { businessId, status }
// Allowed transitions simple validation; production: enforce FSM.
const allowedStatuses = ['PLACED','IN_PROGRESS','READY','COMPLETED','DELAYED'];
router.patch('/:id/status', async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'DB not configured' });
    const orderId = Number(req.params.id);
    const { businessId, status } = req.body || {};
    if (!orderId || !businessId || !allowedStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid orderId/businessId/status' });
    }
    const client = await pool.connect();
    try {
      await withTenant(client, Number(businessId));
      const upd = await client.query(`UPDATE Orders SET status=$1, updated_at=NOW() WHERE order_id=$2 RETURNING order_id, status`, [status, orderId]);
      if (!upd.rowCount) return res.status(404).json({ error: 'Order not found' });
      res.json({ success: true, order: upd.rows[0] });
    } finally { client.release(); }
  } catch (err) {
    console.error('PATCH /orders/:id/status error', err);
    res.status(500).json({ error: 'Status update failed' });
  }
});

// GET /api/orders/kitchen?businessId=..&activeOnly=true
// Returns active orders with tableNumber + item breakdown for chef dashboard.
router.get('/kitchen', async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'DB not configured' });
    const businessId = Number(req.query.businessId) || Number(process.env.DEFAULT_BUSINESS_ID) || null;
    const activeOnly = String(req.query.activeOnly || 'true') === 'true';
    if (!businessId) return res.status(400).json({ error: 'businessId required' });
    const client = await pool.connect();
    try {
      await withTenant(client, businessId);
      const orders = await client.query(`
        SELECT o.order_id, o.status, o.payment_status, o.placed_at, o.estimated_ready_time,
               q.table_number, ds.session_id
        FROM Orders o
        JOIN DiningSessions ds ON o.dining_session_id = ds.session_id
        JOIN QRCodes q ON ds.qr_code_id = q.qr_code_id
        WHERE o.business_id=$1
          ${activeOnly ? "AND o.status IN ('PLACED','IN_PROGRESS','READY')" : ''}
        ORDER BY o.placed_at ASC
        LIMIT 200` , [businessId]);

      const orderIds = orders.rows.map(r=>r.order_id);
      let items = [];
      if (orderIds.length) {
        const inList = orderIds.map((_,i)=>`$${i+2}`).join(',');
        const q2 = await client.query(`
          SELECT oi.order_id, oi.order_item_id, oi.item_status, mi.name, mi.avg_prep_time_minutes
          FROM OrderItems oi
          JOIN MenuItems mi ON oi.menu_item_id = mi.menu_item_id
          WHERE oi.order_id IN (${inList})
          ORDER BY oi.order_item_id ASC
        `, [businessId, ...orderIds]);
        items = q2.rows;
      }
      // group items
      const grouped = orders.rows.map(o => ({
        ...o,
        items: items.filter(i=>i.order_id === o.order_id)
      }));
      res.json({ orders: grouped });
    } finally { client.release(); }
  } catch (err) {
    console.error('GET /api/orders/kitchen error', err);
    res.status(500).json({ error: 'Kitchen fetch failed' });
  }
});

// PATCH /api/order-items/:id/status { businessId, status }
const itemStatuses = ['QUEUED','IN_PROGRESS','COMPLETED'];
router.patch('/items/:id/status', async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'DB not configured' });
    const orderItemId = Number(req.params.id);
    const { businessId, status } = req.body || {};
    if (!orderItemId || !businessId || !itemStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid orderItemId/businessId/status' });
    }
    const client = await pool.connect();
    try {
      await withTenant(client, Number(businessId));
      const upd = await client.query(`UPDATE OrderItems SET item_status=$1, updated_at=NOW() WHERE order_item_id=$2 RETURNING order_item_id, item_status, order_id`, [status, orderItemId]);
      if (!upd.rowCount) return res.status(404).json({ error: 'Order item not found' });
      res.json({ success: true, item: upd.rows[0] });
    } finally { client.release(); }
  } catch (err) {
    console.error('PATCH /order-items/:id/status error', err);
    res.status(500).json({ error: 'Item status update failed' });
  }
});

module.exports = router;
