const router = require('express').Router();
const { requireAuth, requireAdmin } = require('../middleware/auth.middleware');
const { createQuery, getQueries, updateQueryStatus } = require('../controllers/contact.controller');

// Public — anyone can submit a contact form
router.post('/', createQuery);

// Admin only
router.get('/', requireAdmin, getQueries);
router.patch('/:id/status', requireAdmin, updateQueryStatus);

module.exports = router;