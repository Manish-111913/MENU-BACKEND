const express = require('express');
const router = express.Router();
const { pool, withTenant } = require('../db');

// POST /api/checkout
// body: { businessId?, diningSessionId?, tableNumber?, customerPrepTimeMinutes?, payFirst?, items: [{menuItemId, name, quantity, price}], totalAmount? }
router.post('/', async (req, res) => {
  const debug = [];
  const textLog = [];
  const log = (msg, extra) => { const line = extra ? { msg, ...extra } : { msg }; debug.push({ step:'log', ...line }); textLog.push(line); };
  const start = Date.now();
  const { businessId, diningSessionId, tableNumber, customerPrepTimeMinutes = 15, payFirst = false, payNow = false, items = [], totalAmount: totalFromClient } = req.body || {};
  const effectivePayFirst = !!(payFirst || payNow);
  const safeItems = Array.isArray(items) ? items : [];
  const computed = safeItems.reduce((s,i)=> s + ((Number(i.price)||0) * (Number(i.quantity)||0)), 0);
  const totalAmount = Number.isFinite(Number(totalFromClient)) && Number(totalFromClient) > 0 ? Number(totalFromClient) : computed;
  debug.push({ step:'version', value:'checkout-v2-dynamic' });
  log('incoming-payload', { businessId, diningSessionId, tableNumber, customerPrepTimeMinutes, flags:{ payFirst, payNow, effectivePayFirst }, itemCount: safeItems.length, totalAmount });
  try {
    if (!pool) {
      const allowMock = String(process.env.ALLOW_DB_MOCK || '').toLowerCase() === 'true';
      log('pool-missing', { allowMock });
      if (allowMock) return res.json({ success:true, orderId:'mock-1', sessionId:'mock-session', paymentStatus: effectivePayFirst?'paid':'unpaid', amount: totalAmount, debug, textLog, mock:true });
      return res.status(503).json({ error:'Database not configured. Set DATABASE_URL and redeploy.', debug, textLog });
    }
    const client = await pool.connect();
    try {
      const tenantId = Number(businessId) || Number(process.env.DEFAULT_BUSINESS_ID) || null;
      if (!tenantId) { log('missing-businessId'); return res.status(400).json({ error:'businessId required', debug, textLog }); }
      debug.push({ step:'tenant', tenantId });
      await withTenant(client, tenantId);

      // Preflight resolve table names
      try {
        const tbls = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`);
        const present = tbls.rows.map(r=>r.table_name);
        function resolveTable(cands) {
          for (const c of cands) { const hit = present.find(p=>p.toLowerCase()===c.toLowerCase()); if (hit) return hit; }
          return null;
        }
        const resolved = {
          qrcodes: resolveTable(['QRCodes','qrcodes','qr_codes']),
          diningsessions: resolveTable(['DiningSessions','diningsessions','dining_sessions']),
          orders: resolveTable(['Orders','orders']),
          // Prefer snake_case order_items if both exist
          orderitems: resolveTable(['order_items','orderitems','OrderItems'])
        };
        const qi = n => (/[^a-z0-9_]/.test(n) || /[A-Z]/.test(n)) ? '"'+n.replace(/"/g,'""')+'"' : n;
        client._resolvedTables = { raw: resolved, qi };
        log('resolved-tables', resolved);
      } catch (tErr) { debug.push({ step:'table-enumeration-error', error: tErr.message }); }

      // Ensure dining session
      let sessionId = diningSessionId || null;
      if (sessionId) {
        try {
          const dsName = client._resolvedTables?.raw?.diningsessions || 'DiningSessions';
          const qn = client._resolvedTables ? client._resolvedTables.qi(dsName) : 'DiningSessions';
          const existing = await client.query(`SELECT session_id FROM ${qn} WHERE session_id=$1 AND business_id=$2 AND status='active'`, [sessionId, tenantId]);
          if (!existing.rowCount) { debug.push({ step:'provided-session-invalid', sessionId }); sessionId = null; }
          else debug.push({ step:'reuse-session', sessionId });
        } catch (e) { debug.push({ step:'validate-session-error', error:e.message }); sessionId=null; }
      }

      if (!sessionId) {
        let qrCodeId = null;
        const normTable = tableNumber ? String(tableNumber).trim() : null;
        if (normTable) {
          try {
            const qrName = client._resolvedTables?.raw?.qrcodes || 'QRCodes';
            const qn = client._resolvedTables ? client._resolvedTables.qi(qrName) : 'QRCodes';
            const sel = await client.query(`SELECT qr_code_id, current_session_id FROM ${qn} WHERE business_id=$1 AND table_number=$2 LIMIT 1`, [tenantId, normTable]);
            if (sel.rowCount) { qrCodeId = sel.rows[0].qr_code_id; debug.push({ step:'qr-found', qrCodeId }); }
            else {
              try {
                const ins = await client.query(`INSERT INTO ${qn} (business_id, table_number) VALUES ($1,$2) RETURNING qr_code_id, current_session_id`, [tenantId, normTable]);
                qrCodeId = ins.rows[0].qr_code_id; debug.push({ step:'qr-inserted', qrCodeId });
              } catch (insErr) {
                if (insErr.code === '23505') {
                  const again = await client.query(`SELECT qr_code_id, current_session_id FROM ${qn} WHERE business_id=$1 AND table_number=$2 LIMIT 1`, [tenantId, normTable]);
                  if (again.rowCount) { qrCodeId = again.rows[0].qr_code_id; debug.push({ step:'qr-race-recovered', qrCodeId }); }
                } else { debug.push({ step:'qr-insert-error', error:insErr.message }); }
              }
            }
          } catch (qrOuter) { debug.push({ step:'qr-ensure-fatal', error: qrOuter.message }); }
          if (qrCodeId) {
            try {
              const qrName4 = client._resolvedTables?.raw?.qrcodes || 'QRCodes';
              const qn4 = client._resolvedTables ? client._resolvedTables.qi(qrName4) : 'QRCodes';
              const cur = await client.query(`SELECT current_session_id FROM ${qn4} WHERE qr_code_id=$1`, [qrCodeId]);
              const currentId = cur.rows[0]?.current_session_id;
              if (currentId) {
                const dsName2 = client._resolvedTables?.raw?.diningsessions || 'DiningSessions';
                const qd2 = client._resolvedTables ? client._resolvedTables.qi(dsName2) : 'DiningSessions';
                const act = await client.query(`SELECT session_id FROM ${qd2} WHERE session_id=$1 AND status='active'`, [currentId]);
                if (act.rowCount) { sessionId = act.rows[0].session_id; debug.push({ step:'reuse-linked-session', sessionId }); }
              }
            } catch (reErr) { debug.push({ step:'check-linked-session-error', error: reErr.message }); }
          }
          if (!sessionId && qrCodeId) {
            try {
              const dsName3 = client._resolvedTables?.raw?.diningsessions || 'DiningSessions';
              const qd3 = client._resolvedTables ? client._resolvedTables.qi(dsName3) : 'DiningSessions';
              const ds = await client.query(`INSERT INTO ${qd3} (business_id, qr_code_id, status) VALUES ($1,$2,'active') RETURNING session_id`, [tenantId, qrCodeId]);
              sessionId = ds.rows[0].session_id; debug.push({ step:'session-created', sessionId });
              try {
                const qrName5 = client._resolvedTables?.raw?.qrcodes || 'QRCodes';
                const qn5 = client._resolvedTables ? client._resolvedTables.qi(qrName5) : 'QRCodes';
                await client.query(`UPDATE ${qn5} SET current_session_id=$1 WHERE qr_code_id=$2`, [sessionId, qrCodeId]);
              } catch(updErr){ debug.push({ step:'link-session-failed', error:updErr.message }); }
            } catch (dsErr) { debug.push({ step:'session-create-error', error: dsErr.message }); }
          }
        } else {
          // generic session
          try {
            const qrName6 = client._resolvedTables?.raw?.qrcodes || 'QRCodes';
            const qn6 = client._resolvedTables ? client._resolvedTables.qi(qrName6) : 'QRCodes';
            const anyQr = await client.query(`SELECT qr_code_id FROM ${qn6} WHERE business_id=$1 ORDER BY qr_code_id ASC LIMIT 1`, [tenantId]);
            let qrCodeIdFallback = anyQr.rows[0]?.qr_code_id || null;
            if (!qrCodeIdFallback) {
              const insAny = await client.query(`INSERT INTO ${qn6} (business_id, table_number) VALUES ($1,'GEN') RETURNING qr_code_id`, [tenantId]);
              qrCodeIdFallback = insAny.rows[0].qr_code_id; debug.push({ step:'qr-generic-created', qrCodeId: qrCodeIdFallback });
            }
            const dsName4 = client._resolvedTables?.raw?.diningsessions || 'DiningSessions';
            const qd4 = client._resolvedTables ? client._resolvedTables.qi(dsName4) : 'DiningSessions';
            const ds = await client.query(`INSERT INTO ${qd4} (business_id, qr_code_id, status) VALUES ($1,$2,'active') RETURNING session_id`, [tenantId, qrCodeIdFallback]);
            sessionId = ds.rows[0].session_id; debug.push({ step:'session-created-generic', sessionId });
            try { await client.query(`UPDATE ${qn6} SET current_session_id=$1 WHERE qr_code_id=$2`, [sessionId, qrCodeIdFallback]); } catch(_l){}
          } catch(genErr) { debug.push({ step:'generic-session-error', error: genErr.message }); }
        }
      }

      if (!sessionId) { log('ensure-session-failed'); return res.status(500).json({ error:'Failed to ensure session', debug, textLog }); }

      // Create order
      let orderId=null; let orderPaymentStatus = effectivePayFirst ? 'paid':'unpaid';
      try {
        const ordersName = client._resolvedTables?.raw?.orders || 'Orders';
        const qn = client._resolvedTables ? client._resolvedTables.qi(ordersName) : 'Orders';
        const ord = await client.query(
          `INSERT INTO ${qn} (business_id, dining_session_id, status, customer_prep_time_minutes, payment_status)
           VALUES ($1,$2,'PLACED',$3,$4) RETURNING order_id, payment_status`,
          [tenantId, sessionId, customerPrepTimeMinutes, orderPaymentStatus]
        );
        orderId = ord.rows[0].order_id; orderPaymentStatus = ord.rows[0].payment_status; log('order-created', { orderId });
        // Persist total amount (create column if needed)
        try {
          const colCheck = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND LOWER(table_name)=LOWER($1) AND column_name='total_amount' LIMIT 1`, [ordersName]);
          if (!colCheck.rowCount) { try { await client.query(`ALTER TABLE ${qn} ADD COLUMN total_amount NUMERIC(12,2) DEFAULT 0`); } catch(_e){} }
          const colCheck2 = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND LOWER(table_name)=LOWER($1) AND column_name='total_amount' LIMIT 1`, [ordersName]);
          if (colCheck2.rowCount) { await client.query(`UPDATE ${qn} SET total_amount=$1 WHERE order_id=$2`, [totalAmount, orderId]); log('orders-total-amount-updated', { orderId, totalAmount }); }
        } catch (taErr) { debug.push({ step:'orders-total-amount-update-error', error: taErr.message }); }
      } catch(orderErr) {
        log('order-create-error', { message: orderErr.message, code: orderErr.code, detail: orderErr.detail });
        return res.status(500).json({ error:'Failed to create order', debug, textLog });
      }

      // Optional legacy bridge: session_orders (best effort, resilient to missing cols)
      try {
        const exists = await client.query(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='session_orders' LIMIT 1`);
        if (!exists.rowCount) {
          try {
            await client.query(`CREATE TABLE session_orders (
              id BIGSERIAL PRIMARY KEY,
              business_id BIGINT,
              session_id BIGINT UNIQUE NOT NULL,
              order_status TEXT,
              payment_status TEXT,
              total_amount NUMERIC(12,2) DEFAULT 0,
              created_at TIMESTAMPTZ DEFAULT NOW()
            )`);
          } catch(_){}
        }
        const ready = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='session_orders'`);
        const have = new Set(ready.rows.map(r=>String(r.column_name).toLowerCase()));
        const ensure = async (sql) => { try { await client.query(sql); } catch(_){} };
        if (!have.has('business_id')) await ensure(`ALTER TABLE session_orders ADD COLUMN business_id BIGINT`);
        if (!have.has('payment_status')) await ensure(`ALTER TABLE session_orders ADD COLUMN payment_status TEXT`);
        if (!have.has('total_amount')) await ensure(`ALTER TABLE session_orders ADD COLUMN total_amount NUMERIC(12,2) DEFAULT 0`);

        const prior = await client.query(`SELECT id FROM session_orders WHERE session_id=$1 LIMIT 1`, [sessionId]);
        if (!prior.rowCount) {
          const cols = ['session_id','order_status','created_at'];
          const vals = [sessionId,'completed', new Date()];
          if (have.has('business_id')) { cols.unshift('business_id'); vals.unshift(tenantId); }
          if (have.has('payment_status')) { cols.push('payment_status'); vals.push(orderPaymentStatus); }
          if (have.has('total_amount')) { cols.push('total_amount'); vals.push(totalAmount); }
          const placeholders = vals.map((_,i)=>`$${i+1}`).join(',');
          await client.query(`INSERT INTO session_orders (${cols.join(',')}) VALUES (${placeholders})`, vals);
          log('session-orders-inserted', { sessionId, totalAmount });
        } else if (effectivePayFirst && have.has('payment_status')) {
          await client.query(`UPDATE session_orders SET payment_status='paid' WHERE session_id=$1`, [sessionId]);
          log('session-orders-updated-paid', { sessionId });
        }
      } catch(e) { debug.push({ step:'session-orders-bridge-error', error:e.message }); }

      // Insert order items (dynamic, tolerant)
      for (const it of safeItems) {
        try {
          const itemsName = client._resolvedTables?.raw?.orderitems || 'OrderItems';
          const qItems = client._resolvedTables ? client._resolvedTables.qi(itemsName) : 'OrderItems';
          const colsRes = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND LOWER(table_name)=LOWER($1)`, [itemsName]);
          const have = new Set(colsRes.rows.map(r=>String(r.column_name).toLowerCase()));
          const ensure = async (sql) => { try { await client.query(sql); } catch(_){} };
          if (!have.has('quantity')) await ensure(`ALTER TABLE ${qItems} ADD COLUMN quantity INT DEFAULT 1`);
          if (!have.has('unit_price') && !have.has('price')) await ensure(`ALTER TABLE ${qItems} ADD COLUMN unit_price NUMERIC(12,2) DEFAULT 0`);
          if (!have.has('item_name') && !have.has('name')) await ensure(`ALTER TABLE ${qItems} ADD COLUMN item_name TEXT`);

          const qty = Number(it.quantity||1);
          const price = Number(it.price||0);
          const name = it.name || null;
          const menuItemId = it.menuItemId != null ? Number(it.menuItemId) : null;
          const cols = [];
          const vals = [];
          if (have.has('business_id')) { cols.push('business_id'); vals.push(tenantId); }
          cols.push('order_id'); vals.push(orderId);
          if (have.has('item_status')) { cols.push('item_status'); vals.push('QUEUED'); }
          if (menuItemId && have.has('menu_item_id')) { cols.push('menu_item_id'); vals.push(menuItemId); }
          if (have.has('quantity')) { cols.push('quantity'); vals.push(qty); }
          if (have.has('unit_price')) { cols.push('unit_price'); vals.push(price); } else if (have.has('price')) { cols.push('price'); vals.push(price); }
          if (have.has('item_name')) { cols.push('item_name'); vals.push(name); } else if (have.has('name')) { cols.push('name'); vals.push(name); }
          if (have.has('created_at')) { cols.push('created_at'); vals.push(new Date()); }
          if (cols.length < 2) { log('item-skip-insufficient-columns', { itemsName }); continue; }
          const placeholders = vals.map((_,i)=>`$${i+1}`).join(',');
          const colsSql = cols.map(c=>`"${c}"`).join(',');
          await client.query(`INSERT INTO ${qItems} (${colsSql}) VALUES (${placeholders})`, vals);
          log('item-inserted', { menuItemId, qty, price, usedColumns: cols });
        } catch (itemErr) {
          debug.push({ step:'item-insert-error', error:itemErr.message, code:itemErr.code });
        }
      }

      // Immediate payment semantics
      if (effectivePayFirst && orderPaymentStatus !== 'paid') {
        try {
          const ordersName = client._resolvedTables?.raw?.orders || 'Orders';
          const qn = client._resolvedTables ? client._resolvedTables.qi(ordersName) : 'Orders';
          await client.query(`UPDATE ${qn} SET payment_status='paid' WHERE order_id=$1`, [orderId]);
          orderPaymentStatus = 'paid'; log('order-marked-paid', { orderId });
        } catch(payErr) { debug.push({ step:'mark-paid-error', error: payErr.message, code: payErr.code }); }
      }

      res.json({ success:true, orderId, sessionId, paymentStatus: orderPaymentStatus, totalAmount, debug, textLog, elapsedMs: Date.now()-start });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('POST /api/checkout error:', err);
    debug.push({ step:'fatal', error: err.message });
    res.status(500).json({ error:'Checkout failed', debug, textLog });
  }
});

module.exports = router;

router.get('/version', (req,res)=>{
  res.json({ route:'checkout', version:'v2-dynamic', note:'Expect debug.version=checkout-v2-dynamic', time: new Date().toISOString() });
});
