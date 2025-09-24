require('dotenv').config();
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn('DATABASE_URL not set. DB-backed routes will be disabled.');
}

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function withTenant(client, businessId) {
  if (!businessId) return;
  await client.query("SELECT set_config('app.current_tenant', $1, true)", [String(businessId)]);
}

module.exports = { pool, withTenant };
