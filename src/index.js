require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

// Config
const PORT = process.env.PORT || 5500;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:3300';
const IS_PROD = process.env.NODE_ENV === 'production';

// Middleware
// Be permissive in development to avoid "Failed to fetch" due to CORS/port mismatches.
// In production, restrict to explicit origins.
const allowedOrigins = [
  FRONTEND_ORIGIN,
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:3300',
  'http://127.0.0.1:3300',
  'http://localhost:5173',
  'http://127.0.0.1:5173'
].filter(Boolean);

app.use(cors({
  origin: IS_PROD ? allowedOrigins : true,
  credentials: true
}));
app.use(express.json());

// Health
app.get('/health', (_, res) => res.json({ ok: true }));

// Routes
app.use('/api/menu', require('./routes/menu'));
app.use('/api/checkout', require('./routes/checkout'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/smoke', require('./routes/smoke'));

// Fallback
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});
