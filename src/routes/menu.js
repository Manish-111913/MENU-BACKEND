const express = require('express');
const router = express.Router();
const { pool, withTenant } = require('../db');
const { publicUrl } = require('../gcs');

// GET /api/menu
router.get('/', async (req, res) => {
  try {
    const businessId = Number(req.query.businessId) || Number(process.env.DEFAULT_BUSINESS_ID) || null;
    if (!pool) {
      // Fallback mock mirroring frontend initialItems shape
      return res.json({
        items: [
          { id: '1', name: 'Crispy Calamari', description: 'Tender calamari...', price: 12.99, image: 'https://images.pexels.com/photos/3026805/pexels-photo-3026805.jpeg?auto=compress&cs=tinysrgb&w=400', category: 'Starters', prepTime: 8, isAvailable: true, isTrending: true, isLiked: true, hasOffer: false, rating: 4.8 },
          { id: '2', name: 'Grilled Salmon', description: 'Fresh salmon fillet...', price: 18.50, image: 'https://images.pexels.com/photos/842571/pexels-photo-842571.jpeg?auto=compress&cs=tinysrgb&w=400', category: 'Main Course', prepTime: 15, isAvailable: true, isTrending: false, isLiked: true, hasOffer: true, rating: 4.9 },
          { id: '3', name: 'Truffle Pasta', description: 'Fresh fettuccine...', price: 16.75, image: 'https://images.pexels.com/photos/1279330/pexels-photo-1279330.jpeg?auto=compress&cs=tinysrgb&w=400', category: 'Main Course', prepTime: 12, isAvailable: false, isTrending: true, isLiked: false, hasOffer: false, rating: 4.6 },
          { id: '4', name: 'Chocolate Lava Cake', description: 'Warm chocolate cake...', price: 9.50, image: 'https://images.pexels.com/photos/291528/pexels-photo-291528.jpeg?auto=compress&cs=tinysrgb&w=400', category: 'Desserts', prepTime: 10, isAvailable: true, isTrending: true, isLiked: true, hasOffer: false, rating: 4.7 }
        ]
      });
    }
    const client = await pool.connect();
    try {
      await withTenant(client, businessId);
      const { rows } = await client.query(`
        SELECT mi.menu_item_id AS id,
               mi.name,
               mi.price,
               mi.image_url AS image,
               COALESCE(mi.avg_prep_time_minutes, 10) AS prep_time,
               mi.is_available_to_customer AS is_available,
               COALESCE(mc.name,'All') AS category
        FROM MenuItems mi
        LEFT JOIN MenuCategories mc ON mi.category_id = mc.category_id
        WHERE mi.is_active = TRUE
          AND mi.is_available_to_customer = TRUE
          AND mi.price > 0 -- exclude complimentary/zero-priced items
          AND NOT (
            LOWER(mi.name) LIKE 'demo%'
            OR LOWER(mi.name) LIKE '%demo%'
            OR LOWER(mi.name) LIKE '%isolated%'
            OR LOWER(mi.name) LIKE '%complimentary%'
          )
        ORDER BY mi.name ASC
      `);
      // Map images via public URL only (no per-item signed URLs to keep response fast and stable)
      const items = rows.map(r => ({
        id: String(r.id),
        name: r.name,
        price: Number(r.price),
        image: publicUrl(r.image) || r.image,
        prepTime: Number(r.prep_time) || 10,
        isAvailable: !!r.is_available,
        category: r.category,
        description: '',
        rating: 4.5,
        isTrending: false,
        isLiked: false,
        hasOffer: false
      }));
      res.json({ items });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('GET /api/menu error:', err);
    res.status(500).json({ error: 'Failed to load menu' });
  }
});

module.exports = router;
