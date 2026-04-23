const pool = require('../config/db');
const xss  = require('xss');
const { uploadBuffer } = require('../config/cloudinary');
const multer = require('multer');

// Multer config — keep files in memory, pass buffer to Cloudinary
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});
exports.uploadMiddleware = upload.single('file');

// Base SELECT used by every message fetch — returns reactions, parent info,
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
    -- Parent message preview for threaded replies
    pm.content      AS parent_content,
    pu.name         AS parent_sender_name,
    -- How many replies this message has received
    (SELECT COUNT(*) FROM messages r WHERE r.parent_message_id = m.id)::int AS reply_count,
    COALESCE(
      json_agg(
        json_build_object('emoji', mr.emoji, 'userId', mr.user_id, 'userName', ru.name)
      ) FILTER (WHERE mr.id IS NOT NULL),
      '[]'::json
    ) AS reactions,
    COALESCE(
      (SELECT json_agg(json_build_object('userId', user_id, 'deliveredAt', delivered_at, 'seenAt', seen_at))
       FROM message_receipts WHERE message_id = m.id),
      '[]'::json
    ) AS receipts
  FROM messages m
  JOIN  users u  ON u.id  = m.sender_id
  LEFT JOIN messages pm ON pm.id = m.parent_message_id
  LEFT JOIN users    pu ON pu.id = pm.sender_id
  LEFT JOIN message_reactions mr ON mr.message_id = m.id
  LEFT JOIN users ru ON ru.id = mr.user_id
  LEFT JOIN message_hides mh ON mh.message_id = m.id AND mh.user_id = $1
`;

const fetchById = (id, userId) =>
  pool.query(
    `${MSG_SELECT} WHERE mh.message_id IS NULL AND m.id = $2 GROUP BY m.id, u.name, u.avatar_url, u.email, pm.content, pu.name`,
    [userId, id]
  );

// Upload a file to Cloudinary and return its public URL
exports.uploadAttachment = async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file provided' });
  try {
    const result = await uploadBuffer(req.file.buffer, {
      public_id: `${Date.now()}-${req.file.originalname.replace(/\s+/g, '_')}`,
    });
    res.json({
      url:  result.secure_url,
      name: req.file.originalname,
      type: req.file.mimetype,
      size: req.file.size,
    });
  } catch (err) {
    console.error('uploadAttachment error:', err);
    res.status(500).json({ message: 'File upload failed' });
  }
};

exports.getSpaceMessages = async (req, res) => {
  const { id: spaceId } = req.params;
  const limit  = Math.min(parseInt(req.query.limit) || 50, 100);
  const before = req.query.before;

  try {
    let query, params;
    if (before) {
      query = `SELECT * FROM (${MSG_SELECT} WHERE mh.message_id IS NULL AND m.space_id=$2 AND m.created_at<$3 AND m.parent_message_id IS NULL GROUP BY m.id,u.name,u.avatar_url,u.email,pm.content,pu.name ORDER BY m.created_at DESC LIMIT $4) sub ORDER BY created_at ASC`;
      params = [req.user.id, spaceId, before, limit];
    } else {
      query = `SELECT * FROM (${MSG_SELECT} WHERE mh.message_id IS NULL AND m.space_id=$2 AND m.parent_message_id IS NULL GROUP BY m.id,u.name,u.avatar_url,u.email,pm.content,pu.name ORDER BY m.created_at DESC LIMIT $3) sub ORDER BY created_at ASC`;
      params = [req.user.id, spaceId, limit];
    }
    const result      = await pool.query(query, params);
    const countResult = await pool.query(`SELECT COUNT(*) FROM messages WHERE space_id=$1 AND parent_message_id IS NULL`, [spaceId]);
    const total       = parseInt(countResult.rows[0].count);
    res.json({ messages: result.rows, total, hasMore: result.rows.length === limit && total > limit });
  } catch (err) {
    console.error('getSpaceMessages error:', err);
    res.status(500).json({ message: 'Failed to fetch messages' });
  }
};

exports.getThreadReplies = async (req, res) => {
  const { msgId } = req.params;
  try {
    const result = await pool.query(
      `${MSG_SELECT} WHERE mh.message_id IS NULL AND m.parent_message_id=$2 GROUP BY m.id,u.name,u.avatar_url,u.email,pm.content,pu.name ORDER BY m.created_at ASC`,
      [req.user.id, msgId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('getThreadReplies error:', err);
    res.status(500).json({ message: 'Failed to fetch thread' });
  }
};

exports.sendSpaceMessage = async (req, res) => {
  const { id: spaceId } = req.params;
  const { content, parent_message_id, attachments, is_forwarded } = req.body;

  if (!content?.trim() && (!attachments || !attachments.length)) {
    return res.status(400).json({ message: 'Message cannot be empty' });
  }

  const clean = content ? xss(content.trim()) : '';
  try {
    const ins = await pool.query(
      `INSERT INTO messages (content, sender_id, space_id, parent_message_id, attachments, is_forwarded)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [clean, req.user.id, spaceId, parent_message_id || null, JSON.stringify(attachments || []), is_forwarded || false]
    );
    const result  = await fetchById(ins.rows[0].id, req.user.id);
    const message = { ...result.rows[0], space_id: spaceId };
    req.app.get('io').to(`space:${spaceId}`).emit('new_message', message);
    res.status(201).json(message);
  } catch (err) {
    console.error('sendSpaceMessage error:', err);
    res.status(500).json({ message: 'Failed to send message' });
  }
};

