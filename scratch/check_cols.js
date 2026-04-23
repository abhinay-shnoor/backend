const pool = require('../src/config/db');
pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'messages'")
  .then(r => {
    console.log(JSON.stringify(r.rows.map(c => c.column_name)));
    process.exit(0);
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
