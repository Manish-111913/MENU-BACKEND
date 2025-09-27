const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Robust .env loader: search upward so that running files from nested folders still finds root .env
function loadEnv() {
  const tried = [];
  let dir = __dirname;
  for (let i = 0; i < 5; i++) { // climb a few levels at most
    const candidate = path.join(dir, '..'.repeat(i), '.env');
    if (!tried.includes(candidate)) tried.push(candidate);
    if (fs.existsSync(candidate)) {
      require('dotenv').config({ path: candidate });
      return { found: candidate, tried };
    }
  }
  // Fallback to current working directory if not already included
  const cwdEnv = path.join(process.cwd(), '.env');
  if (!tried.includes(cwdEnv)) {
    tried.push(cwdEnv);
    if (fs.existsSync(cwdEnv)) {
      require('dotenv').config({ path: cwdEnv });
      return { found: cwdEnv, tried };
    }
  }
  return { found: null, tried };
}

const envLoadInfo = loadEnv();

if (!process.env.DATABASE_URL) {
  console.warn('DATABASE_URL not set. DB-backed routes will be disabled.', envLoadInfo);
}

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function withTenant(client, businessId) {
  if (!businessId) return;
  await client.query("SELECT set_config('app.current_tenant', $1, true)", [String(businessId)]);
}

module.exports = { pool, withTenant };
