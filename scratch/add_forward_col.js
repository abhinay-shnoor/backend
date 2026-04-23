const pool = require('../src/config/db');
async function migrate() {
  try {
    await pool.query("ALTER TABLE messages ADD COLUMN is_forwarded BOOLEAN DEFAULT FALSE");
    console.log("Column is_forwarded added successfully");
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
migrate();
