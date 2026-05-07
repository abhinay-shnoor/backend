const pool = require('../config/db');
const { uploadBuffer } = require('../config/cloudinary');
const { uploadSingleAvatar, saveFileToStorage } = require('../config/storage');
const fs = require('fs');

exports.avatarUploadMiddleware = uploadSingleAvatar;

exports.getUsers = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id,name,email,avatar_url,role,is_active,created_at,contact_no,alternate_email,department,designation FROM users WHERE is_active=true ORDER BY name ASC`
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
      `SELECT id,name,email,avatar_url,role,is_active,created_at,contact_no,alternate_email,department,designation FROM users ORDER BY created_at DESC`
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
      `SELECT id,name,email,avatar_url,role,is_active,preferences,pin,created_at,contact_no,alternate_email,department,designation FROM users WHERE id=$1`,
      [req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ message: 'User not found' });
    const user = result.rows[0];
    res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      avatar_url: user.avatar_url,
      role: user.role,
      is_active: user.is_active,
      preferences: user.preferences,
      hasPin: !!user.pin,
      created_at: user.created_at,
      contact_no: user.contact_no,
      alternate_email: user.alternate_email,
      department: user.department,
      designation: user.designation
    });
  } catch (err) {
    console.error('getMe error:', err);
    res.status(500).json({ message: 'Failed to fetch profile' });
  }
};

exports.updateMe = async (req, res) => {
  const { name, contact_no, alternate_email, department, designation } = req.body;
  if (!name?.trim()) return res.status(400).json({ message: 'Name cannot be empty' });
  if (name.trim().length < 2) return res.status(400).json({ message: 'Name must be at least 2 characters' });
  try {
    const result = await pool.query(
      `UPDATE users SET name=$1, contact_no=$2, alternate_email=$3, department=$4, designation=$5 WHERE id=$6 RETURNING id,name,email,avatar_url,role,contact_no,alternate_email,department,designation`,
      [name.trim(), contact_no || null, alternate_email || null, department || null, designation || null, req.user.id]
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

exports.uploadAvatarToCloud = async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file provided' });
  try {
    let avatarUrl;

    // On Render (ephemeral filesystem) or if Cloudinary is configured, always use Cloudinary for persistence
    if (process.env.RENDER || process.env.CLOUDINARY_CLOUD_NAME) {
      const buffer = req.file.buffer || fs.readFileSync(req.file.path);
      const result = await uploadBuffer(buffer, {
        folder: 'avatars',
        resource_type: 'image',
        access_mode: 'public'
      });
      avatarUrl = result.secure_url;

      // Clean up temp local file if multer wrote to disk
      if (req.file.path && fs.existsSync(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch (_) {}
      }
    } else {
      // Non-Cloudinary/Local fallback
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const fileData = await saveFileToStorage(req.file, baseUrl, 'avatars');
      avatarUrl = fileData.url;
    }

    const dbResult = await pool.query(
      `UPDATE users SET avatar_url=$1 WHERE id=$2 RETURNING id,name,email,avatar_url,role`,
      [avatarUrl, req.user.id]
    );
    res.json(dbResult.rows[0]);
  } catch (err) {
    console.error('uploadAvatarToCloud error:', err);
    res.status(500).json({ message: 'Failed to upload avatar: ' + (err.message || 'Unknown error') });
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

exports.getArchivedChats = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT chat_id, chat_type FROM archived_chats WHERE user_id=$1`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('getArchivedChats error:', err);
    res.status(500).json({ message: 'Failed to fetch archived chats' });
  }
};

exports.archiveChat = async (req, res) => {
  const { chat_id, chat_type } = req.body;
  if (!chat_id || !['space', 'dm'].includes(chat_type)) {
    return res.status(400).json({ message: 'Valid chat_id and chat_type are required' });
  }
  try {
    await pool.query(
      `INSERT INTO archived_chats (user_id, chat_id, chat_type) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [req.user.id, chat_id, chat_type]
    );
    res.json({ message: 'Chat archived successfully' });
  } catch (err) {
    console.error('archiveChat error:', err);
    res.status(500).json({ message: 'Failed to archive chat' });
  }
};

exports.unarchiveChat = async (req, res) => {
  const { id: chat_id, type: chat_type } = req.params;
  try {
    await pool.query(
      `DELETE FROM archived_chats WHERE user_id=$1 AND chat_id=$2 AND chat_type=$3`,
      [req.user.id, chat_id, chat_type]
    );
    res.json({ message: 'Chat unarchived successfully' });
  } catch (err) {
    console.error('unarchiveChat error:', err);
    res.status(500).json({ message: 'Failed to unarchive chat' });
  }
};

const crypto = require('crypto');

function hashPin(pin) {
  return crypto.createHash('sha256').update(pin).digest('hex');
}

exports.setPin = async (req, res) => {
  const { pin } = req.body;
  if (!pin || typeof pin !== 'string' || pin.trim().length < 4) {
    return res.status(400).json({ message: 'PIN must be at least 4 characters' });
  }
  try {
    const hashed = hashPin(pin.trim());
    await pool.query(
      `UPDATE users SET pin=$1 WHERE id=$2`,
      [hashed, req.user.id]
    );
    if (req.user) {
      req.user.pin = hashed;
    }
    res.json({ success: true, message: 'PIN set successfully' });
  } catch (err) {
    console.error('setPin error:', err);
    res.status(500).json({ message: 'Failed to set PIN' });
  }
};

exports.verifyPin = async (req, res) => {
  const { pin } = req.body;
  if (!pin) {
    return res.status(400).json({ message: 'PIN is required' });
  }
  try {
    const userResult = await pool.query(
      `SELECT pin FROM users WHERE id=$1`,
      [req.user.id]
    );
    if (!userResult.rows.length) {
      return res.status(404).json({ message: 'User not found' });
    }
    const storedHashed = userResult.rows[0].pin;
    if (!storedHashed) {
      return res.status(400).json({ message: 'No PIN is set for this user' });
    }
    const incomingHashed = hashPin(pin.trim());
    if (storedHashed === incomingHashed) {
      res.json({ success: true });
    } else {
      res.json({ success: false, message: 'Incorrect PIN' });
    }
  } catch (err) {
    console.error('verifyPin error:', err);
    res.status(500).json({ message: 'Failed to verify PIN' });
  }
};

exports.getLockedChats = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT chat_id, chat_type FROM locked_chats WHERE user_id=$1`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('getLockedChats error:', err);
    res.status(500).json({ message: 'Failed to fetch locked chats' });
  }
};

exports.lockChat = async (req, res) => {
  const { chat_id, chat_type } = req.body;
  if (!chat_id || !['space', 'dm'].includes(chat_type)) {
    return res.status(400).json({ message: 'Valid chat_id and chat_type are required' });
  }
  try {
    await pool.query(
      `INSERT INTO locked_chats (user_id, chat_id, chat_type) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [req.user.id, chat_id, chat_type]
    );
    res.json({ message: 'Chat locked successfully' });
  } catch (err) {
    console.error('lockChat error:', err);
    res.status(500).json({ message: 'Failed to lock chat' });
  }
};

exports.unlockChat = async (req, res) => {
  const { id: chat_id, type: chat_type } = req.params;
  try {
    await pool.query(
      `DELETE FROM locked_chats WHERE user_id=$1 AND chat_id=$2 AND chat_type=$3`,
      [req.user.id, chat_id, chat_type]
    );
    res.json({ message: 'Chat unlocked successfully' });
  } catch (err) {
    console.error('unlockChat error:', err);
    res.status(500).json({ message: 'Failed to unlock chat' });
  }
};