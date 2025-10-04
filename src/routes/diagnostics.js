const express = require('express');
const router = express.Router();
const { pool, withTenant } = require('../db');

// Helper: resolve actual table names and quote identifiers safely
async function resolveTables(client) {
  const t = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`);
  const present = t.rows.map(r => r.table_name);
  const resolve = (...cands) => {
    for (const c of cands) {
      const hit = present.find(p => p.toLowerCase() === c.toLowerCase());
      if (hit) return hit;
    }
    return cands[0];
  };
  const qi = (n) => (/[^a-z0-9_]/.test(n) || /[A-Z]/.test(n)) ? '"' + n.replace(/"/g, '""') + '"' : n;
  return { present, resolve, qi };
}

// Health
router.get('/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// DB snapshot
router.get('/db', async (_req, res) => {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const allowMock = String(process.env.ALLOW_DB_MOCK || '').toLowerCase() === 'true';
  const dbUrl = process.env.DATABASE_URL || process.env.RUNTIME_DATABASE_URL || '';
  const redacted = dbUrl ? dbUrl.replace(/:(?:[^:@/]+)@/, ':***@') : null;
  let serverVersion = null;
  try {
    if (pool) {
      const client = await pool.connect();
      try {
        const v = await client.query('SHOW server_version');
        serverVersion = v.rows?.[0]?.server_version || null;
      } finally { client.release(); }
    }
  } catch(_){ /* ignore */ }
  res.json({ ok:true, hasPool: !!pool, databaseUrlPresent: !!dbUrl, connection: redacted, nodeEnv, allowMock, serverVersion });
});

// Pipeline snapshot
router.get('/order-pipeline', async (req, res) => {
  const debug = [];
  try {
    if (!pool) return res.json({ ok:false, error:'no-pool' });
    const businessId = Number(req.query.businessId) || Number(process.env.DEFAULT_BUSINESS_ID) || null;
    const client = await pool.connect();
    try {
      if (businessId) await withTenant(client, businessId);
      const { present } = await resolveTables(client);
      const need = ['qrcodes','diningsessions','orders','orderitems'];
      const resolved = Object.fromEntries(need.map(n => [n, present.find(p => p.toLowerCase()===n) || null]));
      debug.push({ step:'tables', resolved });
      const summary = {}; for (const [k,v] of Object.entries(resolved)) summary[k] = !!v;
      const sampleCounts = {};
      for (const [k,v] of Object.entries(resolved)) {
        if (v) {
          try { const { rows } = await client.query(`SELECT count(*)::int AS c FROM ${v}`); sampleCounts[k] = rows[0].c; }
          catch(e){ sampleCounts[k] = 'err:'+e.code; }
        }
      }
      res.json({ ok:true, businessId, summary, sampleCounts, debug });
    } finally { client.release(); }
  } catch (e) { res.status(500).json({ ok:false, error:e.message, debug }); }
});

// List tables
router.get('/tables', async (_req, res) => {
  try {
    if (!pool) return res.json({ ok:false, error:'no-pool' });
    const client = await pool.connect();
    try { const { rows } = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`); res.json({ ok:true, tables: rows.map(r=>r.table_name) }); }
    finally { client.release(); }
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// Describe table
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

