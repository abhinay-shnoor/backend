const pool = require('./src/config/db');

async function migrate() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS starred_messages (
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
          PRIMARY KEY (user_id, message_id)
      );
    `);
    console.log('Migration successful: starred_messages table created.');
  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    process.exit(0);
  }
}

migrate();
