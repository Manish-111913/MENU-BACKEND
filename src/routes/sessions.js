const express = require('express');
const router = express.Router();
const { pool, withTenant } = require('../db');

// Utility: normalize table number as string (preserve original label, but trim)
function normalizeTableNumber(raw) {
  if (raw === undefined || raw === null) return null;
  return String(raw).trim();
}

// POST /api/sessions/start
// body: { businessId, tableNumber }
// Creates (or reuses) an active dining session for a table.
router.post('/start', async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'Database not configured' });
    const { businessId, tableNumber } = req.body || {};
    if (!businessId || !tableNumber) {
      return res.status(400).json({ error: 'businessId and tableNumber required' });
    }
    const tableNum = normalizeTableNumber(tableNumber);
    const client = await pool.connect();
    try {
      await withTenant(client, Number(businessId));

      // 1. Ensure QR code row exists (idempotent)
      const qr = await client.query(
        `INSERT INTO QRCodes (business_id, table_number)
         VALUES ($1,$2)
         ON CONFLICT (business_id, table_number) DO UPDATE SET table_number = EXCLUDED.table_number
         RETURNING qr_code_id, current_session_id`,
        [businessId, tableNum]
      );
      const qrCodeId = qr.rows[0].qr_code_id;
      let currentSessionId = qr.rows[0].current_session_id;

      // 2. If there is an existing active session linked, verify it is still active
      if (currentSessionId) {
        const existing = await client.query(
          `SELECT session_id, status, start_time FROM DiningSessions WHERE session_id=$1`,
          [currentSessionId]
        );
        if (existing.rows[0] && existing.rows[0].status === 'active') {
          return res.json({ reused: true, sessionId: existing.rows[0].session_id, tableNumber: tableNum, qrCodeId });
        }
      }

      // 3. Check if another active session exists for this table (paranoia guard)
      const activeExisting = await client.query(
        `SELECT ds.session_id
           FROM DiningSessions ds
          WHERE ds.business_id=$1 AND ds.qr_code_id=$2 AND ds.status='active'
          ORDER BY ds.start_time DESC LIMIT 1`,
        [businessId, qrCodeId]
      );
      if (activeExisting.rows[0]) {
        // Link QR code if not already
        if (!currentSessionId || currentSessionId !== activeExisting.rows[0].session_id) {
          await client.query(`UPDATE QRCodes SET current_session_id=$1 WHERE qr_code_id=$2`, [activeExisting.rows[0].session_id, qrCodeId]);
        }
        return res.json({ reused: true, sessionId: activeExisting.rows[0].session_id, tableNumber: tableNum, qrCodeId });
      }

      // 4. Create new dining session
      const ds = await client.query(
        `INSERT INTO DiningSessions (business_id, qr_code_id, status)
         VALUES ($1,$2,'active') RETURNING session_id, start_time`,
        [businessId, qrCodeId]
      );
      const sessionId = ds.rows[0].session_id;
      await client.query(`UPDATE QRCodes SET current_session_id=$1 WHERE qr_code_id=$2`, [sessionId, qrCodeId]);

      res.json({ created: true, sessionId, tableNumber: tableNum, qrCodeId });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('POST /api/sessions/start error:', err);
    res.status(500).json({ error: 'Failed to start session' });
  }
});

// POST /api/sessions/close
// body: { businessId, sessionId, tableNumber? }
// Marks session completed and clears QR code pointer.
router.post('/close', async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'Database not configured' });
    const { businessId, sessionId, tableNumber } = req.body || {};
    if (!businessId || !sessionId) {
      return res.status(400).json({ error: 'businessId and sessionId required' });
    }
    const client = await pool.connect();
    try {
      await withTenant(client, Number(businessId));
      await client.query(`UPDATE DiningSessions SET status='completed', end_time=NOW() WHERE session_id=$1 AND business_id=$2`, [sessionId, businessId]);
      if (tableNumber) {
        await client.query(`UPDATE QRCodes SET current_session_id=NULL WHERE business_id=$1 AND table_number=$2 AND current_session_id=$3`, [businessId, normalizeTableNumber(tableNumber), sessionId]);
      } else {
        // fallback: clear any QR referencing this session
        await client.query(`UPDATE QRCodes SET current_session_id=NULL WHERE current_session_id=$1`, [sessionId]);
      }
      res.json({ closed: true, sessionId });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('POST /api/sessions/close error:', err);
    res.status(500).json({ error: 'Failed to close session' });
  }
});

