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
        ALTER TABLE users ADD COLUMN IF NOT EXISTS pin VARCHAR(255);
        ALTER TABLE users ADD COLUMN IF NOT EXISTS contact_no VARCHAR(50);
        ALTER TABLE users ADD COLUMN IF NOT EXISTS alternate_email VARCHAR(255);
        ALTER TABLE users ADD COLUMN IF NOT EXISTS department VARCHAR(100);
        ALTER TABLE users ADD COLUMN IF NOT EXISTS designation VARCHAR(100);
      `);
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
      await pool.query(`
        ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN DEFAULT FALSE;
        ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_system BOOLEAN DEFAULT FALSE;
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS archived_chats (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          chat_id INTEGER NOT NULL,
          chat_type VARCHAR(10) NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(user_id, chat_id, chat_type)
        );
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS locked_chats (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          chat_id INTEGER NOT NULL,
          chat_type VARCHAR(10) NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(user_id, chat_id, chat_type)
        );
      `);
      console.log('Starred/Hide/Lock tables initialized successfully');
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