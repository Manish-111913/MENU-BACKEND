const express = require('express');
const router = express.Router();
const { pool, withTenant } = require('../db');
const fetch = require('node-fetch');
const { publicUrl, signedUrl, HAS_GCS } = require('../gcs');

// 1) DB smoke test: can we read a few menu items and categories?
router.get('/db', async (req, res) => {
  if (!pool) return res.status(500).json({ ok: false, error: 'No DATABASE_URL configured' });
  const businessId = Number(req.query.businessId) || Number(process.env.DEFAULT_BUSINESS_ID) || null;
  const client = await pool.connect();
  try {
    await withTenant(client, businessId);
    const { rows } = await client.query(
      `SELECT mi.menu_item_id, mi.name, mi.image_url, COALESCE(mc.name,'All') AS category
       FROM MenuItems mi LEFT JOIN MenuCategories mc ON mi.category_id = mc.category_id
       WHERE mi.is_active = TRUE
         AND mi.price > 0
         AND NOT (
           LOWER(mi.name) LIKE 'demo%'
           OR LOWER(mi.name) LIKE '%demo%'
           OR LOWER(mi.name) LIKE '%isolated%'
           OR LOWER(mi.name) LIKE '%complimentary%'
         )
       ORDER BY mi.menu_item_id DESC
       LIMIT 10`
    );
    return res.json({ ok: true, count: rows.length, sample: rows });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  } finally {
    client.release();
  }
});

// 2) Image smoke test: for N latest items, HEAD request image_url
router.get('/images', async (req, res) => {
  if (!pool) return res.status(500).json({ ok: false, error: 'No DATABASE_URL configured' });
  const limit = Math.min(Number(req.query.limit) || 5, 25);
  const businessId = Number(req.query.businessId) || Number(process.env.DEFAULT_BUSINESS_ID) || null;
  const client = await pool.connect();
  try {
    await withTenant(client, businessId);
    const { rows } = await client.query(
      `SELECT menu_item_id, name, image_url FROM MenuItems
       WHERE is_active = TRUE
         AND price > 0
         AND image_url IS NOT NULL AND image_url <> ''
         AND NOT (
           LOWER(name) LIKE 'demo%'
           OR LOWER(name) LIKE '%demo%'
           OR LOWER(name) LIKE '%isolated%'
           OR LOWER(name) LIKE '%complimentary%'
         )
       ORDER BY menu_item_id DESC LIMIT $1`,
      [limit]
    );
    const results = [];
    for (const r of rows) {
      let ok = false, status = null;
      try {
        const target = HAS_GCS ? await signedUrl(r.image_url) : publicUrl(r.image_url);
        let resp = await fetch(target, { method: 'HEAD' });
        if (!resp.ok && (resp.status === 405 || resp.status === 403)) {
          // Some CDNs disallow HEAD; fallback to GET
          resp = await fetch(target, { method: 'GET' });
        }
        ok = resp.ok; status = resp.status;
      } catch (e) {
        ok = false; status = e.message;
      }
      results.push({ id: r.menu_item_id, name: r.name, url: r.image_url, ok, status });
    }
    const failures = results.filter(x => !x.ok);
    return res.json({ ok: failures.length === 0, total: results.length, failures, results });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