// Recent orders with linkage
router.get('/order-trace', async (req,res) => {
  const limit = Math.min(Number(req.query.limit)||10, 100);
  const businessId = Number(req.query.businessId) || Number(process.env.DEFAULT_BUSINESS_ID) || null;
  try {
    if (!pool) return res.json({ ok:false, error:'no-pool' });
    const client = await pool.connect();
    try {
      if (businessId) await withTenant(client, businessId);
      const { resolve, qi } = await resolveTables(client);
      const ORD = resolve('Orders','orders','order');
      const DS = resolve('DiningSessions','diningsessions','dining_sessions');
      const QR = resolve('QRCodes','qrcodes','qr_codes');
      const sql = `SELECT o.order_id, o.dining_session_id, o.status, o.payment_status,
                          COALESCE(o.placed_at, o.created_at) AS ts,
                          ds.qr_code_id, q.table_number
                   FROM ${qi(ORD)} o
                   LEFT JOIN ${qi(DS)} ds ON ds.session_id = o.dining_session_id
                   LEFT JOIN ${qi(QR)} q ON q.qr_code_id = ds.qr_code_id
                   ${businessId? 'WHERE o.business_id = $1':''}
                   ORDER BY COALESCE(o.placed_at, o.created_at) DESC NULLS LAST, o.order_id DESC
                   LIMIT ${limit}`;
      const params = businessId? [businessId]:[];
      const { rows } = await client.query(sql, params);
      res.json({ ok:true, businessId, count: rows.length, orders: rows, resolvedTables: { orders: ORD, diningsessions: DS, qrcodes: QR } });
    } finally { client.release(); }
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// session_orders rows if present
router.get('/session-orders', async (req,res) => {
  const businessId = Number(req.query.businessId) || Number(process.env.DEFAULT_BUSINESS_ID) || null;
  try {
    if (!pool) return res.json({ ok:false, error:'no-pool' });
    const client = await pool.connect();
    try {
      if (businessId) await withTenant(client, businessId);
      const exists = await client.query(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='session_orders' LIMIT 1`);
      if (!exists.rowCount) return res.json({ ok:false, error:'session_orders-missing' });
      let hasBizCol = false;
      try { const col = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='session_orders' AND column_name='business_id' LIMIT 1`); hasBizCol = !!col.rowCount; } catch(_){ }
      const sql = `SELECT id, ${hasBizCol? 'business_id, ':''}session_id, order_status, payment_status, total_amount, created_at FROM session_orders ${businessId && hasBizCol? 'WHERE business_id=$1':''} ORDER BY id DESC LIMIT 50`;
      const params = businessId && hasBizCol? [businessId]:[];
      const { rows } = await client.query(sql, params).catch(e=>({ rows:[], error:e.message }));
      res.json({ ok:true, businessId, count: rows.length, rows });
    } finally { client.release(); }
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// Table-state snapshot
router.get('/table-state', async (req, res) => {
  const businessId = Number(req.query.businessId || req.query.bid || req.query.b) || null;
  const debug = [];
  if (!pool) return res.json({ error: 'no-pool', debug });
  const client = await pool.connect();
  try {
    if (businessId) { await withTenant(client, businessId); debug.push({ step:'tenant-set', businessId }); }
    const { resolve, qi } = await resolveTables(client);
    const ORD = resolve('Orders','orders','order');
    const DS = resolve('DiningSessions','diningsessions','dining_sessions');
    const QR = resolve('QRCodes','qrcodes','qr_codes');

    const qr = await client.query(`SELECT qr_code_id, business_id, table_number, current_session_id FROM ${qi(QR)} ORDER BY qr_code_id ASC LIMIT 200`);
    const qrCodes = qr.rows;

    const ds = await client.query(`SELECT session_id, business_id, qr_code_id, status, created_at FROM ${qi(DS)} ORDER BY session_id DESC LIMIT 200`);
    const sessions = ds.rows;

    const ord = await client.query(`SELECT order_id, dining_session_id, payment_status, status, created_at FROM ${qi(ORD)} ORDER BY order_id DESC LIMIT 200`);
    const orders = ord.rows;

    const tableColors = {};
    for (const q of qrCodes) { const tnum = q.table_number || 'GEN'; tableColors[tnum] = 'ash'; }
    for (const o of orders) {
      const dsRow = sessions.find(s => s.session_id === o.dining_session_id);
      if (!dsRow) continue;
      const qRow = qrCodes.find(q => q.qr_code_id === dsRow.qr_code_id);
      const tableNum = qRow?.table_number || 'GEN';
      if (!tableColors[tableNum]) tableColors[tableNum] = 'ash';
      if (o.payment_status === 'paid') tableColors[tableNum] = 'green';
      else if (tableColors[tableNum] !== 'green') tableColors[tableNum] = 'yellow';
    }
    res.json({ ok:true, tableColors, counts:{ qrCodes: qrCodes.length, sessions: sessions.length, orders: orders.length }, debug });
  } catch(err) {
    debug.push({ step:'fatal', error: err.message });
    res.status(500).json({ error:'diagnostics-failed', debug });
  } finally { client.release(); }
});

// Config echo
router.get('/config', (_req,res) => {
  res.json({ frontendOrigin: process.env.FRONTEND_ORIGIN, nodeEnv: process.env.NODE_ENV, additionalOrigins: process.env.ADDITIONAL_ORIGINS });
});

// Quick table-name resolution echo
router.get('/resolve-names', async (_req,res) => {
  try {
    if (!pool) return res.json({ ok:false, error:'no-pool' });
    const client = await pool.connect();
    try {
      const { present, resolve } = await resolveTables(client);
      const ORD = resolve('Orders','orders','order');
      const ORDI = resolve('OrderItems','orderitems','order_items');
      const DS = resolve('DiningSessions','diningsessions','dining_sessions');
      const QR = resolve('QRCodes','qrcodes','qr_codes');
      res.json({ ok:true, present, resolved: { orders: ORD, orderitems: ORDI, diningsessions: DS, qrcodes: QR } });
    } finally { client.release(); }
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

module.exports = router;