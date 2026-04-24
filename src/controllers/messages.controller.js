const pool = require('../config/db');
const xss = require('xss');
const { uploadBuffer, cloudinary } = require('../config/cloudinary');
const { uploadSingleFile, saveFileToStorage } = require('../config/storage');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

// Use intelligent storage (S3 for production/Render, local for development)
exports.uploadMiddleware = uploadSingleFile;

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

// Upload a file to appropriate storage (S3 or local)
exports.uploadAttachment = async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file provided' });

  try {
    // Get the base URL from the request (used for local storage)
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const fileData = await saveFileToStorage(req.file, baseUrl, 'attachments');
    res.json(fileData);
  } catch (err) {
    console.error('uploadAttachment error:', err);
    res.status(500).json({ message: 'File upload failed: ' + (err.message || 'Unknown error') });
  }
};

exports.getSpaceMessages = async (req, res) => {
  const { id: spaceId } = req.params;
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
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
    const result = await pool.query(query, params);
    const countResult = await pool.query(`SELECT COUNT(*) FROM messages WHERE space_id=$1 AND parent_message_id IS NULL`, [spaceId]);
    const total = parseInt(countResult.rows[0].count);
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
    const result = await fetchById(ins.rows[0].id, req.user.id);
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
    const io = req.app.get('io');
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
  try {
    await pool.query(
      `DELETE FROM message_reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3`,
      [msgId, req.user.id, emoji]
    );
    const reactions = await pool.query(
      `SELECT mr.emoji, mr.user_id AS "userId", u.name AS "userName" FROM message_reactions mr JOIN users u ON u.id=mr.user_id WHERE mr.message_id=$1`,
      [msgId]
    );
    const msgInfo = await pool.query(`SELECT space_id,conversation_id FROM messages WHERE id=$1`, [msgId]);
    const io = req.app.get('io');
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
  const userId = req.user.id;
  if (!q) return res.json([]);

  try {
    let sql = `
      SELECT 
        m.id, m.content, m.created_at, m.sender_id, m.space_id, m.conversation_id,
        u.name AS sender_name,
        CASE 
          WHEN m.space_id IS NOT NULL THEN 'space'
          WHEN m.conversation_id IS NOT NULL THEN 'dm'
          ELSE 'unknown'
        END AS chat_type,
        CASE 
          WHEN m.space_id IS NOT NULL THEN (SELECT name FROM spaces WHERE id = m.space_id)
          WHEN m.conversation_id IS NOT NULL THEN (
            SELECT name FROM users 
            WHERE id = (
              SELECT CASE WHEN user_one_id = $1 THEN user_two_id ELSE user_one_id END 
              FROM direct_conversations WHERE id = m.conversation_id
            )
          )
          ELSE NULL
        END AS chat_context_name
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      LEFT JOIN message_hides mh ON mh.message_id = m.id AND mh.user_id = $1
      WHERE mh.message_id IS NULL AND m.content ILIKE $2
    `;
    const params = [userId, `%${q}%`];

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
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const before = req.query.before;

  try {
    const a = currentUserId < otherUserId ? currentUserId : otherUserId;
    const b = currentUserId < otherUserId ? otherUserId : currentUserId;
    const convResult = await pool.query(`SELECT id FROM direct_conversations WHERE user_one_id=$1 AND user_two_id=$2`, [a, b]);
    if (!convResult.rows.length) return res.json({ messages: [], total: 0, hasMore: false, conversationId: null });

    const conversationId = convResult.rows[0].id;
    let query, params;
    if (before) {
      query = `SELECT * FROM (${MSG_SELECT} WHERE mh.message_id IS NULL AND m.conversation_id=$2 AND m.created_at<$3 GROUP BY m.id,u.name,u.avatar_url,u.email,pm.content,pu.name ORDER BY m.created_at DESC LIMIT $4) sub ORDER BY created_at ASC`;
      params = [currentUserId, conversationId, before, limit];
    } else {
      query = `SELECT * FROM (${MSG_SELECT} WHERE mh.message_id IS NULL AND m.conversation_id=$2 GROUP BY m.id,u.name,u.avatar_url,u.email,pm.content,pu.name ORDER BY m.created_at DESC LIMIT $3) sub ORDER BY created_at ASC`;
      params = [currentUserId, conversationId, limit];
    }
    const result = await pool.query(query, params);
    const countResult = await pool.query(`SELECT COUNT(*) FROM messages WHERE conversation_id=$1`, [conversationId]);
    const total = parseInt(countResult.rows[0].count);
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
    const b = currentUserId < otherUserId ? otherUserId : currentUserId;
    let convResult = await pool.query(`SELECT id FROM direct_conversations WHERE user_one_id=$1 AND user_two_id=$2`, [a, b]);
    if (!convResult.rows.length) {
      convResult = await pool.query(`INSERT INTO direct_conversations (user_one_id,user_two_id) VALUES ($1,$2) RETURNING id`, [a, b]);
    }
    const conversationId = convResult.rows[0].id;
    const ins = await pool.query(
      `INSERT INTO messages (content,sender_id,conversation_id,parent_message_id,attachments,is_forwarded) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [clean, currentUserId, conversationId, parent_message_id || null, JSON.stringify(attachments || []), is_forwarded || false]
    );
    const result = await fetchById(ins.rows[0].id, currentUserId);
    const message = { ...result.rows[0], conversation_id: conversationId };
    const io = req.app.get('io');
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
    const b = currentUserId < otherUserId ? otherUserId : currentUserId;
    const convResult = await pool.query(`SELECT id FROM direct_conversations WHERE user_one_id=$1 AND user_two_id=$2`, [a, b]);
    if (!convResult.rows.length) return res.status(404).json({ message: 'Conversation not found' });
    const conversationId = convResult.rows[0].id;

    const result = await pool.query(
      `UPDATE messages
       SET content = $1, is_edited = true, updated_at = NOW()
       WHERE id = $2 AND conversation_id = $3 AND sender_id = $4
       RETURNING id, content, is_edited, updated_at, sender_id`,
      [clean, msgId, conversationId, req.user.id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ message: 'Message not found or permission denied' });
    }
    const fullMessageResult = await fetchById(msgId, req.user.id);
    const message = { ...fullMessageResult.rows[0], conversation_id: conversationId };
    req.app.get('io').to(`dm:${conversationId}`).emit('message:edited', message);
    res.json(message);
  } catch (err) {
    console.error('editDMMessage error:', err);
    res.status(500).json({ message: 'Failed to edit DM' });
  }
};

exports.deleteDMMessage = async (req, res) => {
  const { userId: otherUserId, msgId } = req.params;
  const currentUserId = req.user.id;
  try {
    const a = currentUserId < otherUserId ? currentUserId : otherUserId;
    const b = currentUserId < otherUserId ? otherUserId : currentUserId;
    const convResult = await pool.query(`SELECT id FROM direct_conversations WHERE user_one_id=$1 AND user_two_id=$2`, [a, b]);
    if (!convResult.rows.length) return res.status(404).json({ message: 'Conversation not found' });
    const conversationId = convResult.rows[0].id;

    const check = await pool.query(`SELECT sender_id FROM messages WHERE id=$1 AND conversation_id=$2`, [msgId, conversationId]);
    if (!check.rows.length) return res.status(404).json({ message: 'Message not found' });
    if (check.rows[0].sender_id !== req.user.id) return res.status(403).json({ message: 'You can only delete your own messages' });

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
    // Ensure the column exists (safe to run on every boot — ADD COLUMN IF NOT EXISTS is idempotent)
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_mention_read_at TIMESTAMPTZ
    `);

    const firstName = userName.split(' ')[0];

    // Fetch the current user's last_mention_read_at so we can mark is_unread correctly
    const userRow = await pool.query(
      'SELECT last_mention_read_at FROM users WHERE id = $1',
      [userId]
    );
    const lastReadAt = userRow.rows[0]?.last_mention_read_at || null;

    const result = await pool.query(`
      SELECT 
        m.id, 
        m.content AS text, 
        m.created_at, 
        m.sender_id, 
        u.name AS sender_name,
        u.avatar_url,
        COALESCE(s.name, 'Direct Message') AS source, 
        COALESCE(m.space_id, m.sender_id) AS "sourceId", 
        CASE WHEN m.space_id IS NOT NULL THEN 'space' ELSE 'dm' END AS "sourceType",
        CASE 
          WHEN $4::timestamptz IS NULL THEN true
          WHEN m.created_at > $4::timestamptz THEN true
          ELSE false
        END AS is_unread
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      LEFT JOIN spaces s ON s.id = m.space_id
      WHERE (
        m.content ILIKE $2
        OR m.content ILIKE $3
        OR (m.space_id IS NOT NULL AND (m.content ILIKE '%@all%' OR m.content ILIKE '%@everyone%'))
      )
      AND m.sender_id != $1
      AND (
        (m.space_id IS NOT NULL AND EXISTS (SELECT 1 FROM space_members sm WHERE sm.space_id = m.space_id AND sm.user_id = $1))
        OR 
        (m.conversation_id IS NOT NULL AND EXISTS (SELECT 1 FROM direct_conversations dc WHERE dc.id = m.conversation_id AND (dc.user_one_id = $1 OR dc.user_two_id = $1)))
      )
      ORDER BY m.created_at DESC 
      LIMIT 500
    `, [userId, `%@${userName}%`, `%@${firstName}%`, lastReadAt]);

    const mentions = result.rows;
    const unreadMentions = mentions.filter(m => m.is_unread).length;

    res.json({ mentions, unreadMentions });
  } catch (err) {
    console.error('getMentions error:', err);
    res.status(500).json({ message: 'Failed to fetch mentions' });
  }
};

// Called when the user opens the Mentions tab — persists the "read up to now" timestamp
// so the badge resets correctly even after a page refresh.
exports.markMentionsRead = async (req, res) => {
  const userId = req.user.id;
  try {
    await pool.query(
      'UPDATE users SET last_mention_read_at = NOW() WHERE id = $1',
      [userId]               // <-- values array: $1 maps to userId
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('markMentionsRead error:', err);
    res.status(500).json({ message: 'Failed to mark mentions as read' });
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

exports.downloadFile = (req, res) => {
  const { url, name } = req.query;
  console.log('Download request received for:', { url, name, user: req.user?.id });
  if (!url) return res.status(400).json({ message: 'URL required' });

  // Validate URL
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch {
    return res.status(400).json({ message: 'Invalid URL' });
  }

  // Helper: pipe a remote URL to the client response
  const proxyRemoteFile = (targetUrl, redirectCount = 0) => {
    if (redirectCount > 5) {
      if (!res.headersSent) return res.status(500).send('Too many redirects');
      return;
    }
    const getter = targetUrl.startsWith('https') ? https : http;
    const options = { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ShnoorProxy/1.0)' } };

    getter.get(targetUrl, options, (remoteRes) => {
      if (remoteRes.statusCode >= 300 && remoteRes.statusCode < 400 && remoteRes.headers.location) {
        let nextUrl = remoteRes.headers.location;
        if (nextUrl.startsWith('/')) {
          const u = new URL(targetUrl);
          nextUrl = `${u.protocol}//${u.host}${nextUrl}`;
        }
        remoteRes.resume();
        return proxyRemoteFile(nextUrl, redirectCount + 1);
      }

      if (remoteRes.statusCode !== 200) {
        console.error(`Download proxy error: ${remoteRes.statusCode} for ${targetUrl}`);
        if (!res.headersSent)
          return res.status(502).send(`Error: Could not fetch file (Status ${remoteRes.statusCode})`);
        return;
      }

      const contentType = remoteRes.headers['content-type'] || 'application/octet-stream';
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name || 'file')}"`);
      res.setHeader('Content-Type', contentType);
      if (remoteRes.headers['content-length'])
        res.setHeader('Content-Length', remoteRes.headers['content-length']);
      res.setHeader('Access-Control-Allow-Origin', '*');
      remoteRes.pipe(res);
    }).on('error', (err) => {
      console.error('Download proxy connection error:', err);
      if (!res.headersSent) res.status(500).send('Failed to connect to file server');
    });
  };

  // ── Local Storage Files: serve directly ─────────────────────────────────
  const serverHost = req.get('host');
  const renderExternalUrl = process.env.RENDER_EXTERNAL_URL || '';
  const isLocalFile = parsedUrl.hostname === 'localhost'
    || parsedUrl.host === serverHost
    || (renderExternalUrl && url.startsWith(renderExternalUrl));

  if (isLocalFile && parsedUrl.pathname.startsWith('/uploads/')) {
    try {
      const filename = parsedUrl.pathname.split('/').pop();
      const uploadsDir = path.resolve(path.join(__dirname, '../../uploads'));
      const resolvedPath = path.resolve(path.join(uploadsDir, filename));

      // Security: ensure the path is within uploads directory
      if (!resolvedPath.startsWith(uploadsDir)) {
        return res.status(403).json({ message: 'Access denied' });
      }
      if (!fs.existsSync(resolvedPath)) {
        return res.status(404).json({ message: 'File not found' });
      }

      const stat = fs.statSync(resolvedPath);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name || filename)}"`);
      res.setHeader('Access-Control-Allow-Origin', '*');

      const stream = fs.createReadStream(resolvedPath);
      stream.pipe(res);
      stream.on('error', (err) => {
        console.error('File stream error:', err);
        if (!res.headersSent) res.status(500).send('Failed to stream file');
      });
      return;
    } catch (err) {
      console.error('Local file download error:', err);
      return res.status(500).json({ message: 'Failed to download file' });
    }
  }

  if (parsedUrl.hostname === 'res.cloudinary.com') {
    try {
      const match = url.match(
        /res\.cloudinary\.com\/[^/]+\/(image|raw|video)\/upload\/(?:v\d+\/)?([^?]+)/
      );

      if (match) {
        const resourceType = match[1];
        const publicId = match[2];

        const safeFileName = (name || publicId.split('/').pop())
          .replace(/[^a-zA-Z0-9._\-]/g, '_');

        const signedUrl = cloudinary.url(publicId, {
          resource_type: resourceType,
          type: 'upload',
          sign_url: true,
          secure: true,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          flags: `attachment:${safeFileName}`,
        });

        console.log('Cloudinary signed proxy for:', publicId);
        // Proxy the signed URL instead of redirecting (avoids CORS issues)
        return proxyRemoteFile(signedUrl);
      }
    } catch (err) {
      console.error('Cloudinary signed URL generation error:', err);
      // fall through to generic proxy
    }
  }

  // ── Fallback: generic proxy ─────────────────────────────────────────────
  proxyRemoteFile(url);
};