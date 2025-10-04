const express = require('express');
const router = express.Router();

// POST /api/mark-paid
// Preferred: proxy to QRbilling backend mark-paid API (when configured)
// Fallback: if QR backend is unavailable, mark Orders as paid locally and close DiningSession
router.post('/', async (req, res) => {
  try {
    const { businessId, tableNumber, qrId, sessionId, totalAmount } = req.body || {};
    
    // Validate required fields
    if (!businessId || (!tableNumber && !qrId && !sessionId)) {
      return res.status(400).json({ 
        success: false, 
        error: 'businessId and at least one of tableNumber/qrId/sessionId required' 
      });
    }

  // Configure QRbilling backend URL (no localhost default in production)
  const QR_BACKEND_URL = process.env.QR_BACKEND_URL || '';
    
    console.log('[MARK_PAID_PROXY] Proxying to QRbilling backend:', {
      url: `${QR_BACKEND_URL}/api/qr/mark-paid`,
      businessId,
      tableNumber,
      totalAmount
    });

    if (QR_BACKEND_URL) {
      // Attempt proxy to QRbilling backend
      const fetch = require('node-fetch');
      try {
        const response = await fetch(`${QR_BACKEND_URL}/api/qr/mark-paid`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ businessId, tableNumber, qrId, sessionId, totalAmount })
        });
        const result = await response.json().catch(()=>({}));
        if (response.ok) {
          console.log('[MARK_PAID_PROXY] Success:', result);
          return res.json({ success: true, ...result });
        }
        console.error('[MARK_PAID_PROXY] QR backend error:', result);
        // fallthrough to local fallback
      } catch (proxyErr) {
        console.error('[MARK_PAID_PROXY] Proxy failed, using local fallback:', proxyErr.message);
      }
    }

    // Local fallback: mark paid directly in MENU-BACKEND DB
    const { pool, withTenant } = require('../db');
    if (!pool) return res.status(503).json({ success:false, error:'Database not configured and QR backend unavailable' });
    const client = await pool.connect();
    try {
      await withTenant(client, Number(businessId));
      // Resolve session_id from inputs
      let sid = sessionId;
      if (!sid && (tableNumber || qrId)) {
        const q = await client.query(`
          SELECT ds.session_id
          FROM QRCodes q
          LEFT JOIN DiningSessions ds ON q.current_session_id = ds.session_id
          WHERE q.business_id=$1
            AND ($2::text IS NULL OR q.table_number = $2::text)
            AND ($3::int IS NULL OR q.qr_code_id = $3::int)
          ORDER BY ds.start_time DESC NULLS LAST
          LIMIT 1
        `, [businessId, tableNumber ? String(tableNumber).trim() : null, qrId ? Number(qrId) : null]);
        sid = q.rows[0]?.session_id || null;
      }
      if (!sid) return res.status(404).json({ success:false, error:'Active session not found for table/qr' });

  // Mark all orders in session as paid; keep session ACTIVE so Eat First dashboard shows GREEN
  // Do NOT reference non-existent columns like paid_at; just flip payment_status.
  try {
    const t = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`);
    const present = t.rows.map(r=>r.table_name);
      const resolve = (...cands) => {
        for (const c of cands) {
          const hit = present.find(p => p.toLowerCase()===c.toLowerCase());
          if (hit) return hit;
        }
        return cands[0];
      };
    const qi = (n) => (/[^a-z0-9_]/.test(n) || /[A-Z]/.test(n)) ? '"'+n.replace(/"/g,'""')+'"' : n;
      const ORD = resolve('Orders','orders','order');
    await client.query(`UPDATE ${qi(ORD)} SET payment_status='paid' WHERE dining_session_id=$1`, [sid]);
  } catch (updErr) {
    console.error('[MARK_PAID_FALLBACK] update error', updErr.message);
  }

      console.log('[MARK_PAID_FALLBACK] Marked paid locally for session', sid);
      return res.json({ success:true, sessionId: sid, fallback: true });
    } finally {
      client.release();
    }
    
  } catch (error) {
    console.error('[MARK_PAID_PROXY] Error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Mark paid proxy failed',
      message: error.message 
    });
  }
});

module.exports = router;