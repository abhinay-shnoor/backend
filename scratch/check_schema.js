const pool = require('../src/config/db');

async function check() {
  try {
    const msgs = await pool.query(`
      SELECT id, content, attachments, pg_typeof(attachments) as type
      FROM messages 
      WHERE attachments::text LIKE '%cloudinary%'
      ORDER BY created_at DESC 
      LIMIT 1
    `);
    console.log('Latest Cloudinary message:', JSON.stringify(msgs.rows, null, 2));
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

check();
