const pool = require('./src/config/db');

async function migrate() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS message_receipts (
          message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          delivered_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
          seen_at TIMESTAMP WITHOUT TIME ZONE,
          PRIMARY KEY (message_id, user_id)
      );
    `);
    console.log('Migration successful: message_receipts table created.');
  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    process.exit(0);
  }
}

migrate();
