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
  const textLog = [];
  const log = (msg, extra) => { const line = extra ? { msg, ...extra } : { msg }; debug.push({ step:'log', ...line }); textLog.push(line); };
  const start = Date.now();
  const { businessId, diningSessionId, tableNumber, customerPrepTimeMinutes = 15, payFirst = false, payNow = false, items = [], totalAmount: totalFromClient } = req.body || {};
  const effectivePayFirst = !!(payFirst || payNow); // accept both flags
  // Compute total amount up front for persistence into Orders/session_orders when possible
  const safeItems = Array.isArray(items) ? items : [];
  const computed = safeItems.reduce((s,i)=> s + ((Number(i.price)||0) * (Number(i.quantity)||0)), 0);
  const totalAmount = Number.isFinite(Number(totalFromClient)) && Number(totalFromClient) > 0 ? Number(totalFromClient) : computed;
  debug.push({ step:'version', value:'checkout-v2-dynamic' });
  log('incoming-payload', { businessId, diningSessionId, tableNumber, customerPrepTimeMinutes, flags:{ payFirst, payNow, effectivePayFirst }, itemCount: safeItems.length, totalAmount });
  try {
    if (!pool) {
      const allowMock = String(process.env.ALLOW_DB_MOCK || '').toLowerCase() === 'true';
      log('pool-missing', { allowMock });
      if (allowMock) {
        return res.json({ success: true, orderId: 'mock-1', sessionId: 'mock-session', paymentStatus: effectivePayFirst ? 'paid':'unpaid', amount: totalAmount, debug, textLog, mock:true });
      }
      return res.status(503).json({ error: 'Database not configured. Set DATABASE_URL and redeploy.', debug, textLog });
    }
    const client = await pool.connect();
    try {
      const tenantId = Number(businessId) || Number(process.env.DEFAULT_BUSINESS_ID) || null;
  if (!tenantId) { log('missing-businessId'); return res.status(400).json({ error:'businessId required', debug, textLog }); }
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
        debug.push({ step:'resolved-tables', resolved }); log('resolved-tables', resolved);
        if (!resolved.qrcodes || !resolved.diningsessions || !resolved.orders) {
          debug.push({ step:'missing-core-table', missing: Object.entries(resolved).filter(([k,v])=>!v).map(([k])=>k) });
          log('missing-core-table', { missing: Object.entries(resolved).filter(([k,v])=>!v).map(([k])=>k) });
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
                qrCodeId = sel.rows[0].qr_code_id; debug.push({ step:'qr-found', qrCodeId }); log('qr-found', { qrCodeId });
              } else {
                try {
                  const qrName2 = client._resolvedTables?.raw?.qrcodes || 'QRCodes';
                  const ins = await client.query(`INSERT INTO ${client._resolvedTables? client._resolvedTables.qi(qrName2):'QRCodes'} (business_id, table_number) VALUES ($1,$2) RETURNING qr_code_id, current_session_id`, [tenantId, normTable]);
                  qrCodeId = ins.rows[0].qr_code_id; debug.push({ step:'qr-inserted', qrCodeId }); log('qr-inserted', { qrCodeId });
                } catch (insErr) {
                  if (insErr.code === '23505') { // unique violation race
                    const qrName3 = client._resolvedTables?.raw?.qrcodes || 'QRCodes';
                    const again = await client.query(`SELECT qr_code_id, current_session_id FROM ${client._resolvedTables? client._resolvedTables.qi(qrName3):'QRCodes'} WHERE business_id=$1 AND table_number=$2 LIMIT 1`, [tenantId, normTable]);
                    if (again.rowCount) { qrCodeId = again.rows[0].qr_code_id; debug.push({ step:'qr-race-recovered', qrCodeId }); log('qr-race-recovered', { qrCodeId }); }
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
                  if (act.rowCount) { sessionId = act.rows[0].session_id; debug.push({ step:'reuse-linked-session', sessionId }); log('reuse-linked-session', { sessionId }); }
                }
              } catch (reErr) { debug.push({ step:'check-linked-session-error', error: reErr.message }); }
            }
            if (!sessionId && qrCodeId) {
              try {
                const dsName3 = client._resolvedTables?.raw?.diningsessions || 'DiningSessions';
                const ds = await client.query(`INSERT INTO ${client._resolvedTables? client._resolvedTables.qi(dsName3):'DiningSessions'} (business_id, qr_code_id, status) VALUES ($1,$2,'active') RETURNING session_id`, [tenantId, qrCodeId]);
                sessionId = ds.rows[0].session_id; debug.push({ step:'session-created', sessionId }); log('session-created', { sessionId });
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
              qrCodeIdFallback = insAny.rows[0].qr_code_id; debug.push({ step:'qr-generic-created', qrCodeId: qrCodeIdFallback }); log('qr-generic-created', { qrCodeId: qrCodeIdFallback });
            }
            const dsName4 = client._resolvedTables?.raw?.diningsessions || 'DiningSessions';
            const ds = await client.query(`INSERT INTO ${client._resolvedTables? client._resolvedTables.qi(dsName4):'DiningSessions'} (business_id, qr_code_id, status) VALUES ($1,$2,'active') RETURNING session_id`, [tenantId, qrCodeIdFallback]);
            sessionId = ds.rows[0].session_id; debug.push({ step:'session-created-generic', sessionId }); log('session-created-generic', { sessionId });
            try { const qrName8 = client._resolvedTables?.raw?.qrcodes || 'QRCodes'; await client.query(`UPDATE ${client._resolvedTables? client._resolvedTables.qi(qrName8):'QRCodes'} SET current_session_id=$1 WHERE qr_code_id=$2`, [sessionId, qrCodeIdFallback]); } catch(_l){}
          } catch(genErr) { debug.push({ step:'generic-session-error', error: genErr.message }); }
        }
      }

      if (!sessionId) {
        log('ensure-session-failed');
        return res.status(500).json({ error:'Failed to ensure session', debug, textLog });
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
        orderId = ord.rows[0].order_id; orderPaymentStatus = ord.rows[0].payment_status; debug.push({ step:'order-created', orderId }); log('order-created', { orderId });
        // Persist total amount into Orders.total_amount if the column exists
        try {
          const colCheck = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND LOWER(table_name)=LOWER($1) AND column_name='total_amount' LIMIT 1`, [ordersName]);
          const qn = client._resolvedTables? client._resolvedTables.qi(ordersName):'Orders';
          if (!colCheck.rowCount) {
            // Try to add the column automatically (safe no-op if exists because of exception)
            try { await client.query(`ALTER TABLE ${qn} ADD COLUMN total_amount NUMERIC(12,2) DEFAULT 0`); debug.push({ step:'orders-add-total-amount-column' }); }
            catch(_e) { /* ignore if cannot add */ }
          }
          const colCheck2 = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND LOWER(table_name)=LOWER($1) AND column_name='total_amount' LIMIT 1`, [ordersName]);
          if (colCheck2.rowCount) {
            await client.query(`UPDATE ${qn} SET total_amount=$1 WHERE order_id=$2`, [totalAmount, orderId]);
            debug.push({ step:'orders-total-amount-updated', orderId, totalAmount });
          } else {
            debug.push({ step:'orders-total-amount-missing-column' });
          }
        } catch (taErr) { debug.push({ step:'orders-total-amount-update-error', error: taErr.message }); }
      } catch(orderErr) {
        debug.push({ step:'order-create-error', error: orderErr.message, code: orderErr.code, detail: orderErr.detail });
        log('order-create-error', { message: orderErr.message, code: orderErr.code, detail: orderErr.detail });
        return res.status(500).json({ error:'Failed to create order', debug, textLog });
      }

      // Optional legacy bridge: insert into session_orders if table exists
      try {
        let soExists = await client.query(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='session_orders' LIMIT 1`);
        if (!soExists.rowCount) {
          // attempt auto-create to ensure backward compatibility
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
            log('session-orders-created');
            debug.push({ step:'session-orders-created' });
            soExists = { rowCount:1 };
          } catch (createErr) {
            log('session-orders-create-failed', { error: createErr.message });
            debug.push({ step:'session-orders-create-failed', error: createErr.message });
          }
        }
        if (soExists.rowCount) {
          // Ensure business_id column exists; try to add if missing
          let soHasBiz = false;
          try {
            const colChk = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='session_orders' AND column_name='business_id' LIMIT 1`);
            soHasBiz = !!colChk.rowCount;
          } catch(_e) {}
          if (!soHasBiz) {
            try { await client.query(`ALTER TABLE session_orders ADD COLUMN business_id BIGINT`); soHasBiz = true; debug.push({ step:'session-orders-add-business-id' }); } catch(_e) {}
          }
          // Insert only if no existing row for this session
            const existing = await client.query(`SELECT id FROM session_orders WHERE session_id=$1 LIMIT 1`, [sessionId]);
            if (!existing.rowCount) {
              try {
                if (soHasBiz) {
                  await client.query(`INSERT INTO session_orders (business_id, session_id, order_status, payment_status, total_amount, created_at) VALUES ($1,$2,'completed',$3,$4,NOW())`, [tenantId, sessionId, orderPaymentStatus, totalAmount]);
                } else {
                  await client.query(`INSERT INTO session_orders (session_id, order_status, payment_status, total_amount, created_at) VALUES ($1,'completed',$2,$3,NOW())`, [sessionId, orderPaymentStatus, totalAmount]);
                }
                log('session-orders-inserted', { sessionId, totalAmount });
                debug.push({ step:'session-orders-inserted', sessionId, totalAmount });
              } catch (bridgeErr) {
                log('session-orders-insert-error', { message: bridgeErr.message, code: bridgeErr.code });
                debug.push({ step:'session-orders-insert-error', error: bridgeErr.message, code: bridgeErr.code });
              }
            } else {
              // Update existing record to paid if payFirst was requested
              if (effectivePayFirst) {
                try {
                  await client.query(`UPDATE session_orders SET payment_status='paid' WHERE session_id=$1`, [sessionId]);
                  log('session-orders-updated-paid', { sessionId });
                  debug.push({ step:'session-orders-updated-paid', sessionId });
                } catch (updateErr) {
                  log('session-orders-update-error', { message: updateErr.message });
                  debug.push({ step:'session-orders-update-error', error: updateErr.message });
                }
              }
              log('session-orders-existing', { sessionId });
              debug.push({ step:'session-orders-existing', sessionId });
            }
        } else { log('session-orders-missing'); }
      } catch (soOuter) { log('session-orders-bridge-check-error', { error: soOuter.message }); }

      // Insert order items dynamically: tolerate schema variants and missing menuItemId
      for (const it of safeItems) {
        try {
          const itemsName = client._resolvedTables?.raw?.orderitems || 'OrderItems';
          const qItems = client._resolvedTables? client._resolvedTables.qi(itemsName):'OrderItems';
          // Discover available columns
          const colsRes = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND LOWER(table_name)=LOWER($1)`, [itemsName]);
          const have = new Set(colsRes.rows.map(r=>String(r.column_name).toLowerCase()));
          // Ensure helpful columns exist if the table allows changes
          try { if (!have.has('quantity')) { await client.query(`ALTER TABLE ${qItems} ADD COLUMN quantity INT DEFAULT 1`); have.add('quantity'); } } catch(_e){}
          try { if (!have.has('unit_price') && !have.has('price')) { await client.query(`ALTER TABLE ${qItems} ADD COLUMN unit_price NUMERIC(12,2) DEFAULT 0`); have.add('unit_price'); } } catch(_e){}
          try { if (!have.has('item_name') && !have.has('name')) { await client.query(`ALTER TABLE ${qItems} ADD COLUMN item_name TEXT`); have.add('item_name'); } } catch(_e){}

          const qty = Number(it.quantity||1);
          const price = Number(it.price||0);
          const name = it.name || null;
          const menuItemId = it.menuItemId != null ? Number(it.menuItemId) : null;

          // Build dynamic column list and values
          const cols = [];
          const vals = [];
          let idx = 1;
          const add = (col, val) => { cols.push(col); vals.push(val); return `$${idx++}`; };

          add('order_id', orderId);
          if (have.has('business_id')) add('business_id', tenantId);
          if (have.has('item_status')) add('item_status', 'QUEUED');
          if (menuItemId && have.has('menu_item_id')) add('menu_item_id', menuItemId);
          if (have.has('quantity')) add('quantity', qty);
          if (have.has('unit_price')) add('unit_price', price);
          else if (have.has('price')) add('price', price);
          if (have.has('item_name')) add('item_name', name);
          else if (have.has('name')) add('name', name);
          if (have.has('created_at')) add('created_at', new Date());

          // If only order_id was added (extremely constrained table), skip to avoid invalid SQL
          if (cols.length <= 1) { log('item-skip-insufficient-columns', { itemsName }); continue; }

          const sql = `INSERT INTO ${qItems} (${cols.map(c=>`"${c}"`).join(',')}) VALUES (${vals.map((_,i)=>`$${i+1}`).join(',')})`;
          await client.query(sql, vals);
          log('item-inserted', { menuItemId, qty, price, usedColumns: cols });
        } catch(itemErr) {
          debug.push({ step:'item-insert-error', error:itemErr.message, code:itemErr.code });
          log('item-insert-error', { error:itemErr.message, code:itemErr.code });
        }
      }

      // Immediate payment semantics
      if (effectivePayFirst && orderPaymentStatus !== 'paid') {
        try {
          const ordersName = client._resolvedTables?.raw?.orders || 'Orders';
          const qn = client._resolvedTables? client._resolvedTables.qi(ordersName):'Orders';
          await client.query(`UPDATE ${qn} SET payment_status='paid' WHERE order_id=$1`, [orderId]);
          orderPaymentStatus='paid'; debug.push({ step:'order-marked-paid' });
          log('order-marked-paid', { orderId });
        } catch(payErr) { debug.push({ step:'mark-paid-error', error: payErr.message, code: payErr.code }); log('mark-paid-error', { message: payErr.message, code: payErr.code }); }
      }

      res.json({ success: true, orderId, sessionId, paymentStatus: orderPaymentStatus, totalAmount, debug, textLog, elapsedMs: Date.now()-start });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('POST /api/checkout error:', err);
    debug.push({ step:'fatal', error: err.message });
    res.status(500).json({ error: 'Checkout failed', debug, textLog });
  }
});

module.exports = router;

// Lightweight version probe (mounted after main logic so exported router has it)
router.get('/version', (req,res)=>{
  res.json({ route:'checkout', version:'v2-dynamic', note:'Expect debug.version=checkout-v2-dynamic', time: new Date().toISOString() });
});