// GET /api/sessions/overview?businessId=
// Returns table tiles with state classification for dashboard color coding.
// GET /api/sessions/overview?businessId=..&mode=pay_first|eat_later
// Color Logic:
//  pay_first:
//    ash: no active session OR (unexpected unpaid state before payment)
//    yellow: session active, all orders paid, NO dish ready yet (no order READY/COMPLETED and no item COMPLETED)
//    green: first dish READY (order.status READY/COMPLETED) OR any order item COMPLETED
//  eat_later:
//    ash: no active session
//    yellow: active session with any unpaid orders
//    green: active session with all orders paid
router.get('/overview', async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'Database not configured' });
    const businessId = Number(req.query.businessId) || Number(process.env.DEFAULT_BUSINESS_ID) || null;
    const mode = (req.query.mode || 'eat_later').toLowerCase();
    if (!businessId) return res.status(400).json({ error: 'businessId required' });
    const client = await pool.connect();
    try {
      await withTenant(client, businessId);
      // Resolve table names dynamically and quote as needed
      const t = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`);
      const present = t.rows.map(r=>r.table_name);
      const resolve = (...cands) => cands.find(c => present.some(p=>p.toLowerCase()===c.toLowerCase())) || cands[0];
      const qi = (n) => (/[^a-z0-9_]/.test(n) || /[A-Z]/.test(n)) ? '"'+n.replace(/"/g,'""')+'"' : n;
      const ORD = resolve('Orders','orders','order');
      const ORDI = resolve('OrderItems','orderitems','order_items');
      const DS = resolve('DiningSessions','diningsessions','dining_sessions');
      const QR = resolve('QRCodes','qrcodes','qr_codes');

      const { rows } = await client.query(`
        SELECT
          q.qr_code_id,
          q.table_number,
          q.current_session_id AS session_id,
          ds.status AS session_status,
          COALESCE( (
            SELECT COUNT(*) FROM ${qi(ORD)} o WHERE o.dining_session_id = ds.session_id
          ), 0) AS orders_count,
          EXISTS (
            SELECT 1 FROM ${qi(ORD)} o WHERE o.dining_session_id = ds.session_id AND o.payment_status <> 'paid'
          ) AS unpaid_exists,
          EXISTS (
            SELECT 1 FROM ${qi(ORD)} o WHERE o.dining_session_id = ds.session_id AND o.status IN ('READY','COMPLETED')
          ) AS any_ready_order,
          EXISTS (
            SELECT 1 FROM ${qi(ORDI)} oi
            JOIN ${qi(ORD)} o2 ON oi.order_id = o2.order_id
            WHERE o2.dining_session_id = ds.session_id AND oi.item_status = 'COMPLETED'
          ) AS any_item_completed,
          EXISTS (
            SELECT 1 FROM ${qi(ORD)} o WHERE o.dining_session_id = ds.session_id AND o.payment_status = 'paid'
          ) AS any_paid_order,
          (
            SELECT MIN(ts) FROM (
              SELECT MIN(COALESCE(o.actual_ready_time, o.estimated_ready_time, o.placed_at)) AS ts
              FROM ${qi(ORD)} o
              WHERE o.dining_session_id = ds.session_id AND o.status IN ('READY','COMPLETED')
              UNION ALL
              SELECT MIN(oi.updated_at) AS ts
              FROM ${qi(ORDI)} oi
              JOIN ${qi(ORD)} o2 ON oi.order_id = o2.order_id
              WHERE o2.dining_session_id = ds.session_id AND oi.item_status = 'COMPLETED'
            ) AS t
          ) AS first_ready_at,
          NOT EXISTS (
            SELECT 1 FROM ${qi(ORD)} o WHERE o.dining_session_id = ds.session_id AND o.payment_status <> 'paid'
          ) AS all_paid
        FROM ${qi(QR)} q
        LEFT JOIN ${qi(DS)} ds ON q.current_session_id = ds.session_id
        WHERE q.business_id = $1
        ORDER BY (
          CASE WHEN q.table_number ~ '^\\d+$' THEN q.table_number::int ELSE NULL END
        ) NULLS LAST, q.table_number ASC;
      `, [businessId]);

      const tables = rows.map(r => {
        let color = 'ash';
        let reason = 'no active session';
        const hasActive = r.session_id && r.session_status === 'active';
        const anyReadyDish = r.any_ready_order || r.any_item_completed; // fallback if order.status not updated
        if (mode === 'pay_first') {
          if (hasActive) {
            if (anyReadyDish) { color = 'green'; reason = 'customer eating (first dish ready)'; }
            else if (r.any_paid_order) { color = 'yellow'; reason = 'occupied & paid; preparing food'; }
            else { color = 'ash'; reason = 'no payment yet'; }
          }
        } else { // eat_later
          if (hasActive) {
            // Yellow from session start until payment completes
            if (r.all_paid && r.orders_count > 0) { color = 'green'; reason = 'payment completed'; }
            else { color = 'yellow'; reason = r.orders_count > 0 ? 'ordering/eating in progress' : 'session active'; }
          }
        }
        return {
          qr_code_id: r.qr_code_id,
          table_number: r.table_number,
          session_id: r.session_id,
          session_status: r.session_status,
          orders_count: Number(r.orders_count),
          unpaid_exists: r.unpaid_exists,
          any_ready_order: r.any_ready_order,
          any_item_completed: r.any_item_completed,
          all_paid: r.all_paid,
          any_paid_order: r.any_paid_order,
          first_ready_at: r.first_ready_at,
          mode_applied: mode,
          color,
          reason
        };
      });
      res.json({ tables, mode });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('GET /api/sessions/overview error:', err);
    res.status(500).json({ error: 'Failed to load sessions overview' });
  }
});

// GET /api/sessions/table?businessId=&tableNumber=
// Returns detailed linkage + recent orders for troubleshooting a single table
router.get('/table', async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'Database not configured' });
    const businessId = Number(req.query.businessId) || Number(process.env.DEFAULT_BUSINESS_ID) || null;
    const tableNumber = req.query.tableNumber ? String(req.query.tableNumber).trim() : null;
    if (!businessId || !tableNumber) return res.status(400).json({ error: 'businessId and tableNumber required' });
    const client = await pool.connect();
    try {
      await withTenant(client, businessId);
      const qr = await client.query(`
        SELECT q.qr_code_id, q.table_number, q.current_session_id, ds.status AS session_status, ds.start_time, ds.end_time
        FROM QRCodes q
        LEFT JOIN DiningSessions ds ON q.current_session_id = ds.session_id
        WHERE q.business_id=$1 AND q.table_number=$2
        LIMIT 1`, [businessId, tableNumber]);
      if (!qr.rowCount) return res.json({ exists:false, message:'No QR code row yet for this table.' });
      const row = qr.rows[0];
      let orders = [];
      if (row.current_session_id) {
        const ord = await client.query(`
          SELECT order_id, status, payment_status, placed_at, estimated_ready_time
          FROM Orders
          WHERE dining_session_id=$1
          ORDER BY placed_at DESC LIMIT 25`, [row.current_session_id]);
        orders = ord.rows;
      }
      res.json({ exists:true, table: row.table_number, qrCodeId: row.qr_code_id, sessionId: row.current_session_id, sessionStatus: row.session_status, startTime: row.start_time, endTime: row.end_time, orders });
    } finally { client.release(); }
  } catch (err) {
    console.error('GET /api/sessions/table error:', err);
    res.status(500).json({ error: 'Failed to inspect table' });
  }
});

module.exports = router;
