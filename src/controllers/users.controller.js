const pool = require('../config/db');
const { uploadBuffer } = require('../config/cloudinary');
const { uploadSingleAvatar, saveFileToStorage } = require('../config/storage');

exports.avatarUploadMiddleware = uploadSingleAvatar;

exports.getUsers = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id,name,email,avatar_url,role,is_active,created_at FROM users WHERE is_active=true ORDER BY name ASC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('getUsers error:', err);
    res.status(500).json({ message: 'Failed to fetch users' });
  }
};

exports.getAllUsersAdmin = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id,name,email,avatar_url,role,is_active,created_at FROM users ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('getAllUsersAdmin error:', err);
    res.status(500).json({ message: 'Failed to fetch users' });
  }
};

exports.getMe = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id,name,email,avatar_url,role,is_active,preferences,created_at FROM users WHERE id=$1`,
      [req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ message: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('getMe error:', err);
    res.status(500).json({ message: 'Failed to fetch profile' });
  }
};

exports.updateMe = async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ message: 'Name cannot be empty' });
  if (name.trim().length < 2) return res.status(400).json({ message: 'Name must be at least 2 characters' });
  try {
    const result = await pool.query(
      `UPDATE users SET name=$1 WHERE id=$2 RETURNING id,name,email,avatar_url,role`,
      [name.trim(), req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('updateMe error:', err);
    res.status(500).json({ message: 'Failed to update profile' });
  }
};

// Old base64 avatar endpoint — kept for backwards compatibility but new
// code uses the Cloudinary upload endpoint below
exports.updateAvatar = async (req, res) => {
  const { avatar } = req.body;
  if (!avatar) return res.status(400).json({ message: 'Avatar data is required' });
  if (!avatar.startsWith('data:image/')) return res.status(400).json({ message: 'Invalid image format' });
  try {
    const result = await pool.query(
      `UPDATE users SET avatar_url=$1 WHERE id=$2 RETURNING id,name,email,avatar_url,role`,
      [avatar, req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('updateAvatar error:', err);
    res.status(500).json({ message: 'Failed to update avatar' });
  }
};

// Upload avatar to appropriate storage (S3 or local)
exports.uploadAvatarToCloud = async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file provided' });
  try {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const fileData = await saveFileToStorage(req.file, baseUrl, 'avatars');
    
    const dbResult = await pool.query(
      `UPDATE users SET avatar_url=$1 WHERE id=$2 RETURNING id,name,email,avatar_url,role`,
      [fileData.url, req.user.id]
    );
    res.json(dbResult.rows[0]);
  } catch (err) {
    console.error('uploadAvatarToCloud error:', err);
    res.status(500).json({ message: 'Failed to upload avatar' });
  }
};

exports.getPreferences = async (req, res) => {
  try {
    const result = await pool.query(`SELECT preferences FROM users WHERE id=$1`, [req.user.id]);
    res.json(result.rows[0]?.preferences || {});
  } catch (err) {
    console.error('getPreferences error:', err);
    res.status(500).json({ message: 'Failed to get preferences' });
  }
};

exports.updatePreferences = async (req, res) => {
  const { preferences } = req.body;
  if (typeof preferences !== 'object') return res.status(400).json({ message: 'preferences must be an object' });
  try {
    // Merge with existing preferences rather than overwriting completely
    const result = await pool.query(
      `UPDATE users SET preferences = preferences || $1 WHERE id=$2 RETURNING preferences`,
      [JSON.stringify(preferences), req.user.id]
    );
    res.json(result.rows[0].preferences);
  } catch (err) {
    console.error('updatePreferences error:', err);
    res.status(500).json({ message: 'Failed to update preferences' });
  }
};

exports.updateUserRole = async (req, res) => {
  const { id }   = req.params;
  const { role } = req.body;
  if (!['admin', 'member'].includes(role)) return res.status(400).json({ message: 'Role must be admin or member' });
  try {
    const result = await pool.query(
      `UPDATE users SET role=$1 WHERE id=$2 RETURNING id,name,email,role,is_active`,
      [role, id]
    );
    if (!result.rows.length) return res.status(404).json({ message: 'User not found' });
    req.app.get('io').to(`user:${id}`).emit('user:role_changed', { role });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('updateUserRole error:', err);
    res.status(500).json({ message: 'Failed to update role' });
  }
};

exports.updateUserStatus = async (req, res) => {
  const { id }        = req.params;
  const { is_active } = req.body;
  if (typeof is_active !== 'boolean') return res.status(400).json({ message: 'is_active must be boolean' });
  try {
    const result = await pool.query(
      `UPDATE users SET is_active=$1 WHERE id=$2 RETURNING id,name,email,role,is_active`,
      [is_active, id]
    );
    if (!result.rows.length) return res.status(404).json({ message: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('updateUserStatus error:', err);
    res.status(500).json({ message: 'Failed to update status' });
  }
};