const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // Required for many cloud DBs like Neon/Render
  }
});

// Test connection once on startup and initialize tables
pool.query('SELECT NOW()', async (err) => {
  if (err) {
    console.error('Initial database connection failed:', err);
  } else {
    console.log('Database connection established successfully');
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS starred_messages (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(user_id, message_id)
        );
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS message_hides (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(user_id, message_id)
        );
      `);
      console.log('Starred/Hide tables initialized successfully');
    } catch (tableErr) {
      console.error('Failed to initialize database tables:', tableErr);
    }
  }
});

pool.on('error', (err) => {
  console.error('Unexpected database error', err);
  process.exit(-1);
});

module.exports = pool;