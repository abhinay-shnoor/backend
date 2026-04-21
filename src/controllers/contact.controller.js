const pool = require('../config/db');

const createQuery = async (req, res) => {
  const { name, email, subject, message } = req.body;

  if (!name?.trim() || !email?.trim() || !subject?.trim() || !message?.trim()) {
    return res.status(400).json({ message: 'All fields are required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO contact_queries (name, email, subject, message)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name.trim(), email.trim(), subject.trim(), message.trim()]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('createQuery error:', err);
    res.status(500).json({ message: 'Failed to submit query' });
  }
};

const getQueries = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM contact_queries ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('getQueries error:', err);
    res.status(500).json({ message: 'Failed to fetch queries' });
  }
};

const updateQueryStatus = async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const allowed = ['unread', 'read', 'resolved'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ message: 'Invalid status value' });
  }

  try {
    const result = await pool.query(
      `UPDATE contact_queries SET status = $1 WHERE id = $2 RETURNING *`,
      [status, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Query not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('updateQueryStatus error:', err);
    res.status(500).json({ message: 'Failed to update status' });
  }
};

module.exports = { createQuery, getQueries, updateQueryStatus };