const pool = require('../config/db');

// GET /api/calendar/tasks — all tasks for the logged-in user
const getTasks = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, title, description,
              TO_CHAR(task_date, 'YYYY-MM-DD') AS date,
              TO_CHAR(task_time, 'HH24:MI') AS time,
              completed, created_at
       FROM calendar_tasks
       WHERE user_id = $1
       ORDER BY task_date ASC, task_time ASC NULLS LAST`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('getTasks error:', err);
    res.status(500).json({ message: 'Failed to fetch tasks' });
  }
};

// POST /api/calendar/tasks — create a new task
const createTask = async (req, res) => {
  const { title, description, date, time } = req.body;
  if (!title) return res.status(400).json({ message: 'Title is required' });

  try {
    const result = await pool.query(
      `INSERT INTO calendar_tasks (user_id, title, description, task_date, task_time, completed)
       VALUES ($1, $2, $3, $4, $5, false)
       RETURNING id, title, description,
                 TO_CHAR(task_date, 'YYYY-MM-DD') AS date,
                 TO_CHAR(task_time, 'HH24:MI')    AS time,
                 completed, created_at`,
      [req.user.id, title.trim(), description || null, date || null, time || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('createTask error:', err);
    res.status(500).json({ message: 'Failed to create task' });
  }
};

// PATCH /api/calendar/tasks/:id — toggle completed or update fields
const updateTask = async (req, res) => {
  const { id } = req.params;
  const { completed, title, description, date, time } = req.body;

  try {
    // Only update the task if it belongs to this user
    const result = await pool.query(
      `UPDATE calendar_tasks
       SET
         completed   = COALESCE($1, completed),
         title       = COALESCE($2, title),
         description = COALESCE($3, description),
         task_date   = COALESCE($4, task_date),
         task_time   = COALESCE($5, task_time),
         updated_at  = NOW()
       WHERE id = $6 AND user_id = $7
       RETURNING id, title, description,
                 TO_CHAR(task_date, 'YYYY-MM-DD') AS date,
                 TO_CHAR(task_time, 'HH24:MI')    AS time,
                 completed, created_at`,
      [completed ?? null, title ?? null, description ?? null, date ?? null, time ?? null, id, req.user.id]
    );

    if (result.rowCount === 0) return res.status(404).json({ message: 'Task not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('updateTask error:', err);
    res.status(500).json({ message: 'Failed to update task' });
  }
};

// DELETE /api/calendar/tasks/:id
const deleteTask = async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      'DELETE FROM calendar_tasks WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ message: 'Task not found' });
    res.json({ message: 'Task deleted' });
  } catch (err) {
    console.error('deleteTask error:', err);
    res.status(500).json({ message: 'Failed to delete task' });
  }
};

module.exports = { getTasks, createTask, updateTask, deleteTask };
