const express = require('express');
const router = express.Router();
const { pool, withTenant } = require('../db');

// Lightweight diagnostics for production debugging.
router.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// GET /api/diagnostics/order-pipeline?businessId=1
// Returns existence of core tables + ability to run trivial SELECTs
router.get('/order-pipeline', async (req, res) => {
  const debug = [];
  try {
    if (!pool) return res.json({ ok: false, error: 'no-pool' });
    const businessId = Number(req.query.businessId) || Number(process.env.DEFAULT_BUSINESS_ID) || null;
    const client = await pool.connect();
    try {
      if (businessId) await withTenant(client, businessId);
      const tbls = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`);
      const present = tbls.rows.map(r => r.table_name.toLowerCase());
      const need = ['qrcodes', 'diningsessions', 'orders', 'orderitems'];
      const resolved = {};
      for (const n of need) {
        resolved[n] = present.find(p => p === n || p === n.replace(/s$/, 's')) || null;
      }
      debug.push({ step: 'tables', resolved });
      const summary = {};
      for (const [k, v] of Object.entries(resolved)) summary[k] = !!v;
      let sampleCounts = {};
      for (const [k, v] of Object.entries(resolved)) {
        if (v) {
          try {
            const { rows } = await client.query(`SELECT count(*)::int AS c FROM ${v}`);
            sampleCounts[k] = rows[0].c;
          } catch (e) { sampleCounts[k] = 'err:' + e.code; }
        }
      }
      res.json({ ok: true, businessId, summary, sampleCounts, debug });
    } finally { client.release(); }
  } catch (e) {
    debug.push({ step: 'fatal', error: e.message });
    res.status(500).json({ ok: false, error: e.message, debug });
  }
});

// List all public tables
router.get('/tables', async (_req, res) => {
  try {
    if (!pool) return res.json({ ok:false, error:'no-pool' });
    const client = await pool.connect();
    try {
      const { rows } = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`);
      res.json({ ok:true, tables: rows.map(r=>r.table_name) });
    } finally { client.release(); }
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// Describe a table's columns
router.get('/table/:name', async (req,res) => {
  try {
    if (!pool) return res.json({ ok:false, error:'no-pool' });
    const name = req.params.name;
    const client = await pool.connect();
    try {
      const cols = await client.query(`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [name]);
      res.json({ ok:true, table:name, columns: cols.rows });
    } finally { client.release(); }
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// Trace last N orders with sessions & qrcodes linkage
router.get('/order-trace', async (req,res) => {
  const limit = Math.min( Number(req.query.limit)||10, 100);
  const businessId = Number(req.query.businessId) || Number(process.env.DEFAULT_BUSINESS_ID) || null;
  try {
    if (!pool) return res.json({ ok:false, error:'no-pool' });
    const client = await pool.connect();
    try {
      if (businessId) await withTenant(client, businessId);
      // Resolve table names and quote identifiers to handle any casing/underscores
      const t = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`);
      const present = t.rows.map(r=>r.table_name);
      const resolve = (cands) => cands.find(c => present.some(p=>p.toLowerCase()===c.toLowerCase())) || cands[0];
      const qi = (n) => (/[^a-z0-9_]/.test(n) || /[A-Z]/.test(n)) ? '"'+n.replace(/"/g,'""')+'"' : n;
      const ORD = resolve(['Orders','orders','order']);
      const DS = resolve(['DiningSessions','diningsessions','dining_sessions']);
      const QR = resolve(['QRCodes','qrcodes','qr_codes']);
      const sql = `SELECT o.order_id, o.dining_session_id, o.status, o.payment_status, o.placed_at,
                          ds.qr_code_id, q.table_number
                   FROM ${qi(ORD)} o
                   LEFT JOIN ${qi(DS)} ds ON ds.session_id = o.dining_session_id
                   LEFT JOIN ${qi(QR)} q ON q.qr_code_id = ds.qr_code_id
                   ${businessId? 'WHERE o.business_id = $1':''}
                   ORDER BY o.placed_at DESC LIMIT ${limit}`;
      const params = businessId? [businessId]:[];
      const { rows } = await client.query(sql, params);
      res.json({ ok:true, businessId, count: rows.length, orders: rows });
    } finally { client.release(); }
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// Show session_orders rows (legacy/modern bridge) if table exists
router.get('/session-orders', async (req,res) => {
  const businessId = Number(req.query.businessId) || Number(process.env.DEFAULT_BUSINESS_ID) || null;
  try {
    if (!pool) return res.json({ ok:false, error:'no-pool' });
    const client = await pool.connect();
    try {
      if (businessId) await withTenant(client, businessId);
      const exists = await client.query(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='session_orders' LIMIT 1`);
      if (!exists.rowCount) return res.json({ ok:false, error:'session_orders-missing' });
      // Filter by businessId only if the column exists
      let hasBizCol = false;
      try {
        const col = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='session_orders' AND column_name='business_id' LIMIT 1`);
        hasBizCol = !!col.rowCount;
      } catch(_){}
      const sql = `SELECT id, ${hasBizCol? 'business_id, ':''}session_id, order_status, payment_status, total_amount, created_at FROM session_orders ${businessId && hasBizCol? 'WHERE business_id=$1':''} ORDER BY id DESC LIMIT 50`;
      const params = businessId && hasBizCol? [businessId]:[];
      const { rows } = await client.query(sql, params).catch(e=>({ rows:[], error:e.message }));
      res.json({ ok:true, businessId, count: rows.length, rows });
    } finally { client.release(); }
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
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
      // Resolve table names
      const t = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`);
      const present = t.rows.map(r=>r.table_name);
      const resolve = (cands) => cands.find(c => present.some(p=>p.toLowerCase()===c.toLowerCase())) || cands[0];
      const qi = (n) => (/[^a-z0-9_]/.test(n) || /[A-Z]/.test(n)) ? '"'+n.replace(/"/g,'""')+'"' : n;
      const ORD = resolve(['Orders','orders','order']);
      const DS = resolve(['DiningSessions','diningsessions','dining_sessions']);
      const QR = resolve(['QRCodes','qrcodes','qr_codes']);

      const qr = await client.query(`SELECT qr_code_id, business_id, table_number, current_session_id FROM ${qi(QR)} ORDER BY qr_code_id ASC LIMIT 200`);
      qrCodes = qr.rows;
    } catch(e) { debug.push({ step:'qrcodes-error', error:e.message }); }
    let sessions = [];
    try {
      const t = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`);
      const present = t.rows.map(r=>r.table_name);
      const resolve = (cands) => cands.find(c => present.some(p=>p.toLowerCase()===c.toLowerCase())) || cands[0];
      const qi = (n) => (/[^a-z0-9_]/.test(n) || /[A-Z]/.test(n)) ? '"'+n.replace(/"/g,'""')+'"' : n;
      const DS = resolve(['DiningSessions','diningsessions','dining_sessions']);
      const ds = await client.query(`SELECT session_id, business_id, qr_code_id, status, created_at FROM ${qi(DS)} ORDER BY session_id DESC LIMIT 200`);
      sessions = ds.rows;
    } catch(e) { debug.push({ step:'sessions-error', error:e.message }); }
    let orders = [];
    try {
      const t = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`);
      const present = t.rows.map(r=>r.table_name);
      const resolve = (cands) => cands.find(c => present.some(p=>p.toLowerCase()===c.toLowerCase())) || cands[0];
      const qi = (n) => (/[^a-z0-9_]/.test(n) || /[A-Z]/.test(n)) ? '"'+n.replace(/"/g,'""')+'"' : n;
      const ORD = resolve(['Orders','orders','order']);
      const ord = await client.query(`SELECT order_id, dining_session_id, payment_status, status, created_at FROM ${qi(ORD)} ORDER BY order_id DESC LIMIT 200`);
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