exports.editSpaceMessage = async (req, res) => {
  const { id: spaceId, msgId } = req.params;
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ message: 'Content cannot be empty' });
  const clean = xss(content.trim());
  try {
    // Single atomic UPDATE — checks ownership + edits in one query, no fetchById needed
    const result = await pool.query(
      `UPDATE messages
       SET content = $1, is_edited = true, updated_at = NOW()
       WHERE id = $2 AND space_id = $3 AND sender_id = $4
       RETURNING id, content, is_edited, updated_at, sender_id`,
      [clean, msgId, spaceId, req.user.id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ message: 'Message not found or permission denied' });
    }
    const fullMessageResult = await fetchById(msgId, req.user.id);
    const message = { ...fullMessageResult.rows[0], space_id: spaceId };
    req.app.get('io').to(`space:${spaceId}`).emit('message:edited', message);
    res.json(message);
  } catch (err) {
    console.error('editSpaceMessage error:', err);
    res.status(500).json({ message: 'Failed to edit message' });
  }
};

exports.deleteSpaceMessage = async (req, res) => {
  const { id: spaceId, msgId } = req.params;
  try {
    const check = await pool.query(`SELECT sender_id FROM messages WHERE id=$1 AND space_id=$2`, [msgId, spaceId]);
    if (!check.rows.length) return res.status(404).json({ message: 'Message not found' });
    if (check.rows[0].sender_id !== req.user.id) return res.status(403).json({ message: 'You can only delete your own messages' });
    await pool.query(`DELETE FROM messages WHERE id=$1`, [msgId]);
    req.app.get('io').to(`space:${spaceId}`).emit('message:deleted', { messageId: msgId, spaceId });
    res.json({ messageId: msgId });
  } catch (err) {
    console.error('deleteSpaceMessage error:', err);
    res.status(500).json({ message: 'Failed to delete message' });
  }
};

