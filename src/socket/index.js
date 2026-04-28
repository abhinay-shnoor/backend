const pool = require('../config/db');

// userId → { status: string, sockets: Set<socketId>, disconnectTimer: timeout, lastSeen: timestamp }
const userPresence = new Map();

const getPresenceMap = () => {
  const map = {};
  for (const [uid, data] of userPresence.entries()) {
    map[uid] = data.status;
  }
  return map;
};

// PRODUCTION CLEANUP JOB (Runs every 5 seconds)
// This catches users whose network dropped without firing a disconnect event.
setInterval(() => {
  const now = Date.now();
  let changed = false;

  for (const [uid, data] of userPresence.entries()) {
    // If no heartbeat for > 15 seconds, force offline
    if (now - data.lastSeen > 15000) {
      console.log(`[Socket] Force Pruning stale user ${uid} (No heartbeat for 15s)`);
      userPresence.delete(uid);
      changed = true;
    }
  }

  if (changed) {
    // We don't have access to 'io' here globally in a clean way unless we store it, 
    // but in this architecture, we'll let the next event emit the update or 
    // we can pass 'io' to this job.
  }
}, 5000);

const socketHandler = (io) => {
  // Setup the recurring broadcast for the cleanup job
  const cleanupJob = setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [uid, data] of userPresence.entries()) {
      if (now - data.lastSeen > 15000) {
        console.log(`[Socket] Pruning stale user ${uid}`);
        userPresence.delete(uid);
        changed = true;
      }
    }
    if (changed) io.emit('users:presence', getPresenceMap());
  }, 5000);
  io.on('connection', async (socket) => {
    const userId = socket.request.session?.passport?.user;
    if (!userId) { 
      console.log(`[Socket] Rejected anonymous connection: ${socket.id}`);
      socket.disconnect(true); 
      return; 
    }

    // Initialize/Update presence on connection
    if (userPresence.has(userId)) {
      const data = userPresence.get(userId);
      data.lastSeen = Date.now();
      if (data.disconnectTimer) {
        console.log(`[Socket] Clearing disconnect timer for user ${userId} (Reconnected)`);
        clearTimeout(data.disconnectTimer);
        data.disconnectTimer = null;
      }
      data.sockets.add(socket.id);
    } else {
      console.log(`[Socket] User ${userId} is now Online`);
      userPresence.set(userId, { 
        status: 'active', 
        sockets: new Set([socket.id]), 
        disconnectTimer: null,
        lastSeen: Date.now() 
      });
    }
    
    // Broadcast updated presence to everyone
    io.emit('users:presence', getPresenceMap());

    // HEARTBEAT LISTENER (Production Fallback)
    socket.on('heartbeat', () => {
      const data = userPresence.get(userId);
      if (data) {
        data.lastSeen = Date.now();
      } else {
        // If they were pruned but still sending heartbeats, re-add them
        userPresence.set(userId, { 
          status: 'active', 
          sockets: new Set([socket.id]), 
          disconnectTimer: null,
          lastSeen: Date.now() 
        });
        io.emit('users:presence', getPresenceMap());
      }
    });

    // Listen for status changes from the frontend (Navbar)
    socket.on('user:status_change', (status) => {
      console.log(`[Socket] User ${userId} changed status to: ${status}`);
      if (userPresence.has(userId)) {
        userPresence.get(userId).status = status;
        io.emit('users:presence', getPresenceMap());
        io.emit('user:status_changed', { userId, status });
      }
    });

    const handleCleanup = (reason) => {
      const userData = userPresence.get(userId);
      if (userData) {
        userData.sockets.delete(socket.id);
        console.log(`[Socket] Socket ${socket.id} disconnected (Reason: ${reason}). Remaining sockets for ${userId}: ${userData.sockets.size}`);
        
        // If this was the last socket, mark them offline IMMEDIATELY
        if (userData.sockets.size === 0) {
          console.log(`[Socket] User ${userId} is now Offline (Immediate)`);
          // Clear any existing timer just in case
          if (userData.disconnectTimer) clearTimeout(userData.disconnectTimer);
          
          userPresence.delete(userId);
          io.emit('users:presence', getPresenceMap());
        }
      }
    };

    socket.on('disconnecting', (reason) => handleCleanup(`disconnecting:${reason}`));
    socket.on('disconnect', (reason) => handleCleanup(`disconnect:${reason}`));

    // Auto-join every existing DM room so this user receives real-time DM
    // messages even for conversations they haven't explicitly opened today
    try {
      const convs = await pool.query(
        `SELECT id FROM direct_conversations WHERE user_one_id = $1 OR user_two_id = $1`,
        [userId]
      );
      convs.rows.forEach(({ id }) => socket.join(`dm:${id}`));
    } catch (err) {
      console.error('auto-join DM rooms failed:', err);
    }

    // Auto-join every space this user is a member of
    try {
      const spaceMemberships = await pool.query(
        `SELECT space_id FROM space_members WHERE user_id = $1`,
        [userId]
      );
      spaceMemberships.rows.forEach(({ space_id }) => socket.join(`space:${space_id}`));
    } catch (err) {
      console.error('auto-join spaces failed:', err);
    }

    socket.on('join_space', (spaceId) => socket.join(`space:${spaceId}`));
    socket.on('leave_space', (spaceId) => socket.leave(`space:${spaceId}`));

    // Client sends otherUserId — server resolves or creates the conversation
    // and joins this socket to its room
    socket.on('join_dm', async (otherUserId) => {
      try {
        const a = userId < otherUserId ? userId : otherUserId;
        const b = userId < otherUserId ? otherUserId : userId;

        let conv = await pool.query(
          `SELECT id FROM direct_conversations WHERE user_one_id=$1 AND user_two_id=$2`,
          [a, b]
        );

        if (!conv.rows.length) {
          conv = await pool.query(
            `INSERT INTO direct_conversations (user_one_id,user_two_id) VALUES ($1,$2) RETURNING id`,
            [a, b]
          );
          // Join the other user's live sockets into this new room immediately
          const otherUser = userPresence.get(otherUserId);
          if (otherUser && otherUser.sockets) {
            otherUser.sockets.forEach((sid) =>
              io.sockets.sockets.get(sid)?.join(`dm:${conv.rows[0].id}`)
            );
          }
        }

        const conversationId = conv.rows[0].id;
        socket.join(`dm:${conversationId}`);
        socket.emit('dm:joined', { conversationId, otherUserId });
      } catch (err) {
        console.error('join_dm error:', err);
      }
    });

    socket.on('leave_dm', (conversationId) => socket.leave(`dm:${conversationId}`));

    // Typing — per-socket timer auto-clears after 5s if typing:stop never arrives
    const typingTimers = {};

    socket.on('typing:start', ({ roomType, roomId, userName }) => {
      const room = roomType === 'space' ? `space:${roomId}` : `dm:${roomId}`;
      if (typingTimers[room]) clearTimeout(typingTimers[room]);
      socket.to(room).emit('typing:update', { userId, userName, isTyping: true });
      typingTimers[room] = setTimeout(() => {
        socket.to(room).emit('typing:update', { userId, isTyping: false });
        delete typingTimers[room];
      }, 5000);
    });

    socket.on('typing:stop', ({ roomType, roomId }) => {
      const room = roomType === 'space' ? `space:${roomId}` : `dm:${roomId}`;
      if (typingTimers[room]) { clearTimeout(typingTimers[room]); delete typingTimers[room]; }
      socket.to(room).emit('typing:update', { userId, isTyping: false });
    });

    // Client tells the server it has read a conversation — server broadcasts
    // the read event back to the room so the sender's "Seen" indicator updates
    socket.on('mark:space_read', async (spaceId) => {
      try {
        await pool.query(
          `INSERT INTO user_space_reads (user_id, space_id, last_read_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (user_id, space_id) DO UPDATE SET last_read_at = NOW()`,
          [userId, spaceId]
        );
        socket.to(`space:${spaceId}`).emit('read:space_updated', { userId, spaceId });
      } catch (err) {
        console.error('mark:space_read error:', err);
      }
    });

    socket.on('mark:dm_read', async (conversationId) => {
      try {
        await pool.query(
          `INSERT INTO user_dm_reads (user_id, conversation_id, last_read_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (user_id, conversation_id) DO UPDATE SET last_read_at = NOW()`,
          [userId, conversationId]
        );
        socket.to(`dm:${conversationId}`).emit('read:dm_updated', { userId, conversationId });
      } catch (err) {
        console.error('mark:dm_read error:', err);
      }
    });

    socket.on('mark:delivered', async ({ messageId, spaceId, conversationId }) => {
      try {
        await pool.query(
          `INSERT INTO message_receipts (message_id, user_id, delivered_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (message_id, user_id) DO UPDATE SET delivered_at = COALESCE(message_receipts.delivered_at, NOW())`,
          [messageId, userId]
        );
        const room = spaceId ? `space:${spaceId}` : `dm:${conversationId}`;
        const receipts = await pool.query(
          `SELECT user_id AS "userId", delivered_at AS "deliveredAt", seen_at AS "seenAt" FROM message_receipts WHERE message_id = $1`,
          [messageId]
        );
        io.to(room).emit('receipt:updated', { messageId, receipts: receipts.rows });
      } catch (err) {
        console.error('mark:delivered error:', err);
      }
    });

    socket.on('mark:seen', async ({ messageId, spaceId, conversationId }) => {
      try {
        await pool.query(
          `INSERT INTO message_receipts (message_id, user_id, seen_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (message_id, user_id) DO UPDATE SET seen_at = COALESCE(message_receipts.seen_at, NOW())`,
          [messageId, userId]
        );
        const room = spaceId ? `space:${spaceId}` : `dm:${conversationId}`;
        const receipts = await pool.query(
          `SELECT user_id AS "userId", delivered_at AS "deliveredAt", seen_at AS "seenAt" FROM message_receipts WHERE message_id = $1`,
          [messageId]
        );
        io.to(room).emit('receipt:updated', { messageId, receipts: receipts.rows });
      } catch (err) {
        console.error('mark:seen error:', err);
      }
    });
  });
};

module.exports = socketHandler;