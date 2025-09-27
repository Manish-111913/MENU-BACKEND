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

// POST /api/orders
// Creates a new order for a table, reusing (or creating) the active dining session.
// If payNow / paymentMethod = online/paid is provided, the order & session are marked paid immediately.
// Minimal required body: { businessId, tableNumber }
// Optional fields: items (array), payNow (bool), paymentMethod ('online'), payment_status ('paid'), totalAmount
router.post('/', async (req, res) => {
  const debug = [];
  try {
    if (!pool) return res.status(503).json({ error: 'DB unavailable' });
    const {
      businessId: rawBiz,
      tableNumber: rawTable,
      table_number,
      items = [],
      payNow: rawPayNow,
      paymentMethod,
      payment_method,
      payment_status,
      totalAmount,
      pay_first,
      paymentInfo,
      customerInfo
    } = req.body || {};

    const businessId = Number(rawBiz || process.env.DEFAULT_BUSINESS_ID || 0);
    if (!businessId) return res.status(400).json({ error: 'businessId required' });
    const tableNumber = (rawTable || table_number || '').toString().trim();
    if (!tableNumber) return res.status(400).json({ error: 'tableNumber required' });

    // Determine if immediate payment was indicated.
    // Accept nested paymentInfo.method as well
    const pm = (paymentMethod || payment_method || paymentInfo?.method || '').toString().toLowerCase();
    const explicitPaid = (payment_status || '').toString().trim().toLowerCase() === 'paid';
    const payNow = !!(rawPayNow || pay_first || explicitPaid || pm === 'online' || pm === 'paid');

    // Derive total if not passed explicitly via totalAmount using paymentInfo.amount
    let derivedTotal = totalAmount;
    if ((derivedTotal === undefined || derivedTotal === null) && paymentInfo && paymentInfo.amount != null) {
      derivedTotal = Number(paymentInfo.amount) || 0;
    }

    const client = await pool.connect();
    try {
      await withTenant(client, businessId);
      await client.query('BEGIN');
      debug.push({ step: 'tx-begin' });

      // Find QR code for the table
      const qrRes = await client.query(
        `SELECT qr_code_id, current_session_id FROM QRCodes WHERE business_id=$1 AND table_number=$2 LIMIT 1`,
        [businessId, tableNumber]
      );
      if (!qrRes.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'table-not-found', tableNumber });
      }
      const qr = qrRes.rows[0];
      debug.push({ step: 'qr-found', qr_code_id: qr.qr_code_id, current_session_id: qr.current_session_id });

      let sessionId = qr.current_session_id || null;
      let sessionPaymentStatus = 'unpaid';

      if (sessionId) {
        const sessRes = await client.query(`SELECT session_id, payment_status FROM DiningSessions WHERE session_id=$1 LIMIT 1`, [sessionId]);
        if (sessRes.rowCount) {
          sessionPaymentStatus = (sessRes.rows[0].payment_status || 'unpaid').trim().toLowerCase();
          debug.push({ step: 'reuse-session', session_id: sessionId, payment_status: sessionPaymentStatus });
        } else {
          // Orphaned pointer - create a new session
          debug.push({ step: 'orphaned-session-pointer', prior: sessionId });
          sessionId = null;
        }
      }

      if (!sessionId) {
        const dsIns = await client.query(
          `INSERT INTO DiningSessions (qr_code_id, business_id, started_at, status, payment_status) VALUES ($1,$2,NOW(),'active','unpaid') RETURNING session_id, payment_status`,
          [qr.qr_code_id, businessId]
        );
        sessionId = dsIns.rows[0].session_id;
        sessionPaymentStatus = (dsIns.rows[0].payment_status || 'unpaid').trim().toLowerCase();
        debug.push({ step: 'session-created', session_id: sessionId });
        await client.query(`UPDATE QRCodes SET current_session_id=$1 WHERE qr_code_id=$2`, [sessionId, qr.qr_code_id]);
        debug.push({ step: 'qr-updated-with-session' });
      }

      // If payNow requested, pre-mark session paid (even before order insert) to support green with zero orders edge case.
      if (payNow && sessionPaymentStatus !== 'paid') {
        await client.query(`UPDATE DiningSessions SET payment_status='paid' WHERE session_id=$1`, [sessionId]);
        sessionPaymentStatus = 'paid';
        debug.push({ step: 'session-marked-paid' });
      }

      // Insert order (always create an order so counts reflect activity, unless explicitly skip when no items & already paid? We'll always insert for clarity)
      const orderPaymentStatus = payNow ? 'paid' : 'unpaid';
      const ordIns = await client.query(
        `INSERT INTO Orders (business_id, dining_session_id, status, placed_at, payment_status, total_amount)
         VALUES ($1,$2,'PLACED',NOW(),$3,COALESCE($4,0)) RETURNING order_id, payment_status, status, placed_at`,
        [businessId, sessionId, orderPaymentStatus, derivedTotal]
      );
      const order = ordIns.rows[0];
      debug.push({ step: 'order-inserted', order_id: order.order_id, payment_status: order.payment_status });

      // Optionally insert items if OrderItems table exists and items array not empty
      if (Array.isArray(items) && items.length) {
        const existsItems = await client.query(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='orderitems' LIMIT 1`);
        if (existsItems.rowCount) {
          for (const it of items) {
            const name = (it.name || it.itemName || '').toString();
            const qty = Number(it.quantity || it.qty || 1);
            const price = Number(it.price || it.unitPrice || 0);
            await client.query(
              `INSERT INTO OrderItems (order_id, item_name, quantity, price, created_at) VALUES ($1,$2,$3,$4,NOW())`,
              [order.order_id, name, qty, price]
            );
          }
          debug.push({ step: 'items-inserted', count: items.length });
        } else {
          debug.push({ step: 'items-skipped-no-table' });
        }
      }

      await client.query('COMMIT');
      debug.push({ step: 'tx-commit' });

      // Color hint logic aligned with /by-table route.
      const colorHint = order.payment_status === 'paid' || sessionPaymentStatus === 'paid' ? 'green' : (order.status && order.status.toLowerCase() === 'placed' ? 'yellow' : 'ash');
      const colorReason = colorHint === 'green' ? 'order-paid' : (colorHint === 'yellow' ? 'order-unpaid' : 'no-session');

      return res.status(201).json({
        success: true,
        ok: true,
        data: {
          order_id: order.order_id,
          payment_status: order.payment_status,
          status: order.status,
          placed_at: order.placed_at,
          session_id: sessionId,
          session_payment_status: sessionPaymentStatus,
          table_number: tableNumber,
          colorHint,
          colorReason,
          customer_name: customerInfo?.name || null
        },
        debug
      });
    } catch (e) {
      try { await client.query('ROLLBACK'); debug.push({ step: 'tx-rollback', error: e.message }); } catch(_) {}
      console.error('POST /api/orders error (inner):', e);
      return res.status(500).json({ success:false, error: 'order-create-failed', message: e.message, debug });
    } finally {
      if (client) client.release();
    }
  } catch (err) {
    console.error('POST /api/orders error:', err);
    res.status(500).json({ success:false, error: 'internal-error', message: err.message, debug });
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

// POST /api/orders/ensure-session-orders
// Auto-creates legacy session_orders table if missing (id serial PK, session_id bigint unique, order_status, payment_status, total_amount numeric, created_at timestamptz)
router.post('/ensure-session-orders', async (req,res)=>{
  try {
    if (!pool) return res.status(503).json({ error:'No DB pool' });
    const { businessId } = req.body || {};
    const client = await pool.connect();
    const debug = [];
    try {
      if (businessId) await withTenant(client, Number(businessId));
      const exists = await client.query(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='session_orders' LIMIT 1`);
      if (exists.rowCount) return res.json({ ok:true, already:true, debug });
      await client.query(`CREATE TABLE session_orders (
        id BIGSERIAL PRIMARY KEY,
        session_id BIGINT UNIQUE NOT NULL,
        order_status TEXT,
        payment_status TEXT,
        total_amount NUMERIC(12,2) DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);
      debug.push({ step:'table-created' });
      res.json({ ok:true, created:true, debug });
    } finally { client.release(); }
  } catch(e) { console.error('ensure-session-orders error', e); res.status(500).json({ error:e.message }); }
});

module.exports = router;

// ---------------------------------------------------------------------------
// GET /api/orders/by-table?businessId=1&debug=1
// Aggregates per table payment status -> color (ash / yellow / green)
// Rules:
//  - No active session: ash
//  - Active session, zero orders:
//       * yellow (scanned but nothing ordered) unless session payment_status='paid' -> green
//  - Active session, >=1 orders:
//       * if any unpaid order -> yellow
//       * else (all paid OR session marked paid) -> green
// Includes colorReason to aid debugging. If debug=1, also includes order_statuses (list of payment_status values for that table's session orders).
// ---------------------------------------------------------------------------
router.get('/by-table', async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'DB unavailable' });
    const businessId = Number(req.query.businessId) || Number(process.env.DEFAULT_BUSINESS_ID) || null;
    if (!businessId) return res.status(400).json({ error: 'businessId required' });
    const debugMode = req.query.debug === '1' || req.query.debug === 'true';
    const client = await pool.connect();
    try {
      await withTenant(client, businessId);

      // Pull each QR code + its current active session (if any)
      const baseRows = await client.query(`
        SELECT q.qr_code_id, q.table_number, ds.session_id, ds.payment_status AS session_payment_status
          FROM QRCodes q
          LEFT JOIN DiningSessions ds ON ds.session_id = q.current_session_id
         WHERE q.business_id = $1
         ORDER BY (
           CASE WHEN q.table_number ~ '^\\d+$' THEN LPAD(q.table_number, 10, '0') ELSE q.table_number END
         ) ASC`, [businessId]);

      // Preload order aggregates for all session ids in one pass
      const sessionIds = baseRows.rows.filter(r => r.session_id).map(r => r.session_id);
      let ordersAgg = new Map();
      let orderStatusesBySession = new Map();
      if (sessionIds.length) {
        const { rows: aggRows } = await client.query(`
          SELECT o.dining_session_id AS session_id,
                 COUNT(*) AS orders_count,
                 COUNT(*) FILTER (WHERE COALESCE(o.payment_status,'unpaid') <> 'paid') AS unpaid_count,
                 COUNT(*) FILTER (WHERE COALESCE(o.payment_status,'unpaid') = 'paid') AS paid_count,
                 BOOL_AND(COALESCE(o.payment_status,'unpaid') = 'paid') AS all_paid
            FROM Orders o
           WHERE o.dining_session_id = ANY($1::bigint[])
           GROUP BY o.dining_session_id`, [sessionIds]);
        ordersAgg = new Map(aggRows.map(r => [r.session_id, r]));
        if (debugMode) {
          const { rows: statusRows } = await client.query(`
            SELECT o.dining_session_id AS session_id, o.payment_status
              FROM Orders o
             WHERE o.dining_session_id = ANY($1::bigint[])`, [sessionIds]);
          for (const r of statusRows) {
            if (!orderStatusesBySession.has(r.session_id)) orderStatusesBySession.set(r.session_id, []);
            orderStatusesBySession.get(r.session_id).push(r.payment_status || 'unpaid');
          }
        }
      }

      const tables = baseRows.rows.map(r => {
  const sess = ordersAgg.get(r.session_id) || { orders_count: 0, unpaid_count: 0, paid_count: 0, all_paid: false };
        const ordersCount = Number(sess.orders_count || 0);
        const unpaidExists = Number(sess.unpaid_count || 0) > 0;
  const paidCount = Number(sess.paid_count || 0);
        const allPaid = !!sess.all_paid;
        const sessionPayRaw = (r.session_payment_status || '').trim().toLowerCase();
        const sessionPaid = sessionPayRaw === 'paid';

        let color = 'ash';
        let colorReason = 'no-session';
        if (r.session_id) {
          // Active session present
          if (ordersCount === 0) {
            if (sessionPaid) { color = 'green'; colorReason = 'session-paid-no-orders'; }
            else { color = 'yellow'; colorReason = 'session-no-orders-yet'; }
          } else {
            if (unpaidExists) { color = 'yellow'; colorReason = 'unpaid-orders-exist'; }
            else if (allPaid || sessionPaid) { color = 'green'; colorReason = allPaid ? 'all-orders-paid' : 'modern-session-paid'; }
            else { color = 'yellow'; colorReason = 'orders-pending'; }
          }
        }
        return {
          table_number: r.table_number,
          session_id: r.session_id || null,
          orders_count: ordersCount,
          unpaid_count: Number(sess.unpaid_count || 0),
          paid_count: paidCount,
          unpaid_order_exists: unpaidExists,
          all_orders_paid: allPaid,
          modern_payment_status: r.session_payment_status || null,
          color,
          colorReason,
          ...(debugMode ? { order_statuses: orderStatusesBySession.get(r.session_id) || [] } : {})
        };
      });

      res.json({ businessId, count: tables.length, tables });
    } finally { client.release(); }
  } catch (err) {
    console.error('GET /api/orders/by-table error:', err);
    res.status(500).json({ error: 'Failed to aggregate by table' });
  }
});
