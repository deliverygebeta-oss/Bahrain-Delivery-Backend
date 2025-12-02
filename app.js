// app.js (SECURE PRODUCTION VERSION)
import express from 'express';
import morgan from 'morgan';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import cors from 'cors';

// SECURITY PACKAGES
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import mongoSanitize from 'express-mongo-sanitize';
import xss from 'xss-clean';
import hpp from 'hpp';
import compression from 'compression';
import cookieParser from 'cookie-parser';

// ROUTES
import foodRoutes from "./routes/foodRoutes.js";
import restaurantRoutes from './routes/restaurantRoutes.js';
import foodMenuRoutes from './routes/foodMenuRoutes.js';
import orderRoutes from './routes/orderRoutes.js';
import deliverRoutes from './routes/deliverRoutes.js';
import userRoutes from './routes/userRoutes.js';
import reviewRouter from './routes/reviewRoutes.js';
import testRoute from './routes/testRoutes.js';
import ratingRoutes from './routes/ratingRoutes.js';
import balanceRoute from './routes/balanceRouter.js';
import configration from "./routes/configrationRoute.js";

// ERROR HANDLER
import globalErrorHandler from './controllers/errorController.js';

const app = express();
const isProd = process.env.NODE_ENV === 'production';

// -----------------------
// TRUST PROXY (needed for secure cookies behind Nginx / Cloudflare / Render)
// -----------------------
if (isProd) {
  app.set('trust proxy', 1);
}

// -----------------------
// SECURITY HEADERS
// -----------------------
app.use(helmet());

// -----------------------
// CORS - Allow all origins
// -----------------------
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// -----------------------
// LOGGING
// -----------------------
app.use(morgan(isProd ? 'combined' : 'dev'));

// -----------------------
// BODY PARSER
// -----------------------
app.use(express.json({ limit: '10kb' })); 
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// -----------------------
// COOKIE PARSER
// -----------------------
app.use(cookieParser());

// -----------------------
// SESSION SECURITY (Production-ready with MongoDB)
// -----------------------
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-in-production!',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.DATABASE,
    touchAfter: 24 * 3600, // lazy session update (seconds)
    crypto: {
      secret: process.env.SESSION_SECRET || 'change-this-in-production!'
    },
    collectionName: 'sessions',
    ttl: 10 * 60, // 10 minutes (in seconds)
  }),
  cookie: {
    httpOnly: true,
    maxAge: 10 * 60 * 1000, // 10 minutes (in milliseconds)
    secure: isProd,         // only over HTTPS
    sameSite: isProd ? 'none' : 'lax'
  }
}));

// -----------------------
// RATE LIMITING
// -----------------------
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 300,                 // prevent DDOS
  standardHeaders: true,
  legacyHeaders: false
}));

// -----------------------
// DATA SANITIZATION
// -----------------------
app.use(mongoSanitize()); // NoSQL injection protection
app.use(xss());           // XSS protection
app.use(hpp());           // Prevent HTTP param pollution

// -----------------------
// COMPRESSION
// -----------------------
app.use(compression());

// -----------------------
// ROUTES
// -----------------------
app.use('/api/v1/test', testRoute);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/foods', foodRoutes);
app.use('/api/v1/restaurants', restaurantRoutes);
app.use('/api/v1/food-menus', foodMenuRoutes);
app.use('/api/v1/orders', orderRoutes);
app.use('/api/v1/balance', balanceRoute);
app.use("/api/v1/config", configration);
app.use('/api/v1/deliveries', deliverRoutes);
app.use('/api/v1/reviews', ratingRoutes);
app.use('/api/v1/restaurants/:restaurantId/reviews', reviewRouter);

// -----------------------
// HEALTH CHECK & TEST ROUTES
// -----------------------
app.get('/', (req, res) => {
  res.status(200).json({ message: 'API is working 🚀' });
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    sessionStore: 'MongoDB',
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB'
    }
  });
});

// -----------------------
// ERROR HANDLER
// -----------------------
app.use(globalErrorHandler);

export default app;
