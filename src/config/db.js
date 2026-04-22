const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // Required for many cloud DBs like Neon/Render
  }
});

// Test connection once on startup
pool.query('SELECT NOW()', (err) => {
  if (err) {
    console.error('Initial database connection failed:', err);
  } else {
    console.log('Database connection established successfully');
  }
});

pool.on('error', (err) => {
  console.error('Unexpected database error', err);
  process.exit(-1);
});

module.exports = pool;