exports.addReaction = async (req, res) => {
  const { msgId } = req.params;
  const { emoji } = req.body;
  if (!emoji) return res.status(400).json({ message: 'Emoji is required' });
  try {
    await pool.query(
      `INSERT INTO message_reactions (message_id,user_id,emoji) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [msgId, req.user.id, emoji]
    );
    const reactions = await pool.query(
      `SELECT mr.emoji, mr.user_id AS "userId", u.name AS "userName" FROM message_reactions mr JOIN users u ON u.id=mr.user_id WHERE mr.message_id=$1`,
      [msgId]
    );
    const msgInfo = await pool.query(`SELECT space_id,conversation_id FROM messages WHERE id=$1`, [msgId]);
    const io      = req.app.get('io');
    const payload = { messageId: msgId, reactions: reactions.rows };
    if (msgInfo.rows[0]?.space_id) io.to(`space:${msgInfo.rows[0].space_id}`).emit('reaction:updated', payload);
    else if (msgInfo.rows[0]?.conversation_id) io.to(`dm:${msgInfo.rows[0].conversation_id}`).emit('reaction:updated', payload);
    res.json(payload);
  } catch (err) {
    console.error('addReaction error:', err);
    res.status(500).json({ message: 'Failed to add reaction' });
  }
};

exports.removeReaction = async (req, res) => {
  const { msgId } = req.params;
  const { emoji } = req.body;
  if (!emoji) return res.status(400).json({ message: 'Emoji is required' });
  try {
    await pool.query(`DELETE FROM message_reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3`, [msgId, req.user.id, emoji]);
    const reactions = await pool.query(
      `SELECT mr.emoji, mr.user_id AS "userId", u.name AS "userName" FROM message_reactions mr JOIN users u ON u.id=mr.user_id WHERE mr.message_id=$1`,
      [msgId]
    );
    const msgInfo = await pool.query(`SELECT space_id,conversation_id FROM messages WHERE id=$1`, [msgId]);
    const io      = req.app.get('io');
    const payload = { messageId: msgId, reactions: reactions.rows };
    if (msgInfo.rows[0]?.space_id) io.to(`space:${msgInfo.rows[0].space_id}`).emit('reaction:updated', payload);
    else if (msgInfo.rows[0]?.conversation_id) io.to(`dm:${msgInfo.rows[0].conversation_id}`).emit('reaction:updated', payload);
    res.json(payload);
  } catch (err) {
    console.error('removeReaction error:', err);
    res.status(500).json({ message: 'Failed to remove reaction' });
  }
};

exports.searchMessages = async (req, res) => {
  const { q, spaceId, conversationId } = req.query;
  const currentUserId = req.user.id;
  if (!q?.trim() || q.trim().length < 2) return res.status(400).json({ message: 'Query must be at least 2 characters' });

  try {
    let sql = `
      SELECT m.id, m.content, m.created_at, u.name AS sender_name, u.avatar_url,
             s.name AS space_name, s.id AS space_id,
             m.conversation_id,
             CASE WHEN m.space_id IS NOT NULL THEN 'space' ELSE 'dm' END as chat_type,
             CASE 
               WHEN m.conversation_id IS NOT NULL THEN (
                 SELECT u2.name FROM direct_conversations dc2
                 JOIN users u2 ON (u2.id = dc2.user_one_id OR u2.id = dc2.user_two_id) AND u2.id != $2
                 WHERE dc2.id = m.conversation_id LIMIT 1
               ) ELSE NULL 
             END as dm_partner_name,
             CASE 
               WHEN m.conversation_id IS NOT NULL THEN (
                 SELECT u2.id FROM direct_conversations dc2
                 JOIN users u2 ON (u2.id = dc2.user_one_id OR u2.id = dc2.user_two_id) AND u2.id != $2
                 WHERE dc2.id = m.conversation_id LIMIT 1
               ) ELSE NULL 
             END as dm_partner_id
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      LEFT JOIN spaces s ON s.id = m.space_id
      LEFT JOIN direct_conversations dc ON dc.id = m.conversation_id
      WHERE m.content ILIKE $1
      AND (
        (m.space_id IS NOT NULL AND EXISTS (SELECT 1 FROM space_members sm WHERE sm.space_id = m.space_id AND sm.user_id = $2))
        OR 
        (m.conversation_id IS NOT NULL AND (dc.user_one_id = $2 OR dc.user_two_id = $2))
      )
    `;

    const params = [`%${q.trim()}%`, currentUserId];

    if (spaceId) {
      sql += ` AND m.space_id = $3`;
      params.push(spaceId);
    } else if (conversationId) {
      sql += ` AND m.conversation_id = $3`;
      params.push(conversationId);
    }

    sql += ` ORDER BY m.created_at DESC LIMIT 50`;

    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error('searchMessages error:', err);
    res.status(500).json({ message: 'Search failed' });
  }
};

exports.getDMMessages = async (req, res) => {
  const { userId: otherUserId } = req.params;
  const currentUserId = req.user.id;
  const limit  = Math.min(parseInt(req.query.limit) || 50, 100);
  const before = req.query.before;

  try {
    const a = currentUserId < otherUserId ? currentUserId : otherUserId;
    const b = currentUserId < otherUserId ? otherUserId  : currentUserId;
    const convResult = await pool.query(`SELECT id FROM direct_conversations WHERE user_one_id=$1 AND user_two_id=$2`, [a, b]);
    if (!convResult.rows.length) return res.json({ messages: [], total: 0, hasMore: false, conversationId: null });

    const conversationId = convResult.rows[0].id;
    let query, params;
    if (before) {
      query  = `SELECT * FROM (${MSG_SELECT} WHERE mh.message_id IS NULL AND m.conversation_id=$2 AND m.created_at<$3 GROUP BY m.id,u.name,u.avatar_url,u.email,pm.content,pu.name ORDER BY m.created_at DESC LIMIT $4) sub ORDER BY created_at ASC`;
      params = [currentUserId, conversationId, before, limit];
    } else {
      query  = `SELECT * FROM (${MSG_SELECT} WHERE mh.message_id IS NULL AND m.conversation_id=$2 GROUP BY m.id,u.name,u.avatar_url,u.email,pm.content,pu.name ORDER BY m.created_at DESC LIMIT $3) sub ORDER BY created_at ASC`;
      params = [currentUserId, conversationId, limit];
    }
    const result      = await pool.query(query, params);
    const countResult = await pool.query(`SELECT COUNT(*) FROM messages WHERE conversation_id=$1`, [conversationId]);
    const total       = parseInt(countResult.rows[0].count);
    res.json({ messages: result.rows, total, hasMore: total > limit, conversationId });
  } catch (err) {
    console.error('getDMMessages error:', err);
    res.status(500).json({ message: 'Failed to fetch DM messages' });
  }
};

exports.sendDMMessage = async (req, res) => {
  const { userId: otherUserId } = req.params;
  const currentUserId = req.user.id;
  const { content, parent_message_id, attachments, is_forwarded } = req.body;

  if (!content?.trim() && (!attachments || !attachments.length)) {
    return res.status(400).json({ message: 'Message cannot be empty' });
  }
  const clean = content ? xss(content.trim()) : '';

  try {
    const a = currentUserId < otherUserId ? currentUserId : otherUserId;
    const b = currentUserId < otherUserId ? otherUserId  : currentUserId;
    let convResult = await pool.query(`SELECT id FROM direct_conversations WHERE user_one_id=$1 AND user_two_id=$2`, [a, b]);
    if (!convResult.rows.length) {
      convResult = await pool.query(`INSERT INTO direct_conversations (user_one_id,user_two_id) VALUES ($1,$2) RETURNING id`, [a, b]);
    }
    const conversationId = convResult.rows[0].id;
    const ins    = await pool.query(
      `INSERT INTO messages (content,sender_id,conversation_id,parent_message_id,attachments,is_forwarded) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [clean, currentUserId, conversationId, parent_message_id || null, JSON.stringify(attachments || []), is_forwarded || false]
    );
    const result  = await fetchById(ins.rows[0].id, currentUserId);
    const message = { ...result.rows[0], conversation_id: conversationId };
    const io      = req.app.get('io');
    io.to(`dm:${conversationId}`).emit('new_message', message);
    io.to(`user:${currentUserId}`).emit('dm:preview_updated', { conversationId });
    io.to(`user:${otherUserId}`).emit('dm:preview_updated', { conversationId });
    res.status(201).json(message);
  } catch (err) {
    console.error('sendDMMessage error:', err);
    res.status(500).json({ message: 'Failed to send DM' });
  }
};

