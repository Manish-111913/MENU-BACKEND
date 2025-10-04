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
const additionalOrigins = process.env.ADDITIONAL_ORIGINS 
  ? process.env.ADDITIONAL_ORIGINS.split(',').map(o => o.trim())
  : [];

const allowedOrigins = [
  FRONTEND_ORIGIN,
  ...additionalOrigins,
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

// Startup config logs to make DB/env issues obvious
{
  const raw = process.env.DATABASE_URL || process.env.RUNTIME_DATABASE_URL || '';
  if (!raw) {
    console.warn('[BOOT] No DATABASE_URL or RUNTIME_DATABASE_URL. DB-backed routes will fail unless ALLOW_DB_MOCK=true');
  } else {
    const redacted = raw.replace(/:(?:[^:@/]+)@/, ':***@');
    const source = process.env.DATABASE_URL ? 'DATABASE_URL' : 'RUNTIME_DATABASE_URL';
    console.log(`[BOOT] Using ${source} =`, redacted);
  }
}
if (String(process.env.ALLOW_DB_MOCK || '').toLowerCase() === 'true') {
  console.warn('[BOOT] ALLOW_DB_MOCK is enabled. Endpoints may return mock success without persistence. Disable in production.');
}

// Global concise logger for troubleshooting 500s on checkout
app.use(async (req, res, next) => {
  const start = Date.now();
  const tag = `${req.method} ${req.originalUrl}`;
  res.on('finish', () => {
    if (tag.includes('/api/checkout') || tag.includes('/api/diagnostics') ) {
      console.log(`[TRACE] ${tag} -> ${res.statusCode} ${Date.now()-start}ms`);
    }
  });
  next();
});

// Temporary debug request logger (can remove after diagnosing)
app.use((req, res, next) => {
  if (req.path.startsWith('/qr/') || req.path.startsWith('/api/qr') ) {
    console.log(`[REQ] ${new Date().toISOString()} ${req.method} ${req.originalUrl} ip=${req.ip}`);
  }
  next();
});

// Health
app.get('/health', (_, res) => res.json({ ok: true }));
// Alias for clients probing /api/health
app.get('/api/health', (_, res) => res.json({ ok: true }));

// Routes
app.use('/api/menu', require('./routes/menu'));
app.use('/api/checkout', require('./routes/checkout'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/orders', require('./routes/orders_admin'));
app.use('/api/smoke', require('./routes/smoke'));
app.use('/api/sessions', require('./routes/sessions'));
app.use('/api/diagnostics', require('./routes/diagnostics'));
app.use('/api/mark-paid', require('./routes/markPaid'));

// QR routes (diagnostics & ensure-session)
try {
  const { router: qrRouter, attachScanRoute } = require('./routes/qr');
  app.use('/api/qr', qrRouter);
  attachScanRoute(app); // mounts /qr/:qrId
  console.log('QR scan & helper routes registered');
} catch (e) {
  console.error('Failed to register QR routes', e);
}

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
