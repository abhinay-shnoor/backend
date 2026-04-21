const pool = require('../config/db');

// Returns spaces filtered by membership for regular users.
// Admins see all spaces so the admin panel works fully.
const getSpaces = async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  try {
    const query = isAdmin
      ? `
        SELECT
          s.id, s.name, s.description, s.created_at,
          COUNT(DISTINCT sm.user_id)::int AS member_count,
          u.name AS created_by_name,
          lm.content    AS last_message,
          lm.created_at AS last_message_at,
          lu.name       AS last_message_sender,
          (SELECT COUNT(*) FROM messages m LEFT JOIN user_space_reads usr ON usr.space_id = s.id AND usr.user_id = $1 WHERE m.space_id = s.id AND m.sender_id != $1 AND (usr.last_read_at IS NULL OR m.created_at > usr.last_read_at))::int AS unread
        FROM spaces s
        LEFT JOIN space_members sm ON sm.space_id = s.id
        LEFT JOIN users u  ON u.id  = s.created_by
        LEFT JOIN LATERAL (
          SELECT content, created_at, sender_id FROM messages
          WHERE space_id = s.id ORDER BY created_at DESC LIMIT 1
        ) lm ON true
        LEFT JOIN users lu ON lu.id = lm.sender_id
        GROUP BY s.id, u.name, lm.content, lm.created_at, lu.name
        ORDER BY COALESCE(lm.created_at, s.created_at) DESC
      `
      : `
        SELECT
          s.id, s.name, s.description, s.created_at,
          COUNT(DISTINCT sm.user_id)::int AS member_count,
          u.name AS created_by_name,
          lm.content    AS last_message,
          lm.created_at AS last_message_at,
          lu.name       AS last_message_sender,
          (SELECT COUNT(*) FROM messages m LEFT JOIN user_space_reads usr ON usr.space_id = s.id AND usr.user_id = $1 WHERE m.space_id = s.id AND m.sender_id != $1 AND (usr.last_read_at IS NULL OR m.created_at > usr.last_read_at))::int AS unread
        FROM spaces s
        JOIN space_members my_mem ON my_mem.space_id = s.id AND my_mem.user_id = $1
        LEFT JOIN space_members sm ON sm.space_id = s.id
        LEFT JOIN users u  ON u.id  = s.created_by
        LEFT JOIN LATERAL (
          SELECT content, created_at, sender_id FROM messages
          WHERE space_id = s.id ORDER BY created_at DESC LIMIT 1
        ) lm ON true
        LEFT JOIN users lu ON lu.id = lm.sender_id
        GROUP BY s.id, u.name, lm.content, lm.created_at, lu.name
        ORDER BY COALESCE(lm.created_at, s.created_at) DESC
      `;

    const result = await pool.query(query, [req.user.id]);
    res.json(result.rows);
  } catch (err) {
    console.error('getSpaces error:', err);
    res.status(500).json({ message: 'Failed to fetch spaces' });
  }
};

const createSpace = async (req, res) => {
  const { name, description } = req.body;
  if (!name?.trim()) return res.status(400).json({ message: 'Space name is required' });
  try {
    const result = await pool.query(
      `INSERT INTO spaces (name, description, created_by) VALUES ($1, $2, $3) RETURNING *`,
      [name.trim().toLowerCase(), description || null, req.user.id]
    );
    await pool.query(
      `INSERT INTO space_members (space_id, user_id) VALUES ($1, $2)`,
      [result.rows[0].id, req.user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ message: 'Space name already exists' });
    console.error('createSpace error:', err);
    res.status(500).json({ message: 'Failed to create space' });
  }
};

const updateDescription = async (req, res) => {
  const { id } = req.params;
  const { description } = req.body;
  try {
    const result = await pool.query(
      `UPDATE spaces SET description = $1 WHERE id = $2 RETURNING id, name, description`,
      [description || null, id]
    );
    if (!result.rows.length) return res.status(404).json({ message: 'Space not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('updateDescription error:', err);
    res.status(500).json({ message: 'Failed to update description' });
  }
};

const deleteSpace = async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM message_reactions WHERE message_id IN (SELECT id FROM messages WHERE space_id = $1)`, [id]);
    await client.query(`DELETE FROM messages WHERE space_id = $1`, [id]);
    await client.query(`DELETE FROM space_members WHERE space_id = $1`, [id]);
    await client.query(`DELETE FROM user_space_reads WHERE space_id = $1`, [id]);
    await client.query(`DELETE FROM spaces WHERE id = $1`, [id]);
    await client.query('COMMIT');
    res.json({ message: 'Space deleted' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('deleteSpace error:', err);
    res.status(500).json({ message: 'Failed to delete space' });
  } finally {
    client.release();
  }
};

const addMember = async (req, res) => {
  const { id: spaceId } = req.params;
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: 'Email is required' });
  try {
    const userResult = await pool.query(
      `SELECT id, name, email FROM users WHERE email = $1 AND is_active = true`,
      [email.toLowerCase()]
    );
    if (!userResult.rows.length) return res.status(404).json({ message: 'User not found. They must log in once first.' });
    const user = userResult.rows[0];
    await pool.query(
      `INSERT INTO space_members (space_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [spaceId, user.id]
    );
    res.json({ message: `${user.name} added`, user });
  } catch (err) {
    console.error('addMember error:', err);
    res.status(500).json({ message: 'Failed to add member' });
  }
};

const removeMember = async (req, res) => {
  const { id: spaceId, userId } = req.params;
  try {
    await pool.query(`DELETE FROM space_members WHERE space_id = $1 AND user_id = $2`, [spaceId, userId]);
    res.json({ message: 'Member removed' });
  } catch (err) {
    console.error('removeMember error:', err);
    res.status(500).json({ message: 'Failed to remove member' });
  }
};

const getSpaceMembers = async (req, res) => {
  const { id: spaceId } = req.params;
  try {
    const result = await pool.query(`
      SELECT u.id, u.name, u.email, u.avatar_url, u.role, sm.joined_at
      FROM space_members sm JOIN users u ON u.id = sm.user_id
      WHERE sm.space_id = $1 ORDER BY sm.joined_at ASC
    `, [spaceId]);
    res.json(result.rows);
  } catch (err) {
    console.error('getSpaceMembers error:', err);
    res.status(500).json({ message: 'Failed to fetch members' });
  }
};

module.exports = { getSpaces, createSpace, updateDescription, deleteSpace, addMember, removeMember, getSpaceMembers };