const pool = require('../src/config/db');

async function migrate() {
  try {
    console.log('Starting migration to TIMESTAMPTZ...');
    
    // 1. Alter message_receipts column
    await pool.query(`
      ALTER TABLE message_receipts 
      ALTER COLUMN delivered_at TYPE TIMESTAMPTZ USING delivered_at AT TIME ZONE 'UTC',
      ALTER COLUMN seen_at TYPE TIMESTAMPTZ USING seen_at AT TIME ZONE 'UTC';
    `);
    
    // 2. Also ensure messages table uses TIMESTAMPTZ if it doesn't
    await pool.query(`
      ALTER TABLE messages 
      ALTER COLUMN created_at TYPE TIMESTAMPTZ,
      ALTER COLUMN updated_at TYPE TIMESTAMPTZ;
    `);

    console.log('Migration successful: Columns converted to TIMESTAMPTZ.');
  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    process.exit(0);
  }
}

migrate();
