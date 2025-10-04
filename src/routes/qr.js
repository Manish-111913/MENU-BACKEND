const express = require('express');
const { pool, withTenant } = require('../db');
const router = express.Router();

const os = require('os');
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:3300';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || null; // e.g. https://menu.example.com or http://192.168.0.42:5500

function buildFrontendRedirect({ tableNumber, sessionId, qrCodeId, businessId }) {
  // Basic query params so frontend can hydrate state; adjust if frontend expects different names
  const params = new URLSearchParams();
  if (tableNumber) params.set('table', tableNumber);
  if (sessionId) params.set('sessionId', sessionId);
  if (qrCodeId) params.set('qr', qrCodeId);
  if (businessId) params.set('businessId', businessId);
  return `${FRONTEND_ORIGIN}/?${params.toString()}`;
}

async function ensureActiveSession(client, businessId, qrRow) {
  const { qr_code_id: qrCodeId, current_session_id } = qrRow;
  if (current_session_id) {
    const existing = await client.query(
      `SELECT session_id, status FROM DiningSessions WHERE session_id=$1`,
      [current_session_id]
    );
    if (existing.rows[0] && existing.rows[0].status === 'active') {
      return { reused: true, sessionId: existing.rows[0].session_id, qrCodeId };
    }
  }
  // Create a new active session
  const ds = await client.query(
    `INSERT INTO DiningSessions (business_id, qr_code_id, status) VALUES ($1,$2,'active') RETURNING session_id`,
    [businessId, qrCodeId]
  );
  const sessionId = ds.rows[0].session_id;
  await client.query(`UPDATE QRCodes SET current_session_id=$1 WHERE qr_code_id=$2`, [sessionId, qrCodeId]);
  return { created: true, sessionId, qrCodeId };
}

// GET /api/qr/scan-urls?businessId=
// Diagnostic helper: list all QR codes with canonical backend scan URLs.
router.get('/scan-urls', async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'Database not configured' });
    const businessId = Number(req.query.businessId) || Number(process.env.DEFAULT_BUSINESS_ID) || null;
    if (!businessId) return res.status(400).json({ error: 'businessId required' });
    const hostOverride = (req.query.hostOverride||'').trim();
    const hostHeader = req.headers.host || `localhost:${process.env.PORT || 5500}`;
    let base;
    if (hostOverride) {
      base = hostOverride.startsWith('http') ? hostOverride : `${req.protocol}://${hostOverride}`;
    } else if (PUBLIC_BASE_URL) {
      base = PUBLIC_BASE_URL.replace(/\/$/, '');
    } else {
      base = `${req.protocol}://${hostHeader}`;
    }
    const client = await pool.connect();
    try {
      await withTenant(client, businessId);
      const { rows } = await client.query(
        `SELECT qr_code_id, table_number, current_session_id FROM QRCodes WHERE business_id=$1 ORDER BY table_number ASC`,
        [businessId]
      );
      const list = rows.map(r => ({
        qr_code_id: r.qr_code_id,
        table_number: r.table_number,
        current_session_id: r.current_session_id,
        scan_url: `${base}/qr/${r.qr_code_id}?businessId=${businessId}`
      }));
      // Include LAN IP suggestions to help user ensure correct host selection
      const nets = os.networkInterfaces();
      const lanIps = [];
      for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
          if (net.family === 'IPv4' && !net.internal) lanIps.push(net.address);
        }
      }
      res.json({ businessId, count: list.length, baseUsed: base, publicBaseConfigured: !!PUBLIC_BASE_URL, lanIps, qrs: list });
    } finally { client.release(); }
  } catch (err) {
    console.error('GET /api/qr/scan-urls error:', err);
    res.status(500).json({ error: 'Failed to list scan URLs' });
  }
});

