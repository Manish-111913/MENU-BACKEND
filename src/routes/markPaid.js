const express = require('express');
const router = express.Router();

// POST /api/mark-paid
// Proxy endpoint to call QRbilling backend mark-paid API
// This allows the frontend to mark tables as paid without direct access to QRbilling backend
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

    // Configure QRbilling backend URL
    const QR_BACKEND_URL = process.env.QR_BACKEND_URL || 'http://localhost:5001';
    
    console.log('[MARK_PAID_PROXY] Proxying to QRbilling backend:', {
      url: `${QR_BACKEND_URL}/api/qr/mark-paid`,
      businessId,
      tableNumber,
      totalAmount
    });

    // Make request to QRbilling backend
    const fetch = require('node-fetch');
    const response = await fetch(`${QR_BACKEND_URL}/api/qr/mark-paid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        businessId,
        tableNumber,
        qrId,
        sessionId,
        totalAmount
      })
    });

    const result = await response.json();
    
    if (response.ok) {
      console.log('[MARK_PAID_PROXY] Success:', result);
      res.json({ success: true, ...result });
    } else {
      console.error('[MARK_PAID_PROXY] QR backend error:', result);
      res.status(response.status).json({ 
        success: false, 
        error: 'QR backend request failed',
        details: result 
      });
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