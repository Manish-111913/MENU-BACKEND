const express = require('express');
const router = express.Router();
const { pool, withTenant } = require('../db');

// POST /api/checkout
// body: { businessId?, diningSessionId?, tableNumber?, customerPrepTimeMinutes?, payFirst?, items: [{menuItemId, name, quantity, price}] }
// Enhancements:
//  - Reuse provided active diningSessionId if valid
//  - If tableNumber provided (and no session), ensure QR + session creation linked to that table
//  - If payFirst flag passed, immediately mark order payment_status='paid'
router.post('/', async (req, res) => {
  const debug = [];
  const start = Date.now();
  const { businessId, diningSessionId, tableNumber, customerPrepTimeMinutes = 15, payFirst = false, payNow = false, items = [] } = req.body || {};
  const effectivePayFirst = !!(payFirst || payNow); // accept both flags
  debug.push({ step:'version', value:'checkout-v2-dynamic' });
  try {
    if (!pool) {
      return res.json({ success: true, orderId: 'mock-1', sessionId: 'mock-session', paymentStatus: effectivePayFirst ? 'paid':'unpaid', amount: items.reduce((s,i)=>s + (i.price||0)*(i.quantity||0),0), debug:['mock-env'] });
    }
    const client = await pool.connect();
    try {
      const tenantId = Number(businessId) || Number(process.env.DEFAULT_BUSINESS_ID) || null;
      if (!tenantId) return res.status(400).json({ error:'businessId required' });
      debug.push({ step:'tenant', tenantId });
      await withTenant(client, tenantId);

      // Preflight: verify required tables exist (helps explain 500s if migrations missing)
      try {
        const tbls = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
        const present = tbls.rows.map(r=>r.table_name);
        debug.push({ step:'tables-present', found: present });
        // resolve actual table names regardless of casing or underscores
        function resolveTable(candidates) {
          for (const c of candidates) {
            const hit = present.find(p => p.toLowerCase() === c.toLowerCase());
            if (hit) return hit;
          }
          return null;
        }
        const resolved = {
          qrcodes: resolveTable(['QRCodes','qrcodes','qr_codes']),
          diningsessions: resolveTable(['DiningSessions','diningsessions','dining_sessions']),
          orders: resolveTable(['Orders','orders']),
          orderitems: resolveTable(['OrderItems','orderitems','order_items'])
        };
        debug.push({ step:'resolved-tables', resolved });
        if (!resolved.qrcodes || !resolved.diningsessions || !resolved.orders) {
          debug.push({ step:'missing-core-table', missing: Object.entries(resolved).filter(([k,v])=>!v).map(([k])=>k) });
        }
        const qi = n => (/[^a-z0-9_]/.test(n) || /[A-Z]/.test(n)) ? '"'+n.replace(/"/g,'""')+'"' : n;
        client._resolvedTables = { raw: resolved, qi };
      } catch (tErr) { debug.push({ step:'table-enumeration-error', error: tErr.message }); }

      // Ensure dining session
      let sessionId = diningSessionId || null;
      if (sessionId) {
        try {
          const dsName = client._resolvedTables?.raw?.diningsessions || 'DiningSessions';
          const existing = await client.query(`SELECT session_id FROM ${client._resolvedTables? client._resolvedTables.qi(dsName):'DiningSessions'} WHERE session_id=$1 AND business_id=$2 AND status='active'`, [sessionId, tenantId]);
          if (!existing.rowCount) { debug.push({ step:'provided-session-invalid', sessionId }); sessionId = null; }
          else debug.push({ step:'reuse-session', sessionId });
        } catch (e) { debug.push({ step:'validate-session-error', error:e.message }); sessionId=null; }
      }

      if (!sessionId) {
        let qrCodeId = null;
        const normTable = tableNumber ? String(tableNumber).trim() : null;
        if (normTable) {
          // Safe ensure QR without relying on ON CONFLICT (in case constraint missing)
            try {
              const qrName = client._resolvedTables?.raw?.qrcodes || 'QRCodes';
              const sel = await client.query(`SELECT qr_code_id, current_session_id FROM ${client._resolvedTables? client._resolvedTables.qi(qrName):'QRCodes'} WHERE business_id=$1 AND table_number=$2 LIMIT 1`, [tenantId, normTable]);
              if (sel.rowCount) {
                qrCodeId = sel.rows[0].qr_code_id; debug.push({ step:'qr-found', qrCodeId });
              } else {
                try {
                  const qrName2 = client._resolvedTables?.raw?.qrcodes || 'QRCodes';
                  const ins = await client.query(`INSERT INTO ${client._resolvedTables? client._resolvedTables.qi(qrName2):'QRCodes'} (business_id, table_number) VALUES ($1,$2) RETURNING qr_code_id, current_session_id`, [tenantId, normTable]);
                  qrCodeId = ins.rows[0].qr_code_id; debug.push({ step:'qr-inserted', qrCodeId });
                } catch (insErr) {
                  if (insErr.code === '23505') { // unique violation race
                    const qrName3 = client._resolvedTables?.raw?.qrcodes || 'QRCodes';
                    const again = await client.query(`SELECT qr_code_id, current_session_id FROM ${client._resolvedTables? client._resolvedTables.qi(qrName3):'QRCodes'} WHERE business_id=$1 AND table_number=$2 LIMIT 1`, [tenantId, normTable]);
                    if (again.rowCount) { qrCodeId = again.rows[0].qr_code_id; debug.push({ step:'qr-race-recovered', qrCodeId }); }
                  } else { debug.push({ step:'qr-insert-error', error:insErr.message }); }
                }
              }
            } catch (qrOuter) { debug.push({ step:'qr-ensure-fatal', error: qrOuter.message }); }
            // Reuse linked active session if present
            if (qrCodeId) {
              try {
                const qrName4 = client._resolvedTables?.raw?.qrcodes || 'QRCodes';
                const cur = await client.query(`SELECT current_session_id FROM ${client._resolvedTables? client._resolvedTables.qi(qrName4):'QRCodes'} WHERE qr_code_id=$1`, [qrCodeId]);
                const currentId = cur.rows[0]?.current_session_id;
                if (currentId) {
                  const dsName2 = client._resolvedTables?.raw?.diningsessions || 'DiningSessions';
                  const act = await client.query(`SELECT session_id FROM ${client._resolvedTables? client._resolvedTables.qi(dsName2):'DiningSessions'} WHERE session_id=$1 AND status='active'`, [currentId]);
                  if (act.rowCount) { sessionId = act.rows[0].session_id; debug.push({ step:'reuse-linked-session', sessionId }); }
                }
              } catch (reErr) { debug.push({ step:'check-linked-session-error', error: reErr.message }); }
            }
            if (!sessionId && qrCodeId) {
              try {
                const dsName3 = client._resolvedTables?.raw?.diningsessions || 'DiningSessions';
                const ds = await client.query(`INSERT INTO ${client._resolvedTables? client._resolvedTables.qi(dsName3):'DiningSessions'} (business_id, qr_code_id, status) VALUES ($1,$2,'active') RETURNING session_id`, [tenantId, qrCodeId]);
                sessionId = ds.rows[0].session_id; debug.push({ step:'session-created', sessionId });
                try { const qrName5 = client._resolvedTables?.raw?.qrcodes || 'QRCodes'; await client.query(`UPDATE ${client._resolvedTables? client._resolvedTables.qi(qrName5):'QRCodes'} SET current_session_id=$1 WHERE qr_code_id=$2`, [sessionId, qrCodeId]); } catch(updErr){ debug.push({ step:'link-session-failed', error:updErr.message }); }
              } catch (dsErr) { debug.push({ step:'session-create-error', error: dsErr.message }); }
            }
        } else {
          // No table specified: fallback pick any existing QR or create one generic
          try {
            const qrName6 = client._resolvedTables?.raw?.qrcodes || 'QRCodes';
            const anyQr = await client.query(`SELECT qr_code_id FROM ${client._resolvedTables? client._resolvedTables.qi(qrName6):'QRCodes'} WHERE business_id=$1 ORDER BY qr_code_id ASC LIMIT 1`, [tenantId]);
            let qrCodeIdFallback = anyQr.rows[0]?.qr_code_id || null;
            if (!qrCodeIdFallback) {
              const qrName7 = client._resolvedTables?.raw?.qrcodes || 'QRCodes';
              const insAny = await client.query(`INSERT INTO ${client._resolvedTables? client._resolvedTables.qi(qrName7):'QRCodes'} (business_id, table_number) VALUES ($1,'GEN') RETURNING qr_code_id`, [tenantId]);
              qrCodeIdFallback = insAny.rows[0].qr_code_id; debug.push({ step:'qr-generic-created', qrCodeId: qrCodeIdFallback });
            }
            const dsName4 = client._resolvedTables?.raw?.diningsessions || 'DiningSessions';
            const ds = await client.query(`INSERT INTO ${client._resolvedTables? client._resolvedTables.qi(dsName4):'DiningSessions'} (business_id, qr_code_id, status) VALUES ($1,$2,'active') RETURNING session_id`, [tenantId, qrCodeIdFallback]);
            sessionId = ds.rows[0].session_id; debug.push({ step:'session-created-generic', sessionId });
            try { const qrName8 = client._resolvedTables?.raw?.qrcodes || 'QRCodes'; await client.query(`UPDATE ${client._resolvedTables? client._resolvedTables.qi(qrName8):'QRCodes'} SET current_session_id=$1 WHERE qr_code_id=$2`, [sessionId, qrCodeIdFallback]); } catch(_l){}
          } catch(genErr) { debug.push({ step:'generic-session-error', error: genErr.message }); }
        }
      }

      if (!sessionId) {
        return res.status(500).json({ error:'Failed to ensure session', debug });
      }

      // Create order
      let orderId=null; let orderPaymentStatus = effectivePayFirst ? 'paid':'unpaid';
      try {
        const ordersName = client._resolvedTables?.raw?.orders || 'Orders';
        const ord = await client.query(
          `INSERT INTO ${client._resolvedTables? client._resolvedTables.qi(ordersName):'Orders'} (business_id, dining_session_id, status, customer_prep_time_minutes, payment_status)
           VALUES ($1,$2,'PLACED',$3,$4) RETURNING order_id, payment_status`,
          [tenantId, sessionId, customerPrepTimeMinutes, orderPaymentStatus]
        );
        orderId = ord.rows[0].order_id; orderPaymentStatus = ord.rows[0].payment_status; debug.push({ step:'order-created', orderId });
      } catch(orderErr) {
        debug.push({ step:'order-create-error', error: orderErr.message, code: orderErr.code, detail: orderErr.detail });
        return res.status(500).json({ error:'Failed to create order', debug });
      }

      // Insert order items (only if menuItemId present) - tolerate failures
      for (const it of items) {
        if (it && it.menuItemId) {
          try {
            const itemsName = client._resolvedTables?.raw?.orderitems || 'OrderItems';
            await client.query(
              `INSERT INTO ${client._resolvedTables? client._resolvedTables.qi(itemsName):'OrderItems'} (order_id, menu_item_id, item_status, business_id)
               VALUES ($1,$2,'QUEUED',$3)`,
              [orderId, it.menuItemId, tenantId]
            );
          } catch(itemErr) {
            debug.push({ step:'item-insert-error', menuItemId: it.menuItemId, error:itemErr.message, code:itemErr.code });
          }
        }
      }

      // Immediate payment semantics
      if (effectivePayFirst && orderPaymentStatus !== 'paid') {
        try {
          await client.query(`UPDATE Orders SET payment_status='paid' WHERE order_id=$1`, [orderId]);
          orderPaymentStatus='paid'; debug.push({ step:'order-marked-paid' });
  } catch(payErr) { debug.push({ step:'mark-paid-error', error: payErr.message, code: payErr.code }); }
      }

      res.json({ success: true, orderId, sessionId, paymentStatus: orderPaymentStatus, debug, elapsedMs: Date.now()-start });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('POST /api/checkout error:', err);
    debug.push({ step:'fatal', error: err.message });
    res.status(500).json({ error: 'Checkout failed', debug });
  }
});

module.exports = router;

// Lightweight version probe (mounted after main logic so exported router has it)
router.get('/version', (req,res)=>{
  res.json({ route:'checkout', version:'v2-dynamic', note:'Expect debug.version=checkout-v2-dynamic', time: new Date().toISOString() });
});