// POST /api/qr/ensure-session { businessId, qrCodeId | tableNumber }
// Programmatic variant of a scan that guarantees an active session (no redirect).
router.post('/ensure-session', async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'Database not configured' });
    const { businessId: rawBiz, qrCodeId, tableNumber } = req.body || {};
    const businessId = Number(rawBiz) || Number(process.env.DEFAULT_BUSINESS_ID) || null;
    if (!businessId) return res.status(400).json({ error: 'businessId required' });
    if (!qrCodeId && !tableNumber) return res.status(400).json({ error: 'qrCodeId or tableNumber required' });
    const client = await pool.connect();
    try {
      await withTenant(client, businessId);
      let qrRow;
      if (qrCodeId) {
        const qr = await client.query(`SELECT qr_code_id, table_number, current_session_id FROM QRCodes WHERE qr_code_id=$1 AND business_id=$2`, [qrCodeId, businessId]);
        if (!qr.rowCount) return res.status(404).json({ error: 'QR code not found' });
        qrRow = qr.rows[0];
      } else {
        // upsert by table number
        const qr = await client.query(
          `INSERT INTO QRCodes (business_id, table_number) VALUES ($1,$2)
           ON CONFLICT (business_id, table_number) DO UPDATE SET table_number=EXCLUDED.table_number
           RETURNING qr_code_id, table_number, current_session_id`,
          [businessId, String(tableNumber).trim()]
        );
        qrRow = qr.rows[0];
      }
      const result = await ensureActiveSession(client, businessId, qrRow);
      // Try optional last_scan_at update if column exists
      try {
        await client.query('UPDATE QRCodes SET last_scan_at=NOW() WHERE qr_code_id=$1', [qrRow.qr_code_id]);
      } catch (_) { /* column may not exist */ }
      res.json({ ...result, tableNumber: qrRow.table_number, businessId });
    } finally { client.release(); }
  } catch (err) {
    console.error('POST /api/qr/ensure-session error:', err);
    res.status(500).json({ error: 'Failed to ensure session' });
  }
});

// Attach top-level scan route (backend-first QR target)
function attachScanRoute(app) {
  app.get('/qr/:qrId', async (req, res) => {
    try {
      if (!pool) return res.status(500).send('DB unavailable');
      let businessId = Number(req.query.businessId) || Number(process.env.DEFAULT_BUSINESS_ID) || null;
      const qrId = Number(req.params.qrId);
      if (!qrId) return res.status(400).send('Invalid qrId');
      // If businessId not supplied, infer it from the QR code row so scan works out of the box
      if (!businessId) {
        try {
          const tmp = await pool.query('SELECT business_id FROM QRCodes WHERE qr_code_id=$1 LIMIT 1', [qrId]);
          const inferred = tmp.rows[0]?.business_id ? Number(tmp.rows[0].business_id) : null;
          if (inferred) businessId = inferred;
        } catch(_){}
      }
      if (!businessId) return res.status(400).send('businessId required');
  const startTs = Date.now();
      console.log(`[QR-SCAN] incoming qrId=${qrId} businessId=${businessId} ip=${req.ip} ua="${(req.get('user-agent')||'').slice(0,120)}"`);
      const client = await pool.connect();
      try {
        await withTenant(client, businessId);
        const qr = await client.query(
          `SELECT qr_code_id, table_number, current_session_id FROM QRCodes WHERE qr_code_id=$1 AND business_id=$2`,
          [qrId, businessId]
        );
        if (!qr.rowCount) return res.status(404).send('QR not found');
        const qrRow = qr.rows[0];
        const sessionInfo = await ensureActiveSession(client, businessId, qrRow);
        // Opportunistic last_scan_at
        try { await client.query('UPDATE QRCodes SET last_scan_at=NOW() WHERE qr_code_id=$1', [qrRow.qr_code_id]); } catch (_) {}

        // Pull metrics for this session to log predicted colors for both modes
        let metrics = null;
        try {
          const m = await client.query(`
            SELECT
              ds.session_id,
              ds.status AS session_status,
              COALESCE((SELECT COUNT(*) FROM Orders o WHERE o.dining_session_id = ds.session_id),0) AS orders_count,
              EXISTS (SELECT 1 FROM Orders o WHERE o.dining_session_id = ds.session_id AND o.payment_status <> 'paid') AS unpaid_exists,
              EXISTS (SELECT 1 FROM Orders o WHERE o.dining_session_id = ds.session_id AND o.status IN ('READY','COMPLETED')) AS any_ready_order,
              EXISTS (
                SELECT 1 FROM OrderItems oi JOIN Orders o2 ON oi.order_id = o2.order_id
                WHERE o2.dining_session_id = ds.session_id AND oi.item_status = 'COMPLETED'
              ) AS any_item_completed,
              NOT EXISTS (SELECT 1 FROM Orders o WHERE o.dining_session_id = ds.session_id AND o.payment_status <> 'paid') AS all_paid
            FROM DiningSessions ds
            WHERE ds.session_id=$1
            LIMIT 1`, [sessionInfo.sessionId]);
          metrics = m.rows[0];
        } catch (e) {
          console.warn('[QR-SCAN] metrics query failed', e.message);
        }

        function predictColors(m) {
          if (!m) return { eat_later: { color: 'unknown', reason: 'metrics unavailable' }, pay_first: { color: 'unknown', reason: 'metrics unavailable' } };
          const hasActive = m.session_status === 'active';
          const anyReadyDish = m.any_ready_order || m.any_item_completed;
          // eat_later
          let elColor='ash', elReason='no active session';
          if (hasActive) {
            if (m.unpaid_exists) { elColor='yellow'; elReason='unpaid orders exist'; }
            else if (Number(m.orders_count)>0 && m.all_paid) { elColor='green'; elReason='all orders paid'; }
            else { elColor='ash'; elReason='active session, no orders yet'; }
          }
          // pay_first
          let pfColor='ash', pfReason='no active session';
          if (hasActive) {
            if (anyReadyDish) { pfColor='green'; pfReason='first dish ready'; }
            else if (m.all_paid && Number(m.orders_count)>0) { pfColor='yellow'; pfReason='all orders paid waiting first dish'; }
            else { pfColor='ash'; pfReason='no paid order yet or none ready'; }
          }
          return { eat_later: { color: elColor, reason: elReason }, pay_first: { color: pfColor, reason: pfReason } };
        }

        const predictions = predictColors(metrics);
        console.log('[QR-SCAN][DIAG]', JSON.stringify({
          businessId,
          qrId,
          table: qrRow.table_number,
          sessionId: sessionInfo.sessionId,
          metrics,
          predictions,
          ms: Date.now()-startTs
        }));

        const redirectUrl = buildFrontendRedirect({
          tableNumber: qrRow.table_number,
          sessionId: sessionInfo.sessionId,
            qrCodeId: qrRow.qr_code_id,
            businessId
        });

        // Support JSON mode for programmatic tests
        if (req.query.json === '1' || (req.get('accept') || '').includes('application/json')) {
          return res.json({ ...sessionInfo, tableNumber: qrRow.table_number, redirect: redirectUrl });
        }
        res.redirect(302, redirectUrl);
      } finally { client.release(); }
    } catch (err) {
      console.error('[QR-SCAN] error:', err);
      res.status(500).send('Scan failed');
    }
  });
}

