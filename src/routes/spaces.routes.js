const router = require('express').Router();
const { requireAuth, requireAdmin } = require('../middleware/auth.middleware');
const { getSpaces, createSpace, updateDescription, deleteSpace, addMember, removeMember, getSpaceMembers } = require('../controllers/spaces.controller');

router.get('/',                          requireAuth,               getSpaces);
router.post('/',                         requireAuth, requireAdmin, createSpace);
router.patch('/:id/description',         requireAuth, requireAdmin, updateDescription);
router.delete('/:id',                    requireAuth, requireAdmin, deleteSpace);
router.get('/:id/members',              requireAuth,               getSpaceMembers);
router.post('/:id/members',             requireAuth, requireAdmin, addMember);
router.delete('/:id/members/:userId',   requireAuth, requireAdmin, removeMember);

module.exports = router;