exports.editDMMessage = async (req, res) => {
  const { userId: otherUserId, msgId } = req.params;
  const currentUserId = req.user.id;
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ message: 'Content cannot be empty' });
  const clean = xss(content.trim());
  try {
    const a = currentUserId < otherUserId ? currentUserId : otherUserId;
    const b = currentUserId < otherUserId ? otherUserId  : currentUserId;
    const convResult = await pool.query(`SELECT id FROM direct_conversations WHERE user_one_id=$1 AND user_two_id=$2`, [a, b]);
    if (!convResult.rows.length) return res.status(404).json({ message: 'Conversation not found' });
    const conversationId = convResult.rows[0].id;

    const result = await pool.query(
      `UPDATE messages
       SET content = $1, is_edited = true, updated_at = NOW()
       WHERE id = $2 AND conversation_id = $3 AND sender_id = $4
       RETURNING id, content, is_edited, updated_at, sender_id`,
      [clean, msgId, conversationId, currentUserId]
    );
    if (!result.rows.length) {
      return res.status(404).json({ message: 'Message not found or permission denied' });
    }
    const fullMessageResult = await fetchById(msgId, currentUserId);
    const message = { ...fullMessageResult.rows[0], conversation_id: conversationId };
    req.app.get('io').to(`dm:${conversationId}`).emit('message:edited', message);
    res.json(message);
  } catch (err) {
    console.error('editDMMessage error:', err);
    res.status(500).json({ message: 'Failed to edit message' });
  }
};