module.exports = { router, attachScanRoute };

// (Re)Add bulk generation endpoint cleanly outside of attachScanRoute
router.post('/bulk-generate', async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'Database not configured' });
    const { businessId: rawBiz, tables, includePng = true } = req.body || {};
    const businessId = Number(rawBiz) || Number(process.env.DEFAULT_BUSINESS_ID) || null;
    if (!businessId) return res.status(400).json({ error: 'businessId required' });
    if (!Array.isArray(tables) || !tables.length) return res.status(400).json({ error: 'tables array required' });
    const hostHeader = req.headers.host || `localhost:${process.env.PORT || 5500}`;
    const base = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${hostHeader}`).replace(/\/$/, '');
    const client = await pool.connect();
    try {
      await withTenant(client, businessId);
      const results = [];
      for (const t of tables) {
        const tableNumber = String(t).trim();
        if (!tableNumber) continue;
        const qr = await client.query(
          `INSERT INTO QRCodes (business_id, table_number) VALUES ($1,$2)
           ON CONFLICT (business_id, table_number) DO UPDATE SET table_number=EXCLUDED.table_number
           RETURNING qr_code_id, table_number, current_session_id`,
          [businessId, tableNumber]
        );
        const row = qr.rows[0];
        const scanUrl = `${base}/qr/${row.qr_code_id}?businessId=${businessId}`;
        let pngData = null;
        if (includePng) {
          try { pngData = await require('qrcode').toDataURL(scanUrl, { margin: 1, scale: 6 }); } catch (e) { pngData = null; }
        }
        results.push({
          table_number: row.table_number,
          qr_code_id: row.qr_code_id,
          scan_url: scanUrl,
          png: pngData
        });
      }
      res.json({ businessId, count: results.length, base, qrs: results });
    } finally { client.release(); }
  } catch (err) {
    console.error('POST /api/qr/bulk-generate error:', err);
    res.status(500).json({ error: 'Failed to bulk generate' });
  }
});
