const pool = require('../src/config/db');

// Mocking the select and group by from controller
const MSG_SELECT = `
  SELECT
    m.id,
    m.content,
    m.created_at,
    m.updated_at,
    m.is_edited,
    m.sender_id,
    m.parent_message_id,
    m.attachments,
    m.is_forwarded,
    u.name          AS sender_name,
    u.avatar_url,
    u.email         AS sender_email,
    pm.content      AS parent_content,
    pu.name         AS parent_sender_name,
    (SELECT COUNT(*) FROM messages r WHERE r.parent_message_id = m.id)::int AS reply_count,
    COALESCE(
      json_agg(
        json_build_object('emoji', mr.emoji, 'userId', mr.user_id, 'userName', ru.name)
      ) FILTER (WHERE mr.id IS NOT NULL),
      '[]'::json
    ) AS reactions
  FROM messages m
  JOIN  users u  ON u.id  = m.sender_id
  LEFT JOIN messages pm ON pm.id = m.parent_message_id
  LEFT JOIN users    pu ON pu.id = pm.sender_id
  LEFT JOIN message_reactions mr ON mr.message_id = m.id
  LEFT JOIN users ru ON ru.id = mr.user_id
`;

async function check() {
  try {
    const lastId = await pool.query("SELECT id FROM messages WHERE attachments IS NOT NULL AND attachments != '[]'::jsonb ORDER BY created_at DESC LIMIT 1");
    if (!lastId.rows.length) {
       console.log("No messages with attachments found");
       return;
    }
    const id = lastId.rows[0].id;
    console.log("Testing with message ID:", id);

    const result = await pool.query(
      `${MSG_SELECT} WHERE m.id = $1 GROUP BY m.id, u.name, u.avatar_url, u.email, pm.content, pu.name`,
      [id]
    );
    console.log('Result attachments:', result.rows[0].attachments);
    console.log('Type of attachments:', typeof result.rows[0].attachments);
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

check();
