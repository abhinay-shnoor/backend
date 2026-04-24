const pool = require('../src/config/db');

async function check() {
  try {
    const table = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'messages' AND column_name = 'attachments'
    `);
    console.log('Attachments column info:', table.rows);
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

check();
