import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import "./eventScheduler"; // Start event lifecycle management
import { addAuthTestRoutes } from "./authTest";
import { createTelegramBot } from "./telegramBot";
import { NotificationAlgorithmService } from "./notificationAlgorithm";

const app = express();

// Raw body parsing for webhooks, JSON parsing for everything else
app.use('/api/webhook/paystack', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  // Initialize Telegram bot
  const telegramBot = createTelegramBot();
  if (telegramBot) {
    console.log('🔧 Testing Telegram bot configuration...');
    const connectionTest = await telegramBot.testConnection();
    
    if (connectionTest.connected) {
      console.log('✅ Telegram bot ready for broadcasting');
      console.log(`   Bot: ${connectionTest.botInfo?.username}`);
      console.log(`   Channel: ${connectionTest.channelInfo?.title || connectionTest.channelInfo?.first_name}`);
    } else {
      console.log('❌ Telegram bot configuration error:');
      console.log(`   ${connectionTest.error}`);
      console.log('');
      console.log('📋 TELEGRAM SETUP INSTRUCTIONS:');
      console.log('   1. Create a bot with @BotFather on Telegram');
      console.log('   2. Add the bot to your channel/group as admin');
      console.log('   3. Get the correct channel ID:');
      console.log('      - For channels: starts with -100');
      console.log('      - For groups: positive number');
      console.log('      - Or use @username format');
      console.log('   4. Update TELEGRAM_CHANNEL_ID secret');
    }
  }

  const server = await registerRoutes(app);
  addAuthTestRoutes(app);

  // Initialize notification algorithm service
  const { storage } = await import('./storage');
  const notificationAlgorithm = new NotificationAlgorithmService(storage);
  console.log('🔔 Starting notification algorithm service...');
  notificationAlgorithm.startNotificationScheduler();
  console.log('✅ Notification algorithm service started');

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || '5000', 10);
  
  server.listen({
    port,
    host: "0.0.0.0",
    reusePort: true,
  }, () => {
    log(`serving on port ${port}`);
  }).on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Retrying in 2 seconds...`);
      setTimeout(() => {
        server.listen({
          port,
          host: "0.0.0.0",
          reusePort: true,
        }, () => {
          log(`serving on port ${port}`);
        });
      }, 2000);
    } else {
      throw err;
    }
  });
})();