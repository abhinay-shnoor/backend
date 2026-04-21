require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const calendarRoutes = require('./routes/calendar.routes');

const passport = require('./config/passport');
const pool = require('./config/db');

const authRoutes = require('./routes/auth.routes');
const spacesRoutes = require('./routes/spaces.routes');
const messagesRoutes = require('./routes/messages.routes');
const usersRoutes = require('./routes/users.routes');
const contactRoutes = require('./routes/contact.routes');
const socketHandler = require('./socket/index');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    credentials: true,
  },
});

const PORT = process.env.PORT || 5000;

app.set('trust proxy', 1);
app.use(compression());
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(morgan('dev'));
app.use(cors({
  origin: process.env.CLIENT_URL,
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '10mb' }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { message: 'Too many requests, try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { message: 'Too many auth attempts, try again later.' },
});

const sessionMiddleware = session({
  store: new pgSession({ pool }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
  secure: process.env.NODE_ENV === 'production',
  httpOnly: true,
  sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000,
},
});

app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

// Share the session with Socket.io so we can read userId from socket
io.engine.use(sessionMiddleware);
io.engine.use(passport.initialize());
io.engine.use(passport.session());

app.set('io', io);

app.use('/auth', authLimiter, authRoutes);
app.use('/api/spaces', apiLimiter, spacesRoutes);
app.use('/api', apiLimiter, messagesRoutes);
app.use('/api/users', apiLimiter, usersRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/calendar', apiLimiter, calendarRoutes);

app.get('/', (req, res) => res.send('SHNOOR Workspace API running'));
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/db-test', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW() as current_time');
    res.json({ status: 'ok', db_time: result.rows[0].current_time });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack);
  res.status(err.status || 500).json({ message: err.message || 'Internal server error' });
});

socketHandler(io);

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});