exports.deleteDMMessage = async (req, res) => {
  const { userId: otherUserId, msgId } = req.params;
  const currentUserId = req.user.id;
  try {
    const a = currentUserId < otherUserId ? currentUserId : otherUserId;
    const b = currentUserId < otherUserId ? otherUserId  : currentUserId;
    const convResult = await pool.query(`SELECT id FROM direct_conversations WHERE user_one_id=$1 AND user_two_id=$2`, [a, b]);
    if (!convResult.rows.length) return res.status(404).json({ message: 'Conversation not found' });
    const conversationId = convResult.rows[0].id;

    const check = await pool.query(`SELECT sender_id FROM messages WHERE id=$1 AND conversation_id=$2`, [msgId, conversationId]);
    if (!check.rows.length) return res.status(404).json({ message: 'Message not found' });
    if (check.rows[0].sender_id !== currentUserId) return res.status(403).json({ message: 'You can only delete your own messages' });
    
    await pool.query(`DELETE FROM messages WHERE id=$1`, [msgId]);
    req.app.get('io').to(`dm:${conversationId}`).emit('message:deleted', { messageId: msgId, conversationId });
    res.json({ messageId: msgId });
  } catch (err) {
    console.error('deleteDMMessage error:', err);
    res.status(500).json({ message: 'Failed to delete message' });
  }
};

exports.getDMConversations = async (req, res) => {
  const userId = req.user.id;
  try {
    const result = await pool.query(`
      SELECT
        dc.id AS conversation_id,
        CASE WHEN dc.user_one_id=$1 THEN dc.user_two_id ELSE dc.user_one_id END AS other_user_id,
        ou.name       AS other_user_name,
        ou.avatar_url AS other_user_avatar,
        ou.email      AS other_user_email,
        lm.content    AS last_message,
        lm.created_at AS last_message_at,
        lm.sender_id  AS last_message_sender_id,
        su.name       AS last_message_sender_name,
        (SELECT COUNT(*) FROM messages m LEFT JOIN user_dm_reads udr ON udr.conversation_id = dc.id AND udr.user_id = $1 WHERE m.conversation_id = dc.id AND m.sender_id != $1 AND (udr.last_read_at IS NULL OR m.created_at > udr.last_read_at))::int AS unread
      FROM direct_conversations dc
      JOIN users ou ON ou.id = CASE WHEN dc.user_one_id=$1 THEN dc.user_two_id ELSE dc.user_one_id END
      LEFT JOIN LATERAL (
        SELECT content, created_at, sender_id FROM messages
        WHERE conversation_id = dc.id ORDER BY created_at DESC LIMIT 1
      ) lm ON true
      LEFT JOIN users su ON su.id = lm.sender_id
      WHERE dc.user_one_id=$1 OR dc.user_two_id=$1
      ORDER BY COALESCE(lm.created_at, dc.created_at) DESC NULLS LAST
    `, [userId]);
    res.json(result.rows);
  } catch (err) {
    console.error('getDMConversations error:', err);
    res.status(500).json({ message: 'Failed to fetch DM conversations' });
  }
};

exports.getMentions = async (req, res) => {
  const userId = req.user.id;
  const userName = req.user.name;
  try {
    const result = await pool.query(`
      SELECT 
        m.id AS id, 
        m.content AS text, 
        m.created_at AS time, 
        m.sender_id, 
        u.name AS "senderName",
        s.name AS source, 
        s.id AS "sourceId", 
        'space' AS "sourceType",
        (usr.last_read_at IS NULL OR m.created_at > usr.last_read_at) AS is_unread
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      JOIN spaces s ON s.id = m.space_id
      LEFT JOIN user_space_reads usr ON usr.space_id = m.space_id AND usr.user_id = $1
      WHERE m.content ILIKE $2
      ORDER BY m.created_at DESC 
      LIMIT 50
    `, [userId, `%@${userName}%`]);
    
    const mentions = result.rows;
    const unreadMentions = mentions.filter(m => m.is_unread).length;
    
    res.json({ mentions, unreadMentions });
  } catch (err) {
    console.error('getMentions error:', err);
    res.status(500).json({ message: 'Failed to fetch mentions' });
  }
};

exports.hideMessage = async (req, res) => {
  const { msgId } = req.params;
  const userId = req.user.id;
  try {
    await pool.query(
      "INSERT INTO message_hides (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [msgId, userId]
    );
    res.json({ messageId: msgId, hidden: true });
  } catch (err) {
    console.error('hideMessage error:', err);
    res.status(500).json({ message: 'Failed to hide message' });
  }
};