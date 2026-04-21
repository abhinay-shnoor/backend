const router = require('express').Router();
const { requireAuth } = require('../middleware/auth.middleware');
const { getTasks, createTask, updateTask, deleteTask } = require('../controllers/calendar.controller');

router.get('/tasks',        requireAuth, getTasks);
router.post('/tasks',       requireAuth, createTask);
router.patch('/tasks/:id',  requireAuth, updateTask);
router.delete('/tasks/:id', requireAuth, deleteTask);

module.exports = router;
