import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import Pusher from "pusher";
import { storage } from "./storage";
import { setupAuth, isAuthenticated, isAdmin } from "./replitAuth";
import { db } from "./db";
import { insertEventSchema, insertChallengeSchema, insertNotificationSchema } from "@shared/schema";
import { and, eq } from "drizzle-orm";
import {
  users,
  events,
  bets,
  messages,
  userAchievements,
  challenges,
  challengeParticipants,
  notifications,
  reactions,
  userFeedback,
  walletBalances,
  walletTransactions,
  followers,
  dailyLogins,
  eventParticipants,
} from "../shared/schema";
import { sql } from "drizzle-orm";
import crypto from "crypto";
import { createTelegramSync, getTelegramSync } from "./telegramSync";
import { getTelegramBot } from "./telegramBot";
import webpush from "web-push";
import { setupOGImageRoutes } from "./ogImageGenerator";

// Import formatBalance utility for coin operations
function formatBalance(amount: number): string {
  return `₦${amount.toLocaleString()}`;
}
import axios from "axios";

// Initialize Pusher
const pusher = new Pusher({
  appId: "1553294",
  key: "decd2cca5e39cf0cbcd4",
  secret: "1dd966e56c465ea285d9",
  cluster: "mt1",
  useTLS: true,
});

// Configure Web Push
webpush.setVapidDetails(
  'mailto:support@betchat.com',
  'BKZ0LNy05CTv807lF4dSwM3wB7nxrBHXDP5AYPvbCCPZYWrK08rTYFQO6BmKrW3f0xmIe5wUxtLN67XOSQ7W--o',
  'uNkb_1Ntqe1IKeqDeAlbyOJcXTt8wrvwArWSh7GML0A'
);



// Initialize Telegram sync service (deferred)
let telegramSync: any = null;

// Function to initialize Telegram sync when needed
function initializeTelegramSync() {
  if (!telegramSync) {
    telegramSync = createTelegramSync(pusher);
    if (telegramSync) {
      console.log("🔧 Initializing Telegram sync service...");
      telegramSync.initialize().catch((error) => {
        console.error("❌ Telegram sync initialization failed:", error);
        console.log("📱 BetChat will continue without Telegram sync");
      });
    }
  }
  return telegramSync;
}

interface AuthenticatedRequest extends Request {
  user: {
    claims: {
      sub: string;
      email?: string;
      first_name?: string;
      last_name?: string;
      profile_image_url?: string;
    };
  };
}

export async function registerRoutes(app: Express): Promise<Server> {
  // Auth middleware
  await setupAuth(app);

  // Auth routes
  app.get('/api/auth/user', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);

      // Check and create daily login record
      await storage.checkDailyLogin(userId);

      res.json(user);
    } catch (error) {
      console.error("Error fetching user:", error);
      res.status(500).json({ message: "Failed to fetch user" });
    }
  });

  // Event routes
  app.get('/api/events', async (req, res) => {
    try {
      const events = await storage.getEvents(20);
      res.json(events);
    } catch (error) {
      console.error("Error fetching events:", error);
      res.status(500).json({ message: "Failed to fetch events" });
    }
  });

  app.get('/api/events/:id', async (req, res) => {
    try {
      const event = await storage.getEventById(parseInt(req.params.id));
      if (!event) {
        return res.status(404).json({ message: "Event not found" });
      }
      res.json(event);
    } catch (error) {
      console.error("Error fetching event:", error);
      res.status(500).json({ message: "Failed to fetch event" });
    }
  });

  app.post('/api/events', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user.claims.sub;
      console.log("Creating event with data:", req.body);
      console.log("User ID:", userId);

      // Validate required fields
      if (!req.body.title || !req.body.category || !req.body.entryFee || !req.body.endDate) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      // Convert entryFee to proper integer format (coins)
      const entryFee = parseInt(req.body.entryFee);
      if (isNaN(entryFee) || entryFee <= 0) {
        return res.status(400).json({ message: "Invalid entry fee" });
      }

      // Validate end date
      const endDate = new Date(req.body.endDate);
      if (endDate <= new Date()) {
        return res.status(400).json({ message: "End date must be in the future" });
      }

      const eventData = {
        title: req.body.title,
        description: req.body.description || null,
        category: req.body.category,
        entryFee: entryFee,
        endDate: endDate,
        creatorId: userId,
        status: 'active',
        isPrivate: req.body.isPrivate || false,
        maxParticipants: req.body.maxParticipants || 100,
      };

      console.log("Parsed event data:", eventData);

      const event = await storage.createEvent(eventData);
      console.log("Created event:", event);

      // Get creator info for Telegram broadcast
      const creator = await storage.getUser(userId);

      // Broadcast to Telegram channel
      const telegramBot = getTelegramBot();
      if (telegramBot && creator) {
        try {
          await telegramBot.broadcastEvent({
            id: event.id,
            title: event.title,
            description: event.description || undefined,
            creator: {
              name: creator.firstName || creator.username || 'Unknown',
              username: creator.username || undefined,
            },
            entryFee: event.entryFee,
            endDate: event.endDate,
            is_private: event.isPrivate,
            max_participants: event.maxParticipants,
            category: event.category,
          });
          console.log("📤 Event broadcasted to Telegram successfully");
        } catch (error) {
          console.error("❌ Failed to broadcast event to Telegram:", error);
        }
      }

      res.json(event);
    } catch (error) {
      console.error("Error creating event:", error);
      if (error instanceof Error) {
        res.status(500).json({ message: error.message });
      } else {
        res.status(500).json({ message: "Failed to create event" });
      }
    }
  });

  app.post('/api/events/:id/leave', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const eventId = parseInt(req.params.id);
      const userId = req.user.claims.sub;

      // Check if user has joined the event
      const participant = await db
        .select()
        .from(eventParticipants)
        .where(and(
          eq(eventParticipants.eventId, eventId),
          eq(eventParticipants.userId, userId)
        ))
        .limit(1);

      if (participant.length === 0) {
        return res.status(400).json({ message: "You haven't joined this event" });
      }

      // Check if user has bet (prevent leaving if they have bet)
      if (participant[0].prediction !== null) {
        return res.status(400).json({ message: "Cannot leave event after placing a bet" });
      }

      // Remove participant
      await db
        .delete(eventParticipants)
        .where(and(
          eq(eventParticipants.eventId, eventId),
          eq(eventParticipants.userId, userId)
        ));

      res.json({ message: "Successfully left the event" });
    } catch (error) {
      console.error("Error leaving event:", error);
      res.status(500).json({ message: "Failed to leave event" });
    }
  });

  app.post('/api/events/:id/join', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user.claims.sub;
      const eventId = parseInt(req.params.id);
      const { prediction } = req.body;

      const event = await storage.getEventById(eventId);
      if (!event) {
        return res.status(404).json({ message: "Event not found" });
      }

      // Always use the event's entry fee (fixed model) - now in coins
      const amount = parseInt(event.entryFee.toString());

      // Check user coin balance
      const balance = await storage.getUserBalance(userId);
      const userCoins = balance.coins || 0;
      if (userCoins < amount) {
        return res.status(400).json({ message: "Insufficient coins" });
      }

      // Check if event is private
      if (event.isPrivate) {
        // Create join request for private events
        const joinRequest = await storage.requestEventJoin(eventId, userId, prediction, amount);

        // Create notification for event creator
        await storage.createNotification({
          userId: event.creatorId,
          type: 'event_join_request',
          title: 'New Event Join Request',
          message: `${req.user.claims.first_name || 'Someone'} wants to join your private event: ${event.title}`,
          data: { eventId: eventId, requestId: joinRequest.id },
        });

        // Create notification for user about pending request
        await storage.createNotification({
          userId,
          type: 'event_join_pending',
          title: '⏳ Join Request Submitted',
          message: `Your request to join "${event.title}" is pending approval. Funds will be locked once approved.`,
          data: { 
            eventId: eventId, 
            amount: amount,
            prediction: prediction ? 'YES' : 'NO',
            eventTitle: event.title
          },
        });

        return res.json({ message: "Join request sent to event creator", request: joinRequest });
      }

      const participant = await storage.joinEvent(eventId, userId, prediction, amount);

      // Create transaction record for coin escrow
      await storage.createTransaction({
        userId,
        type: 'event_escrow',
        amount: `-${amount}`,
        description: `${amount.toLocaleString()} coins locked in escrow for event: ${event.title}`,
        relatedId: eventId,
        status: 'completed',
      });

      // Deduct coins from user
      await db
        .update(users)
        .set({ 
          coins: sql`${users.coins} - ${amount}`,
          updatedAt: new Date()
        })
        .where(eq(users.id, userId));

      // Create comprehensive notifications
      await storage.createNotification({
        userId,
        type: 'coins_locked',
        title: '🔒 Coins Locked in Escrow',
        message: `${amount.toLocaleString()} coins locked for your ${prediction ? 'YES' : 'NO'} prediction on "${event.title}". Coins will be released when the event ends.`,
        data: { 
          eventId: eventId,
          amount: amount,
          prediction: prediction ? 'YES' : 'NO',
          eventTitle: event.title,
          eventEndDate: event.endDate,
          type: 'escrow_lock'
        },
      });

      // Notify event creator about new participant
      await storage.createNotification({
        userId: event.creatorId,
        type: 'event_participant_joined',
        title: '🎯 New Event Participant',
        message: `${req.user.claims.first_name || 'Someone'} joined your event "${event.title}" with a ${prediction ? 'YES' : 'NO'} prediction (${amount.toLocaleString()} coins)!`,
        data: { 
          eventId: eventId,
          participantId: userId,
          amount: amount,
          prediction: prediction ? 'YES' : 'NO',
          eventTitle: event.title
        },
      });

      // Send real-time notifications via Pusher
      await pusher.trigger(`user-${userId}`, 'coins-locked', {
        title: '🔒 Coins Locked in Escrow',
        message: `${amount.toLocaleString()} coins locked for your ${prediction ? 'YES' : 'NO'} prediction on "${event.title}"`,
        eventId: eventId,
        type: 'coins_locked',
      });

      await pusher.trigger(`user-${event.creatorId}`, 'participant-joined', {
        title: '🎯 New Event Participant',
        message: `${req.user.claims.first_name || 'Someone'} joined your event "${event.title}"`,
        eventId: eventId,
        type: 'participant_joined',
      });

      res.json(participant);
    } catch (error) {
      console.error("Error joining event:", error);
      res.status(500).json({ message: "Failed to join event" });
    }
  });

  app.get('/api/events/:id/messages', async (req, res) => {
    try {
      const eventId = parseInt(req.params.id);
      const messages = await storage.getEventMessages(eventId);
      res.json(messages);
    } catch (error) {
      console.error("Error fetching event messages:", error);
      res.status(500).json({ message: "Failed to fetch messages" });
    }
  });

  app.post('/api/events/:id/messages', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user.claims.sub;
      const eventId = parseInt(req.params.id);
      const { message, replyToId, mentions } = req.body;

      const newMessage = await storage.createEventMessage(eventId, userId, message, replyToId, mentions);

      // Broadcast new message via Pusher
      await pusher.trigger(`event-${eventId}`, 'new-message', {
        message: newMessage,
        eventId: eventId,
        userId: userId,
      });

      // Forward to Telegram if sync is available
      const telegramSync = getTelegramSync();
      if (telegramSync && telegramSync.isReady()) {
        try {
          const user = await storage.getUser(userId);
          const event = await storage.getEventById(eventId);
          const senderName = user?.firstName || user?.username || 'BetChat User';

          await telegramSync.sendMessageToTelegram(
            message, 
            senderName, 
            { id: eventId, title: event?.title || `Event ${eventId}` }
          );
        } catch (telegramError) {
          console.error('Error forwarding message to Telegram:', telegramError);
        }
      } else {
        // Fallback to Telegram bot if sync is not available
        const telegramBot = getTelegramBot();
        if (telegramBot) {
          try {
            const user = await storage.getUser(userId);
            const event = await storage.getEventById(eventId);
            const senderName = user?.firstName || user?.username || 'BetChat User';

            const formattedMessage = `🎯 ${event?.title || 'Event Chat'}\n👤 ${senderName}: ${message}`;

            await telegramBot.sendCustomMessage(formattedMessage);
            console.log(`📤 BetChat → Telegram Bot: ${senderName}: ${message} [Event: ${event?.title || 'Event Chat'}]`);
          } catch (telegramError) {
            console.error('Error sending message via Telegram bot:', telegramError);
          }
        }
      }

      // Create notifications for mentioned users
      if (mentions && mentions.length > 0) {
        for (const mentionedUsername of mentions) {
          const mentionedUser = await storage.getUserByUsername(mentionedUsername);
          if (mentionedUser && mentionedUser.id !== userId) {
            const notification = await storage.createNotification({
              userId: mentionedUser.id,
              type: 'mention',
              title: 'You were mentioned',
              message: `${req.user.claims.first_name || 'Someone'} mentioned you in an event chat`,
              data: { 
                eventId: eventId, 
                messageId: newMessage.id,
                mentionedBy: userId,
                eventTitle: 'Event Chat'
              },
            });

            // Send notification via Pusher
            await pusher.trigger(`user-${mentionedUser.id}`, 'event-notification', {
              title: 'You were mentioned',
              message: `${req.user.claims.first_name || 'Someone'} mentioned you in an event chat`,
              eventId: eventId,
              type: 'mention',
            });
          }
        }
      }

      // Create notification for replied user
      if (replyToId) {
        const repliedMessage = await storage.getEventMessageById(replyToId);
        if (repliedMessage && repliedMessage.userId !== userId) {
          const notification = await storage.createNotification({
            userId: repliedMessage.userId,
            type: 'reply',
            title: 'Someone replied to your message',
            message: `${req.user.claims.first_name || 'Someone'} replied to your message`,
            data: { 
              eventId: eventId, 
              messageId: newMessage.id,
              repliedBy: userId,
              originalMessageId: replyToId
            },
          });

          // Send notification via Pusher
          await pusher.trigger(`user-${repliedMessage.userId}`, 'event-notification', {
            title: 'Someone replied to your message',
            message: `${req.user.claims.first_name || 'Someone'} replied to your message`,
            eventId: eventId,
            type: 'reply',
          });
        }
      }

      res.json(newMessage);
    } catch (error) {
      console.error("Error creating event message:", error);
      res.status(500).json({ message: "Failed to create message" });
    }
  });

  app.post('/api/events/:id/messages/:messageId/react', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user.claims.sub;
      const eventId = parseInt(req.params.id);
      const messageId = req.params.messageId;
      const { emoji } = req.body;

      const reaction = await storage.toggleMessageReaction(messageId, userId, emoji);

      // Get updated reaction summary for the message
      const message = await storage.getEventMessageById(messageId);
      const updatedReactions = await storage.getMessageReactions(messageId);

      // Broadcast reaction update via Pusher with complete reaction data
      await pusher.trigger(`event-${eventId}`, 'reaction-update', {
        messageId: messageId,
        reactions: updatedReactions,
        userId: userId,
        action: reaction.action,
        emoji: emoji,
        timestamp: new Date().toISOString(),
      });

      res.json({ 
        ...reaction, 
        messageId: messageId,
        reactions: updatedReactions,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error("Error reacting to message:", error);
      res.status(500).json({ message: "Failed to react to message" });
    }
  });

  app.get('/api/events/:id/participants', async (req, res) => {
    try {
      const eventId = parseInt(req.params.id);
      const participants = await storage.getEventParticipantsWithUsers(eventId);
      res.json(participants);
    } catch (error) {
      console.error("Error fetching event participants:", error);
      res.status(500).json({ message: "Failed to fetch participants" });
    }
  });

  // Event Pool Management Routes
  app.get('/api/events/:id/stats', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const eventId = parseInt(req.params.id);
      const stats = await storage.getEventPoolStats(eventId);
      res.json(stats);
    } catch (error) {
      console.error("Error fetching event stats:", error);
      res.status(500).json({ message: "Failed to fetch event stats" });
    }
  });

  // Admin Route: Set event result and trigger payout
  app.post('/api/admin/events/:id/result', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user.claims.sub;
      const eventId = parseInt(req.params.id);
      const { result } = req.body; // true for YES, false for NO

      // Log admin action for audit trail
      console.log(`Admin ${userId} setting result for event ${eventId}: ${result ? 'YES' : 'NO'}`);

      // Validate event exists and is ready for payout
      const existingEvent = await storage.getEventById(eventId);
      if (!existingEvent) {
        return res.status(404).json({ message: "Event not found" });
      }

      if (existingEvent.adminResult !== null) {
        return res.status(400).json({ message: "Event result already set" });
      }

      const event = await storage.adminSetEventResult(eventId, result);
      const payoutResult = await storage.processEventPayout(eventId);

      // Log payout for audit trail
      console.log(`Event ${eventId} payout processed:`, {
        winnersCount: payoutResult.winnersCount,
        totalPayout: payoutResult.totalPayout,
        creatorFee: payoutResult.creatorFee,
        processedBy: userId,
        timestamp: new Date().toISOString()
      });

      // Send real-time notification to participants
      await pusher.trigger(`event-${eventId}`, 'event-resolved', {
        eventId,
        result: result ? 'YES' : 'NO',
        winnersCount: payoutResult.winnersCount,
        totalPayout: payoutResult.totalPayout,
        timestamp: new Date().toISOString()
      });

      res.json({ 
        event, 
        payout: payoutResult,
        message: `Event result set to ${result ? 'YES' : 'NO'}. Payout processed: ${payoutResult.winnersCount} winners received ₦${payoutResult.totalPayout.toLocaleString()} total, ₦${payoutResult.creatorFee.toLocaleString()} creator fee.`
      });
    } catch (error) {
      console.error("Error setting event result:", error);
      res.status(500).json({ message: error.message || "Failed to set event result" });
    }
  });

  // Private Event Management Routes
  app.get('/api/events/:id/join-requests', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user.claims.sub;
      const eventId = parseInt(req.params.id);

      // Check if user is the event creator
      const event = await storage.getEventById(eventId);
      if (!event || event.creatorId !== userId) {
        return res.status(403).json({ message: "Only event creator can view join requests" });
      }

      const requests = await storage.getEventJoinRequests(eventId);
      res.json(requests);
    } catch (error) {
      console.error("Error fetching join requests:", error);
      res.status(500).json({ message: "Failed to fetch join requests" });
    }
  });

  app.post('/api/events/join-requests/:id/approve', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user.claims.sub;
      const requestId = parseInt(req.params.id);

      // TODO: Add validation that user is the event creator

      const participant = await storage.approveEventJoinRequest(requestId);

      // Create notification for requester
      await storage.createNotification({
        userId: participant.userId,
        type: 'event_join_approved',
        title: 'Event Join Request Approved',
        message: `Your request to join the event has been approved!`,
        data: { eventId: participant.eventId },
      });

      res.json(participant);
    } catch (error) {
      console.error("Error approving join request:", error);
      res.status(500).json({ message: "Failed to approve join request" });
    }
  });

  app.post('/api/events/join-requests/:id/reject', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user.claims.sub;
      const requestId = parseInt(req.params.id);

      // TODO: Add validation that user is the event creator

      const rejectedRequest = await storage.rejectEventJoinRequest(requestId);

      // Create notification for requester
      await storage.createNotification({
        userId: rejectedRequest.userId,
        type: 'event_join_rejected',
        title: 'Event Join Request Rejected',
        message: `Your request to join the event has been rejected.`,
        data: { eventId: rejectedRequest.eventId },
      });

      res.json(rejectedRequest);
    } catch (error) {
      console.error("Error rejecting join request:", error);
      res.status(500).json({ message: "Failed to reject join request" });
    }
  });

  // Challenge routes
  app.get('/api/challenges', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user.claims.sub;
      const challenges = await storage.getChallenges(userId);
      res.json(challenges);
    } catch (error) {
      console.error("Error fetching challenges:", error);
      res.status(500).json({ message: "Failed to fetch challenges" });
    }
  });

  app.get('/api/challenges/:id', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const challengeId = parseInt(req.params.id);
      const challenge = await storage.getChallengeById(challengeId);

      if (!challenge) {
        return res.status(404).json({ message: "Challenge not found" });
      }

      res.json(challenge);
    } catch (error) {
      console.error("Error fetching challenge:", error);
      res.status(500).json({ message: "Failed to fetch challenge" });
    }
  });

  app.post('/api/challenges', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user.claims.sub;

      // Prepare data for validation
      const dataToValidate = {
        ...req.body,
        challenger: userId,
        amount: parseInt(req.body.amount), // Ensure it's an integer for coins
        dueDate: req.body.dueDate ? new Date(req.body.dueDate) : undefined // Convert string to Date
      };

      console.log('Challenge data to validate:', dataToValidate);

      const challengeData = insertChallengeSchema.parse(dataToValidate);
      const challenge = await storage.createChallenge(challengeData);

      // Get challenger and challenged user info
      const challenger = await storage.getUser(userId);
      const challenged = await storage.getUser(challenge.challenged);

      // Create notification for challenged user
      const challengedNotification = await storage.createNotification({
        userId: challenge.challenged,
        type: 'challenge',
        title: '🎯 New Challenge Request',
        message: `${challenger?.firstName || challenger?.username || 'Someone'} challenged you to "${challenge.title}"`,
        data: { 
          challengeId: challenge.id,
          challengerName: challenger?.firstName || challenger?.username,
          challengeTitle: challenge.title,
          amount: challenge.amount,
          type: challenge.type
        },
      });

      // Create notification for challenger (confirmation)
      const challengerNotification = await storage.createNotification({
        userId: userId,
        type: 'challenge_sent',
        title: '🚀 Challenge Sent',
        message: `Your challenge "${challenge.title}" was sent to ${challenged?.firstName || challenged?.username}`,
        data: { 
          challengeId: challenge.id,
          challengedName: challenged?.firstName || challenged?.username,
          challengeTitle: challenge.title,
          amount: challenge.amount,
          type: challenge.type
        },
      });

      // Send instant real-time notifications via Pusher
      try {
        await pusher.trigger(`user-${challenge.challenged}`, 'challenge-received', {
          id: challengedNotification.id,
          type: 'challenge_received',
          title: '🎯 Challenge Received!',
          message: `${challenger?.firstName || challenger?.username || 'Someone'} challenged you to "${challenge.title}"`,
          challengerName: challenger?.firstName || challenger?.username || 'Someone',
          challengeTitle: challenge.title,
          amount: parseFloat(challenge.amount),
          challengeId: challenge.id,
          data: challengedNotification.data,
          timestamp: new Date().toISOString(),
        });

        await pusher.trigger(`user-${userId}`, 'challenge-sent', {
          id: challengerNotification.id,
          type: 'challenge_sent',
          title: '🚀 Challenge Sent',
          message: `Your challenge "${challenge.title}" was sent to ${challenged?.firstName || challenged?.username}`,
          data: challengerNotification.data,
          timestamp: new Date().toISOString(),
        });
      } catch (pusherError) {
        console.error("Error sending Pusher notifications:", pusherError);
      }

      // Broadcast to Telegram channel
      const telegramBot = getTelegramBot();
      if (telegramBot && challenger && challenged) {
        try {
          await telegramBot.broadcastChallenge({
            id: challenge.id,
            title: challenge.title,
            description: challenge.description || undefined,
            creator: {
              name: challenger.firstName || challenger.username || 'Unknown',
              username: challenger.username || undefined,
            },
            challenged: {
              name: challenged.firstName || challenged.username || 'Unknown',
              username: challenged.username || undefined,
            },
            stake_amount: parseFloat(challenge.amount),
            status: challenge.status,
            end_time: challenge.dueDate,
            category: challenge.type,
          });
          console.log("📤 Challenge broadcasted to Telegram successfully");
        } catch (error) {
          console.error("❌ Failed to broadcast challenge to Telegram:", error);
        }
      }

      res.json(challenge);
    } catch (error) {
      console.error("Error creating challenge:", error);
      res.status(500).json({ message: "Failed to create challenge" });
    }
  });

  app.patch('/api/challenges/:id', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const challengeId = parseInt(req.params.id);
      const updates = req.body;
      const challenge = await storage.updateChallenge(challengeId, updates);
      res.json(challenge);
    } catch (error) {
      console.error("Error updating challenge:", error);
      res.status(500).json({ message: "Failed to update challenge" });
    }
  });

  app.post('/api/challenges/:id/accept', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const challengeId = parseInt(req.params.id);
      const userId = req.user.claims.sub;

      // Check user has enough coins before accepting
      const balance = await storage.getUserBalance(userId);
      const challengeData = await storage.getChallengeById(challengeId);
      const requiredCoins = parseInt(challengeData.amount.toString());

      if ((balance.coins || 0) < requiredCoins) {
        return res.status(400).json({ message: "Insufficient coins to accept this challenge" });
      }

      const challenge = await storage.acceptChallenge(challengeId, userId);

      // Get user info for notifications
      const challenger = await storage.getUser(challenge.challenger);
      const challenged = await storage.getUser(challenge.challenged);

      // Create notifications for both users
      await storage.createNotification({
        userId: challenge.challenger,
        type: 'challenge_accepted',
        title: '🎯 Challenge Accepted!',
        message: `${challenged?.firstName || challenged?.username} accepted your challenge "${challenge.title}"! The challenge is now active.`,
        data: { 
          challengeId: challengeId,
          challengeTitle: challenge.title,
          amount: parseFloat(challenge.amount),
          acceptedBy: challenged?.firstName || challenged?.username
        },
      });

      await storage.createNotification({
        userId: challenge.challenged,
        type: 'challenge_active',
        title: '🔒 Challenge Active',
        message: `Your stake of ₦${parseFloat(challenge.amount).toLocaleString()} has been escrowed for challenge "${challenge.title}". Good luck!`,
        data: { 
          challengeId: challengeId,
          challengeTitle: challenge.title,
          amount: parseFloat(challenge.amount)
        },
      });

      // Send real-time notifications via Pusher
      try {
        await pusher.trigger(`user-${challenge.challenger}`, 'challenge-accepted', {
          id: Date.now(),
          type: 'challenge_accepted',
          title: '🎯 Challenge Accepted!',
          message: `${challenged?.firstName || challenged?.username} accepted your challenge "${challenge.title}"!`,
          data: { challengeId: challengeId },
          timestamp: new Date().toISOString(),
        });

        await pusher.trigger(`user-${challenge.challenged}`, 'challenge-active', {
          id: Date.now(),
          type: 'challenge_active',
          title: '🔒 Challenge Active',
          message: `Challenge "${challenge.title}" is now active! Your funds are secured in escrow.`,
          data: { challengeId: challengeId },
          timestamp: new Date().toISOString(),
        });
      } catch (pusherError) {
        console.error("Error sending Pusher notifications:", pusherError);
      }

      // Broadcast matchmaking (challenge accepted) to Telegram
      try {
        const telegramBot = getTelegramBot();
        if (telegramBot) {
          await telegramBot.broadcastMatchmaking({
            challengeId: challenge.id,
            challenger: {
              name: challenger?.firstName || challenger?.username || 'Unknown',
              username: challenger?.username || undefined,
            },
            challenged: {
              name: challenged?.firstName || challenged?.username || 'Unknown',
              username: challenged?.username || undefined,
            },
            stake_amount: parseFloat(challenge.amount),
            category: challenge.type,
          });
          console.log('📤 Challenge acceptance (matchmaking) broadcasted to Telegram successfully');
        }
      } catch (telegramError) {
        console.error('❌ Error broadcasting matchmaking to Telegram:', telegramError);
      }

      res.json(challenge);
    } catch (error) {
      console.error("Error accepting challenge:", error);
      res.status(500).json({ message: error instanceof Error ? error.message : "Failed to accept challenge" });
    }
  });

  app.get('/api/challenges/:id/messages', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const challengeId = parseInt(req.params.id);
      const userId = req.user.claims.sub;

      // Verify user is part of the challenge
      const challenge = await storage.getChallengeById(challengeId);
      if (!challenge || (challenge.challenger !== userId && challenge.challenged !== userId)) {
        return res.status(403).json({ message: "Access denied" });
      }

      const messages = await storage.getChallengeMessages(challengeId);
      res.json(messages);
    } catch (error) {
      console.error("Error fetching challenge messages:", error);
      res.status(500).json({ message: "Failed to fetch challenge messages" });
    }
  });

  app.post('/api/challenges/:id/messages', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const challengeId = parseInt(req.params.id);
      const userId = req.user.claims.sub;
      const { message, type = 'text', evidence } = req.body;

      // Verify user is part of the challenge
      const challenge = await storage.getChallengeById(challengeId);
      if (!challenge || (challenge.challenger !== userId && challenge.challenged !== userId)) {
        return res.status(403).json({ message: "Access denied" });
      }

      const newMessage = await storage.createChallengeMessage(challengeId, userId, message);

      // Get user info for real-time message
      const user = await storage.getUser(userId);
      const messageWithUser = {
        ...newMessage,
        user: {
          id: user?.id,
          username: user?.username,
          firstName: user?.firstName,
          profileImageUrl: user?.profileImageUrl
        }
      };

      // Send real-time message to both participants
      const otherUserId = challenge.challenger === userId ? challenge.challenged : challenge.challenger;

      try {
        await pusher.trigger(`challenge-${challengeId}`, 'new-message', {
          message: messageWithUser,
          timestamp: new Date().toISOString(),
        });

        // Send notification to other participant
        await storage.createNotification({
          userId: otherUserId,
          type: 'challenge_message',
          title: '💬 New Challenge Message',
          message: `${user?.firstName || user?.username} sent a message in challenge "${challenge.title}"`,
          data: { 
            challengeId: challengeId,
            challengeTitle: challenge.title,
            messagePreview: message.substring(0, 50) + (message.length > 50 ? '...' : '')
          },
        });
      } catch (pusherError) {
        console.error("Error sending real-time message:", pusherError);
      }

      res.json(messageWithUser);
    } catch (error) {
      console.error("Error creating challenge message:", error);
      res.status(500).json({ message: "Failed to create message" });
    }
  });

  // Friend routes
  app.get('/api/friends', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user.claims.sub;
      const friends = await storage.getFriends(userId);
      res.json(friends);
    } catch (error) {
      console.error("Error fetching friends:", error);
      res.status(500).json({ message: "Failed to fetch friends" });
    }
  });

  app.post('/api/friends/request', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const requesterId = req.user.claims.sub;
      const { addresseeId } = req.body;

      const friendRequest = await storage.sendFriendRequest(requesterId, addresseeId);

      // Get requester info
      const requester = await storage.getUser(requesterId);

      // Create notification
      await storage.createNotification({
        userId: addresseeId,
        type: 'friend_request',
        title: '👋 Friend Request',
        message: `${requester?.firstName || requester?.username || 'Someone'} sent you a friend request!`,
        data: { 
          friendRequestId: friendRequest.id,
          requesterId: requesterId,
          requesterName: requester?.firstName || requester?.username
        },
      });

      // Send real-time notification via Pusher
      await pusher.trigger(`user-${addresseeId}`, 'friend-request', {
        title: '👋 Friend Request',
        message: `${requester?.firstName || requester?.username || 'Someone'} sent you a friend request!`,
        friendRequestId: friendRequest.id,
        requesterId: requesterId,
        requesterName: requester?.firstName || requester?.username,
        timestamp: new Date().toISOString(),
      });

      res.json(friendRequest);
    } catch (error) {
      console.error("Error sending friend request:", error);
      res.status(500).json({ message: "Failed to send friend request" });
    }
  });

  app.patch('/api/friends/:id/accept', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const friendRequestId = parseInt(req.params.id);
      const userId = req.user.claims.sub;
      const friend = await storage.acceptFriendRequest(friendRequestId);

      // Get user info
      const user = await storage.getUser(userId);
      const requester = await storage.getUser(friend.requesterId);

      // Create notification for requester
      await storage.createNotification({
        userId: friend.requesterId,
        type: 'friend_accepted',
        title: '✅ Friend Request Accepted',
        message: `${user?.firstName || user?.username || 'Someone'} accepted your friend request!`,
        data: { 
          friendId: userId,
          friendName: user?.firstName || user?.username
        },
      });

      // Send real-time notification via Pusher
      await pusher.trigger(`user-${friend.requesterId}`, 'friend-accepted', {
        title: '✅ Friend Request Accepted',
        message: `${user?.firstName || user?.username || 'Someone'} accepted your friend request!`,
        friendId: userId,
        friendName: user?.firstName || user?.username,
        timestamp: new Date().toISOString(),
      });

      res.json(friend);
    } catch (error) {
      console.error("Error accepting friend request:", error);
      res.status(500).json({ message: "Failed to accept friend request" });
    }
  });

  // Notification routes
  app.get('/api/notifications', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user.claims.sub;
      const notifications = await storage.getNotifications(userId);
      res.json(notifications);
    } catch (error) {
      console.error("Error fetching notifications:", error);
      res.status(500).json({ message: "Failed to fetch notifications" });
    }
  });

  app.patch('/api/notifications/:id/read', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const notificationId = parseInt(req.params.id);
      const notification = await storage.markNotificationRead(notificationId);
      res.json(notification);
    } catch (error) {
      console.error("Error marking notification as read:", error);
      res.status(500).json({ message: "Failed to mark notification as read" });
    }
  });

  // Transaction routes
  app.get('/api/transactions', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user.claims.sub;
      const transactions = await storage.getTransactions(userId);
      res.json(transactions);
    } catch (error) {
      console.error("Error fetching transactions:", error);
      res.status(500).json({ message: "Failed to fetch transactions" });
    }
  });

  app.get('/api/wallet/balance', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user.claims.sub;
      console.log(`Fetching balance for user: ${userId}`);
      
      const balance = await storage.getUserBalance(userId);
      console.log(`Balance result for user ${userId}:`, balance);
      
      res.json(balance);
    } catch (error) {
      console.error("Error fetching balance:", error);
      res.status(500).json({ message: "Failed to fetch balance" });
    }
  });

  // Wallet deposit route
  app.post('/api/wallet/deposit', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user.claims.sub;
      const { amount } = req.body;

      if (!amount || amount <= 0) {
        return res.status(400).json({ message: "Invalid amount" });      }

      if (!process.env.PAYSTACK_SECRET_KEY) {
        console.error("PAYSTACK_SECRET_KEY environment variable not set");
        return res.status(500).json({ message: "Payment service not configured" });
      }

      console.log("Initializing Paystack transaction for user:", userId, "amount:", amount);

      // Initialize Paystack transaction
      const paystackResponse = await fetch('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: req.user.claims.email,
          amount: amount * 100, // Paystack expects amount in kobo
          currency: 'NGN',
          reference: `dep_${userId}_${Date.now()}`,
          callback_url: `${process.env.FRONTEND_URL || 'https://'+req.get('host')}/wallet`,
          metadata: {
            userId,
            type: 'deposit'
          }
        })
      });

      const paystackData = await paystackResponse.json();
      console.log("Paystack response:", paystackData);

      if (!paystackData.status) {
        console.error("Paystack error:", paystackData);
        return res.status(400).json({ message: paystackData.message || "Failed to initialize payment" });
      }

      console.log("Sending authorization URL:", paystackData.data.authorization_url);
      res.json({ 
        authorization_url: paystackData.data.authorization_url,
        access_code: paystackData.data.access_code,
        reference: paystackData.data.reference,
        publicKey: process.env.PAYSTACK_PUBLIC_KEY || 'pk_test_' // You'll need to set this in secrets
      });
    } catch (error) {
      console.error("Error processing deposit:", error);
      res.status(500).json({ message: "Failed to process deposit" });
    }
  });

  // Paystack webhook for payment verification
  app.post('/api/webhook/paystack', async (req, res) => {
    try {
      const hash = req.headers['x-paystack-signature'];
      let event = req.body;

      console.log('Webhook received:', {
        headers: req.headers,
        bodyType: typeof event,
        hasBody: !!event
      });

      // If body is already parsed as object, use it directly
      if (typeof event === 'object' && event !== null) {
        console.log('Using pre-parsed webhook body');
      } else {
        // Handle string bodies
        const bodyString = typeof event === 'string' ? event : JSON.stringify(event);
        
        // Verify signature if secret key is available
        if (process.env.PAYSTACK_SECRET_KEY) {
          const expectedHash = require('crypto')
            .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
            .update(bodyString)
            .digest('hex');

          console.log('Signature verification:', {
            receivedHash: hash,
            expectedHash,
            match: hash === expectedHash
          });

          if (hash !== expectedHash) {
            console.log('Invalid webhook signature');
            return res.status(400).json({ message: "Invalid signature" });
          }
        }

        // Parse the event if it's a string
        try {
          event = JSON.parse(bodyString);
        } catch (parseError) {
          console.error('Failed to parse webhook body:', parseError);
          return res.status(400).json({ message: "Invalid JSON" });
        }
      }

      console.log('Webhook event:', event);

      if (event.event === 'charge.success') {
        const { reference, amount, metadata, status } = event.data;

        console.log('Processing charge.success:', {
          reference,
          amount,
          metadata,
          status
        });

        if (status === 'success' && metadata && metadata.userId) {
          const userId = metadata.userId;
          const depositAmount = amount / 100; // Convert from kobo to naira

          console.log(`Processing successful deposit for user ${userId}: ₦${depositAmount}`);

          try {
            // Create transaction record
            await storage.createTransaction({
              userId,
              type: 'deposit',
              amount: depositAmount.toString(),
              description: `Deposit via Paystack - ${reference}`,
              status: 'completed',
            });

            // Create notification for successful deposit
            await storage.createNotification({
              userId,
              type: 'deposit',
              title: '💰 Deposit Successful',
              message: `Your deposit of ₦${depositAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} has been credited to your account!`,
              data: { 
                amount: depositAmount,
                reference: reference,
                type: 'deposit',
                timestamp: new Date().toISOString()
              },
            });

            console.log(`✅ Deposit completed for user ${userId}: ₦${depositAmount}`);
          } catch (dbError) {
            console.error('Database error while creating transaction:', dbError);
            return res.status(500).json({ message: "Database error" });
          }
        } else {
          console.log('⚠️ Charge success but invalid status or missing metadata:', {
            status,
            hasMetadata: !!metadata,
            userId: metadata?.userId
          });
        }
      } else {
        console.log('Webhook event not charge.success:', event.event);
      }

      res.status(200).json({ message: "Webhook processed successfully" });
    } catch (error) {
      console.error("❌ Error processing webhook:", error);
      res.status(500).json({ message: "Webhook processing failed" });
    }
  });

  // Manual payment verification (for testing)
  app.post('/api/wallet/verify-payment', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const { reference } = req.body;
      const userId = req.user.claims.sub;

      if (!reference) {
        return res.status(400).json({ message: "Reference is required" });
      }

      console.log(`Manual verification requested for reference: ${reference} by user: ${userId}`);

      if (!process.env.PAYSTACK_SECRET_KEY) {
        console.error("PAYSTACK_SECRET_KEY not set");
        return res.status(500).json({ message: "Payment service not configured" });
      }

      // Verify payment with Paystack
      const verifyResponse = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        }
      });

      const verifyData = await verifyResponse.json();
      console.log('Paystack verification response:', {
        status: verifyData.status,
        data: verifyData.data ? {
          status: verifyData.data.status,
          amount: verifyData.data.amount,
          reference: verifyData.data.reference,
          metadata: verifyData.data.metadata
        } : null
      });

      if (verifyData.status && verifyData.data && verifyData.data.status === 'success') {
        const { amount, metadata, reference: txRef } = verifyData.data;
        const depositAmount = amount / 100; // Convert from kobo to naira

        console.log(`Processing payment verification:`, {
          amount: depositAmount,
          metadata,
          reference: txRef,
          requestedBy: userId
        });

        // Validate the user matches
        if (metadata && metadata.userId === userId) {
          // Check if transaction already exists by reference
          const existingTransactions = await storage.getTransactions(userId);
          const exists = existingTransactions.some((t: any) => 
            t.reference === reference || 
            t.description?.includes(reference) ||
            t.reference === txRef
          );

          if (!exists) {
            console.log(`Creating new deposit transaction for user ${userId}: ₦${depositAmount}`);
            
            const newTransaction = await storage.createTransaction({
              userId,
              type: 'deposit',
              amount: depositAmount.toString(),
              description: `Deposit via Paystack - ${reference}`,
              reference: reference,
              status: 'completed',
            });

            console.log(`Transaction created:`, newTransaction);

            // Verify the transaction was created
            const verifyTransactions = await storage.getTransactions(userId);
            console.log(`All transactions after creation:`, verifyTransactions.map(t => ({
              id: t.id,
              type: t.type,
              amount: t.amount,
              status: t.status,
              reference: t.reference
            })));

            // Get updated balance
            const updatedBalance = await storage.getUserBalance(userId);
            console.log(`Updated balance for user ${userId}:`, updatedBalance);

            // Create notification for successful deposit
            await storage.createNotification({
              userId,
              type: 'deposit',
              title: '💰 Deposit Successful',
              message: `Your deposit of ₦${depositAmount.toLocaleString()} has been credited to your account!`,
              data: { 
                amount: depositAmount,
                reference: reference,
                type: 'deposit',
                timestamp: new Date().toISOString()
              },
            });

            console.log(`✅ Manual verification completed for user ${userId}: ₦${depositAmount}`);
            res.json({ 
              message: "Payment verified successfully", 
              amount: depositAmount,
              newBalance: updatedBalance 
            });
          } else {
            console.log(`Transaction with reference ${reference} already exists for user ${userId}`);
            const currentBalance = await storage.getUserBalance(userId);
            res.json({ 
              message: "Payment already processed", 
              amount: depositAmount,
              currentBalance: currentBalance 
            });
          }
        } else {
          console.log('Metadata validation failed:', {
            metadataUserId: metadata?.userId,
            requestUserId: userId,
            hasMetadata: !!metadata
          });
          res.status(400).json({ message: "Payment verification failed - user mismatch" });
        }
      } else {
        console.log('Payment verification failed:', {
          paystackStatus: verifyData.status,
          dataStatus: verifyData.data?.status,
          message: verifyData.message
        });
        res.status(400).json({ message: verifyData.message || "Payment verification failed" });
      }
    } catch (error) {
      console.error("Error verifying payment:", error);
      res.status(500).json({ message: "Failed to verify payment" });
    }
  });

  // Wallet withdrawal route
  app.post('/api/wallet/withdraw', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user.claims.sub;
      const { amount, method } = req.body;

      if (!amount || amount <= 0) {
        return res.status(400).json({ message: "Invalid amount" });
      }

      const balance = await storage.getUserBalance(userId);
      if (balance.balance < amount) {
        return res.status(400).json({ message: "Insufficient balance" });
      }

      // Create withdrawal transaction
      await storage.createTransaction({
        userId,
        type: 'withdrawal',
        amount: `-${amount}`,
        description: `Withdrawal via ${method}`,
        status: 'pending',
      });

      // Create notification
      await storage.createNotification({
        userId,
        type: 'withdrawal',
        title: '📤 Withdrawal Requested',
        message: `Your withdrawal of ₦${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} is being processed.`,
        data: { amount, method },
      });

      res.json({ message: "Withdrawal request submitted successfully" });
    } catch (error) {
      console.error("Error processing withdrawal:", error);
      res.status(500).json({ message: "Failed to process withdrawal" });
    }
  });

  // Global chat routes
  app.get('/api/chat/messages', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const messages = await storage.getGlobalChatMessages(50);
      res.json(messages);
    } catch (error) {
      console.error("Error fetching global chat messages:", error);
      res.status(500).json({ message: "Failed to fetch messages" });
    }
  });

  app.post('/api/chat/messages', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user.claims.sub;
      const { message } = req.body;

      if (!message?.trim()) {
        return res.status(400).json({ message: "Message content is required" });
      }

      // Get user info
      const user = await storage.getUser(userId);

      // Create message in BetChat
      const newMessage = await storage.createGlobalChatMessage({
        userId,
        user: {
          id: user?.id,
          firstName: user?.firstName,
          lastName: user?.lastName,
          username: user?.username,
          profileImageUrl: user?.profileImageUrl,
        },
        message: message.trim(),
        source: 'betchat'
      });

      // Broadcast to BetChat users via Pusher
      await pusher.trigger('global-chat', 'new-message', {
        type: 'chat_message',
        message: newMessage,
        source: 'betchat'
      });

      // Forward to Telegram if sync is available
      const sync = initializeTelegramSync();
      if (sync && sync.isReady()) {
        const senderName = user?.firstName || user?.username || 'BetChat User';
        await sync.sendMessageToTelegram(message.trim(), senderName);
      }

      res.json(newMessage);
    } catch (error) {
      console.error("Error creating global chat message:", error);
      res.status(500).json({ message: "Failed to create message" });
    }
  });

  // Telegram sync status route
  app.get('/api/telegram/status', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const sync = initializeTelegramSync();
      const telegramBot = getTelegramBot();

      let syncStatus = { 
        enabled: false, 
        connected: false, 
        message: "Telegram sync not configured" 
      };

      let botStatus = { 
        enabled: false, 
        connected: false, 
        message: "Telegram bot not configured" 
      };

      if (sync) {
        const isReady = sync.isReady();
        const groupInfo = isReady ? await sync.getGroupInfo() : null;
        syncStatus = {
          enabled: true,
          connected: isReady,
          groupInfo,
          message: isReady ? "Connected and syncing" : "Connecting..."
        };
      }

      if (telegramBot) {
        const connection = await telegramBot.testConnection();
        const channelInfo = connection ? await telegramBot.getChannelInfo() : null;
        botStatus = {
          enabled: true,
          connected: connection,
          channelInfo,
          message: connection ? "Bot connected and ready for broadcasting" : "Bot connection failed"
        };
      }

      res.json({
        sync: syncStatus,
        bot: botStatus
      });
    } catch (error) {
      console.error("Error getting Telegram status:", error);
      res.status(500).json({ message: "Failed to get Telegram status" });
    }
  });

  // Test Telegram broadcast endpoint
  app.post('/api/telegram/test-broadcast', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const telegramBot = getTelegramBot();

      if (!telegramBot) {
        return res.status(400).json({ message: "Telegram bot not configured" });
      }

      const message = req.body.message || "🧪 Test message from BetChat";
      const success = await telegramBot.sendCustomMessage(message);

      res.json({ 
        success, 
        message: success ? "Message sent successfully" : "Failed to send message - Make sure bot is added to your channel as admin" 
      });
    } catch (error) {
      console.error("Error testing Telegram broadcast:", error);
      res.status(500).json({ message: "Failed to test Telegram broadcast" });
    }
  });

  // Broadcast existing events to Telegram channel
  app.post('/api/telegram/broadcast-existing', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const telegramBot = getTelegramBot();

      if (!telegramBot) {
        return res.status(400).json({ message: "Telegram bot not configured" });
      }

      // Get all existing events
      const existingEvents = await storage.getEvents();
      let successCount = 0;
      let totalCount = existingEvents.length;

      for (const event of existingEvents) {
        try {
          // Get creator info
          const creator = await storage.getUser(event.creatorId);

          const success = await telegramBot.broadcastEvent({
            id: event.id,
            title: event.title,
            description: event.description || undefined,
            creator: {
              name: creator?.firstName || creator?.username || 'Unknown',
              username: creator?.username || undefined,
            },
            entryFee: event.entryFee.toString(),
            endDate: event.endDate.toISOString(),
            is_private: event.isPrivate,
            max_participants: event.maxParticipants,
            category: event.category,
          });

          if (success) {
            successCount++;
          }

          // Add small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          console.error(`Failed to broadcast event ${event.id}:`, error);
        }
      }

      res.json({ 
        success: successCount > 0, 
        message: `Broadcasted ${successCount} out of ${totalCount} existing events`,
        details: { successCount, totalCount }
      });
    } catch (error) {
      console.error("Error broadcasting existing events:", error);
      res.status(500).json({ message: "Failed to broadcast existing events" });
    }
  });

  // Follow/Unfollow user route
  app.post('/api/users/:userId/follow', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const followerId = req.user.claims.sub;
      const followingId = req.params.userId;

      if (followerId === followingId) {
        return res.status(400).json({ message: "Cannot follow yourself" });
      }

      const result = await storage.toggleFollow(followerId, followingId);

      if (result.action === 'followed') {
        // Get follower info
        const follower = await storage.getUser(followerId);

        // Create notification for followed user
        await storage.createNotification({
          userId: followingId,
          type: 'new_follower',
          title: '👤 New Follower',
          message: `@${follower?.firstName || follower?.username || 'Someone'} is now following you!`,
          data: { 
            followerId: followerId,
            followerName: follower?.firstName || follower?.username
          },
        });

        // Send real-time notification via Pusher
        await pusher.trigger(`user-${followingId}`, 'new-follower', {
          title: '👤 New Follower',
          message: `@${follower?.firstName || follower?.username || 'Someone'} is now following you!`,
          followerId: followerId,
          followerName: follower?.firstName || follower?.username,
          timestamp: new Date().toISOString(),
        });
      }

      res.json(result);
    } catch (error) {
      console.error("Error toggling follow:", error);
      res.status(500).json({ message: "Failed to toggle follow" });
    }
  });

  // Get user profile route
  app.get('/api/users/:userId', async (req, res) => {
    try {
      const userId = req.params.userId;
      const user = await storage.getUser(userId);

      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      res.json(user);
    } catch (error) {
      console.error("Error fetching user:", error);
      res.status(500).json({ message: "Failed to fetch user" });
    }
  });

  // Tip user route
  app.post('/api/users/:userId/tip', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const senderId = req.user.claims.sub;
      const receiverId = req.params.userId;
      const { amount } = req.body;

      if (!amount || amount <= 0) {
        return res.status(400).json({ message: "Invalid amount" });
      }

      if (senderId === receiverId) {
        return res.status(400).json({ message: "Cannot tip yourself" });
      }

      const balanceResult = await storage.getUserBalance(senderId);
      if (balanceResult.balance < amount) {
        return res.status(400).json({ message: "Insufficient balance" });
      }

      // Get sender and receiver info
      const sender = await storage.getUser(senderId);
      const receiver = await storage.getUser(receiverId);

      // Create transactions
      await storage.createTransaction({
        userId: senderId,
        type: 'tip_sent',
        amount: `-${amount}`,
        description: `Tip sent to @${receiver?.firstName || receiver?.username || 'user'}`,
        relatedId: receiverId,
      });

      await storage.createTransaction({
        userId: receiverId,
        type: 'tip_received',
        amount: amount.toString(),
        description: `Tip received from @${sender?.firstName || sender?.username || 'user'}`,
        relatedId: senderId,
      });

      // Create notification for receiver
      await storage.createNotification({
        userId: receiverId,
        type: 'tip_received',
        title: '💰 Tip Received',
        message: `You received a tip of ₦${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} from @${sender?.firstName || sender?.username || 'Someone'}!`,
        data: { 
          amount: amount,
          senderId: senderId,
          senderName: sender?.firstName || sender?.username
        },
      });

      // Create notification for sender (confirmation)
      await storage.createNotification({
        userId: senderId,
        type: 'tip_sent',
        title: '💸 Tip Sent',
        message: `You tipped @${receiver?.firstName || receiver?.username || 'User'} ₦${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}!`,
        data: { 
          amount: amount,
          receiverId: receiverId,
          receiverName: receiver?.firstName || receiver?.username
        },
      });

      // Send real-time notifications via Pusher
      await pusher.trigger(`user-${receiverId}`, 'tip-received', {
        title: '💰 Tip Received',
        message: `You received a tip of ₦${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} from @${sender?.firstName || sender?.username || 'Someone'}!`,
        amount: amount,
        senderId: senderId,
        senderName: sender?.firstName || sender?.username,
        timestamp: new Date().toISOString(),
      });

      await pusher.trigger(`user-${senderId}`, 'tip-sent', {
        title: '💸 Tip Sent',
        message: `You tipped @${receiver?.firstName || receiver?.username || 'User'} ₦${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}!`,
        amount: amount,
        receiverId: receiverId,
        receiverName: receiver?.firstName || receiver?.username,
        timestamp: new Date().toISOString(),
      });

      res.json({ message: "Tip sent successfully" });
    } catch (error) {
      console.error("Error sending tip:", error);
      res.status(500).json({ message: "Failed to send tip" });
    }
  });

  // Daily Sign-In Routes
  app.get('/api/daily-signin/status', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user.claims.sub;
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // Check if user has already signed in today
      const todayLogin = await db
        .select()
        .from(dailyLogins)
        .where(and(
          eq(dailyLogins.userId, userId),
          sql`DATE(${dailyLogins.date}) = ${today.toISOString().split('T')[0]}`
        ))
        .limit(1);

      const hasSignedInToday = todayLogin.length > 0;
      const hasClaimed = hasSignedInToday ? todayLogin[0].claimed : false;

      // Get current streak
      const latestLogin = await db
        .select()
        .from(dailyLogins)
        .where(eq(dailyLogins.userId, userId))
        .orderBy(sql`${dailyLogins.date} DESC`)
        .limit(1);

      let currentStreak = 1;
      if (latestLogin.length > 0) {
        currentStreak = latestLogin[0].streak;

        // If they haven't signed in today, reset streak if yesterday wasn't their last login
        if (!hasSignedInToday) {
          const yesterday = new Date(today);
          yesterday.setDate(yesterday.getDate() - 1);

          const lastLoginDate = new Date(latestLogin[0].date);
          lastLoginDate.setHours(0, 0, 0, 0);

          if (lastLoginDate.getTime() !== yesterday.getTime()) {
            currentStreak = 1; // Reset streak
          } else {
            currentStreak = latestLogin[0].streak + 1; // Continue streak
          }
        }
      }

      // Calculate points to award (base 50 + streak bonus)
      const basePoints = 50;
      const streakBonus = Math.min(currentStreak * 10, 200); // Max 200 bonus
      const pointsToAward = basePoints + streakBonus;

      res.json({
        hasSignedInToday,
        hasClaimed,
        currentStreak,
        pointsToAward,
        showModal: hasSignedInToday && !hasClaimed
      });
    } catch (error) {
      console.error("Error checking daily sign-in status:", error);
      res.status(500).json({ message: "Failed to check daily sign-in status" });
    }
  });

  app.post('/api/daily-signin/claim', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user.claims.sub;
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // Check if already claimed today
      const todayLogin = await db
        .select()
        .from(dailyLogins)
        .where(and(
          eq(dailyLogins.userId, userId),
          sql`DATE(${dailyLogins.date}) = ${today.toISOString().split('T')[0]}`
        ))
        .limit(1);

      if (todayLogin.length === 0) {
        return res.status(400).json({ message: "No sign-in record found for today" });
      }

      if (todayLogin[0].claimed) {
        return res.status(400).json({ message: "Daily bonus already claimed" });
      }

      const pointsEarned = todayLogin[0].pointsEarned;

      // Mark as claimed and award points
      await db
        .update(dailyLogins)
        .set({ claimed: true })
        .where(eq(dailyLogins.id, todayLogin[0].id));

      // Add points to user balance
      await db
        .update(users)
        .set({ 
          points: sql`${users.points} + ${pointsEarned}`,
          updatedAt: new Date()
        })
        .where(eq(users.id, userId));

      // Create transaction record
      await storage.createTransaction({
        userId,
        type: 'daily_signin',
        amount: pointsEarned.toString(),
        description: `Daily sign-in bonus - Day ${todayLogin[0].streak}`,
        status: 'completed'
      });

      res.json({ 
        message: "Daily bonus claimed successfully",
        pointsEarned,
        streak: todayLogin[0].streak
      });
    } catch (error) {
      console.error("Error claiming daily sign-in:", error);
      res.status(500).json({ message: "Failed to claim daily sign-in bonus" });
    }
  });

  // Get all users route (for user search and listing)
  app.get('/api/users', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const users = await storage.getAllUsers();
      res.json(users);
    } catch (error) {
      console.error("Error fetching users:", error);
      res.status(500).json({ message: "Failed to fetch users" });
    }
  });

  // User stats and history routes
  app.get('/api/user/stats', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user.claims.sub;
      const stats = await storage.getUserStats(userId);
      res.json(stats);
    } catch (error) {
      console.error("Error fetching user stats:", error);
      res.status(500).json({ message: "Failed to fetch user stats" });
    }
  });

  app.get('/api/user/created-events', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user.claims.sub;
      const events = await storage.getUserCreatedEvents(userId);
      res.json(events);
    } catch (error) {
      console.error("Error fetching user created events:", error);
      res.status(500).json({ message: "Failed to fetch user created events" });
    }
  });

  app.get('/api/user/joined-events', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user.claims.sub;
      const events = await storage.getUserJoinedEvents(userId);
      res.json(events);
    } catch (error) {
      console.error("Error fetching user joined events:", error);
      res.status(500).json({ message: "Failed to fetch user joined events" });
    }
  });



  app.get('/api/user/achievements', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user.claims.sub;
      const achievements = await storage.getUserAchievements(userId);
      res.json(achievements);
    } catch (error) {
      console.error("Error fetching user achievements:", error);
      res.status(500).json({ message: "Failed to fetch user achievements" });
    }
  });

  app.get('/api/users/:userId/profile', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.params.userId;
      const currentUserId = req.user.claims.sub;
      const profile = await storage.getUserProfile(userId, currentUserId);
      res.json(profile);
    } catch (error) {
      console.error("Error fetching user profile:", error);
      res.status(500).json({ message: "Failed to fetch user profile" });
    }
  });

  // Event lifecycle management routes
  app.post('/api/admin/events/:id/notify-starting', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const eventId = parseInt(req.params.id);
      await storage.notifyEventStarting(eventId);
      res.json({ message: "Event starting notifications sent" });
    } catch (error) {
      console.error("Error sending event starting notifications:", error);
      res.status(500).json({ message: "Failed to send notifications" });
    }
  });

  app.post('/api/admin/events/:id/notify-ending', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const eventId = parseInt(req.params.id);
      await storage.notifyEventEnding(eventId);
      res.json({ message: "Event ending notifications sent" });
    } catch (error) {
      console.error("Error sending event ending notifications:", error);
      res.status(500).json({ message: "Failed to send notifications" });
    }
  });

  // Admin event management routes
  app.delete('/api/admin/events/:id', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const eventId = parseInt(req.params.id);
      await storage.deleteEvent(eventId);
      res.json({ message: "Event deleted successfully" });
    } catch (error) {
      console.error("Error deleting event:", error);
      res.status(500).json({ message: "Failed to delete event" });
    }
  });

  app.patch('/api/admin/events/:id/chat', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const eventId = parseInt(req.params.id);
      const { enabled } = req.body;
      await storage.toggleEventChat(eventId, enabled);
      res.json({ message: `Event chat ${enabled ? 'enabled' : 'disabled'}`, enabled });
    } catch (error) {
      console.error("Error toggling event chat:", error);
      res.status(500).json({ message: "Failed to toggle event chat" });
    }
  });

  // Admin challenge management routes
  app.delete('/api/admin/challenges/:id', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const challengeId = parseInt(req.params.id);
      await storage.deleteChallenge(challengeId);
      res.json({ message: "Challenge deleted successfully" });
    } catch (error) {
      console.error("Error deleting challenge:", error);
      res.status(500).json({ message: "Failed to delete challenge" });
    }
  });

  // Admin statistics routes
  app.get('/api/admin/stats', isAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const stats = await storage.getAdminStats();
      res.json(stats);
    } catch (error) {
      console.error("Error fetching admin stats:", error);
      res.status(500).json({ message: "Failed to fetch admin stats" });
    }
  });

  // Get current admin users
  app.get('/api/admin/list', isAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const admins = await storage.getAdminUsers();
      res.json(admins);
    } catch (error) {
      console.error("Error fetching admin users:", error);
      res.status(500).json({ message: "Failed to fetch admin users" });
    }
  });

  // Public profile routes (no authentication required)
  app.get('/api/public/profile/:username', async (req, res) => {
    try {
      const { username } = req.params;
      
      // Get user by username
      const user = await storage.getUserByUsername(username);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      // Get user stats
      const stats = await storage.getUserStats(user.id);

      // Return public profile data (excluding sensitive information)
      const publicProfile = {
        id: user.id,
        username: user.username,
        firstName: user.firstName,
        profileImageUrl: user.profileImageUrl,
        level: user.level,
        xp: user.xp,
        streak: user.streak,
        createdAt: user.createdAt,
        stats: {
          wins: stats.wins || 0,
          activeChallenges: stats.activeChallenges || 0,
          totalEarnings: stats.totalEarnings || 0,
        }
      };

      res.json(publicProfile);
    } catch (error) {
      console.error("Error fetching public profile:", error);
      res.status(500).json({ message: "Failed to fetch public profile" });
    }
  });

  app.get('/api/public/achievements/:username', async (req, res) => {
    try {
      const { username } = req.params;
      
      // Get user by username
      const user = await storage.getUserByUsername(username);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      // Get user achievements
      const achievements = await storage.getUserAchievements(user.id);
      res.json(achievements);
    } catch (error) {
      console.error("Error fetching public achievements:", error);
      res.status(500).json({ message: "Failed to fetch public achievements" });
    }
  });

  app.get('/api/public/events/:username', async (req, res) => {
    try {
      const { username } = req.params;
      
      // Get user by username
      const user = await storage.getUserByUsername(username);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      // Get user's public events (recent 10)
      const events = await storage.getUserCreatedEvents(user.id);
      
      // Filter out private events and return only public data
      const publicEvents = events
        .filter((event: any) => !event.isPrivate)
        .slice(0, 10)
        .map((event: any) => ({
          id: event.id,
          title: event.title,
          category: event.category,
          status: event.status,
          createdAt: event.createdAt,
          endDate: event.endDate,
        }));

      res.json(publicEvents);
    } catch (error) {
      console.error("Error fetching public events:", error);
      res.status(500).json({ message: "Failed to fetch public events" });
    }
  });

  // Temporary debug route to check admin status (remove after use)
  app.get('/api/debug/admin-check', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      const allAdmins = await storage.getAdminUsers();

      res.json({
        currentUser: {
          id: userId,
          isAdmin: user?.isAdmin || false,
          username: user?.username,
          firstName: user?.firstName
        },
        totalAdmins: allAdmins.length,        adminUsers: allAdmins.map(admin => ({
          id: admin.id,
          username: admin.username,
          firstName: admin.firstName
        }))
      });
    } catch (error) {
      console.error("Error in admin debug check:", error);
      res.status(500).json({ message: "Failed to check admin status" });
    }
  });

  // Admin settings routes
  app.get('/api/admin/settings', isAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const settings = await storage.getPlatformSettings();
      res.json(settings);
    } catch (error) {
      console.error("Error fetching platform settings:", error);
      res.status(500).json({ message: "Failed to fetch platform settings" });
    }
  });

  app.patch('/api/admin/settings', isAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const updatedSettings = await storage.updatePlatformSettings(req.body);
      res.json(updatedSettings);
    } catch (error) {
      console.error("Error updating platform settings:", error);
      res.status(500).json({ message: "Failed to update platform settings" });
    }
  });

  app.get('/api/admin/users', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const users = await storage.getRecentUsers(limit);
      res.json(users);
    } catch (error) {
      console.error("Error fetching admin users:", error);
      res.status(500).json({ message: "Failed to fetch users" });
    }
  });

  app.post('/api/admin/users/:userId/action', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const { userId } = req.params;
      const { action, value, reason } = req.body;

      let result;
      switch (action) {
        case 'ban':
          result = await storage.banUser(userId, reason);
          break;
        case 'unban':
          result = await storage.unbanUser(userId, reason);
          break;
        case 'balance':
          result = await storage.adjustUserBalance(userId, parseFloat(value), reason);
          break;
        case 'admin':
          result = await storage.setUserAdminStatus(userId, value === 'true', reason);
          break;
        case 'message':
          result = await storage.sendAdminMessage(userId, value, reason);
          break;
        default:
          return res.status(400).json({ message: "Invalid action type" });
      }

      res.json(result);
    } catch (error) {
      console.error("Error executing user action:", error);
      res.status(500).json({ message: "Failed to execute user action" });
    }
  });

  app.get('/api/admin/activity', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const activity = await storage.getPlatformActivity(limit);
      res.json(activity);
    } catch (error) {
      console.error("Error fetching platform activity:", error);
      res.status(500).json({ message: "Failed to fetch activity" });
    }
  });

  // Admin challenge routes
  app.get('/api/admin/challenges', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const challenges = await storage.getAllChallenges(limit);
      res.json(challenges);
    } catch (error) {
      console.error("Error fetching admin challenges:", error);
      res.status(500).json({ message: "Failed to fetch challenges" });
    }
  });

  app.post('/api/admin/challenges/:id/result', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user.claims.sub;
      const challengeId = parseInt(req.params.id);
      const { result } = req.body; // 'challenger_won', 'challenged_won', 'draw'

      if (!['challenger_won', 'challenged_won', 'draw'].includes(result)) {
        return res.status(400).json({ message: "Invalid result. Must be 'challenger_won', 'challenged_won', or 'draw'" });
      }

      // Log admin action for audit trail
      console.log(`Admin ${userId} setting result for challenge ${challengeId}: ${result}`);

      // Validate challenge exists and is ready for payout
      const existingChallenge = await storage.getChallengeById(challengeId);
      if (!existingChallenge) {
        return res.status(404).json({ message: "Challenge not found" });
      }

      if (existingChallenge.status === 'completed') {
        return res.status(400).json({ message: "Challenge already completed" });
      }

      const challenge = await storage.adminSetChallengeResult(challengeId, result);
      const payoutResult = await storage.processChallengePayouts(challengeId);

      // Log payout for audit trail
      console.log(`Challenge ${challengeId} payout processed:`, {
        winnerPayout: payoutResult.winnerPayout,
        platformFee: payoutResult.platformFee,
        winnerId: payoutResult.winnerId,
        processedBy: userId,
        timestamp: new Date().toISOString()
      });

      // Send real-time notification to participants
      await pusher.trigger(`challenge-${challengeId}`, 'challenge-resolved', {
        challengeId,
        result,
        winnerPayout: payoutResult.winnerPayout,
        platformFee: payoutResult.platformFee,
        timestamp: new Date().toISOString()
      });

      // Broadcast challenge result to Telegram
      try {
        const challengerUser = await storage.getUser(existingChallenge.challenger);
        const challengedUser = await storage.getUser(existingChallenge.challenged);

        const telegramBot = getTelegramBot();
        if (telegramBot && challengerUser && challengedUser) {
          // Determine winner and loser for Telegram broadcast
          let winner, loser;
          if (result === 'challenger_won') {
            winner = challengerUser;
            loser = challengedUser;
          } else if (result === 'challenged_won') {
            winner = challengedUser;
            loser = challengerUser;
          } else {
            // Draw case - both are equal
            winner = challengerUser;
            loser = challengedUser;
          }

          await telegramBot.broadcastChallengeResult({
            id: challengeId,
            title: existingChallenge.title,
            winner: {
              name: winner.firstName || winner.username || 'Unknown',
              username: winner.username || undefined,
            },
            loser: {
              name: loser.firstName || loser.username || 'Unknown',
              username: loser.username || undefined,
            },
            stake_amount: parseFloat(existingChallenge.amount),
            category: existingChallenge.type,
            result_type: result,
          });
          console.log('📤 Challenge result broadcasted to Telegram successfully');
        }
      } catch (telegramError) {
        console.error('❌ Error broadcasting challenge result to Telegram:', telegramError);
      }

      res.json({ 
        challenge, 
        payout: payoutResult,
        message: `Challenge result set to ${result}. Payout processed: ₦${payoutResult.winnerPayout.toLocaleString()} distributed, ₦${payoutResult.platformFee.toLocaleString()} platform fee.`
      });
    } catch (error) {
      console.error("Error setting challenge result:", error);
      res.status(500).json({ message: error.message || "Failed to set challenge result" });
    }
  });

  app.get('/api/admin/challenges/:id/escrow', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const challengeId = parseInt(req.params.id);
      const escrowStatus = await storage.getChallengeEscrowStatus(challengeId);
      res.json(escrowStatus);
    } catch (error) {
      console.error("Error fetching challenge escrow status:", error);
      res.status(500).json({ message: "Failed to fetch escrow status" });
    }
  });

  // Admin notifications routes
  app.get('/api/admin/notifications', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const notifications = await storage.getAdminNotifications(limit);
      res.json(notifications);
    } catch (error) {
      console.error("Error fetching admin notifications:", error);
      res.status(500).json({ message: "Failed to fetch notifications" });
    }
  });

  app.post('/api/admin/notifications/broadcast', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const { title, message, type, targetUserIds } = req.body;

      const result = await storage.broadcastNotification({
        title,
        message,
        type: type || 'admin_announcement',
        targetUserIds: targetUserIds || null, // null means all users
      });

      res.json(result);
    } catch (error) {
      console.error("Error broadcasting notification:", error);
      res.status(500).json({ message: "Failed to broadcast notification" });
    }
  });

  // Admin user search routes
  app.get('/api/admin/users/search', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const { query, limit = 50 } = req.query;

      if (!query || typeof query !== 'string') {
        return res.status(400).json({ message: "Search query is required" });
      }

      const users = await storage.searchUsers(query, parseInt(limit as string));
      res.json(users);
    } catch (error) {
      console.error("Error searching users:", error);
      res.status(500).json({ message: "Failed to search users" });
    }
  });

  // Leaderboard route
  app.get('/api/leaderboard', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const leaderboard = await storage.getLeaderboard();
      res.json(leaderboard);
    } catch (error) {
      console.error("Error fetching leaderboard:", error);
      res.status(500).json({ message: "Failed to fetch leaderboard" });
    }
  });

  // Friends Performance Comparison API
  app.get('/api/friends/performance', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user.claims.sub;

      // Get user's friends
      const friendsData = await storage.getFriends(userId);
      const acceptedFriends = friendsData.filter((f: any) => f.status === 'accepted');

      if (acceptedFriends.length === 0) {
        return res.json({ 
          message: "No friends found", 
          userStats: null,
          friendsStats: [],
          comparison: null
        });
      }

      // Get friend IDs
      const friendIds = acceptedFriends.map((f: any) => 
        f.requesterId === userId ? f.addresseeId : f.requesterId
      );

      // Get current user's performance stats
      const userStats = await storage.getUserStats(userId);

      // Get friends' performance stats
      const friendsStats = await Promise.all(
        friendIds.map(async (friendId: string) => {
          const friend = await storage.getUser(friendId);
          const stats = await storage.getUserStats(friendId);
          return {
            id: friendId,
            name: friend?.firstName || friend?.username || 'Unknown',
            profileImageUrl: friend?.profileImageUrl,
            level: friend?.level || 1,
            xp: friend?.xp || 0,
            stats: stats
          };
        })
      );

      // Calculate performance comparison
      const currentUser = await storage.getUser(userId);
      const userPerformance = {
        id: userId,
        name: currentUser?.firstName || currentUser?.username || 'You',
        profileImageUrl: currentUser?.profileImageUrl,
        level: currentUser?.level || 1,
        xp: currentUser?.xp || 0,
        stats: userStats
      };

      // Calculate rankings
      const allUsers = [userPerformance, ...friendsStats];

      const winRateRanking = allUsers
        .map(u => ({
          ...u,
          winRate: u.stats.totalBets > 0 ? (u.stats.wins / u.stats.totalBets * 100) : 0
        }))
        .sort((a, b) => b.winRate - a.winRate);

      const xpRanking = allUsers.sort((a, b) => b.xp - a.xp);
      const levelRanking = allUsers.sort((a, b) => b.level - a.level);

      const comparison = {
        winRateRank: winRateRanking.findIndex(u => u.id === userId) + 1,
        xpRank: xpRanking.findIndex(u => u.id === userId) + 1,
        levelRank: levelRanking.findIndex(u => u.id === userId) + 1,
        totalFriends: friendsStats.length,
        rankings: {
          winRate: winRateRanking,
          xp: xpRanking,
          level: levelRanking
        }
      };

      res.json({
        userStats: userPerformance,
        friendsStats,
        comparison
      });
    } catch (error) {
      console.error("Error fetching friends performance:", error);
      res.status(500).json({ message: "Failed to fetch friends performance" });
    }
  });

  // Admin Tools - Event Fund Management
  app.post('/api/admin/events/add-funds', isAdmin, async (req, res) => {
    try {
      const { eventId, amount } = req.body;

      if (!eventId || !amount || amount <= 0) {
        return res.status(400).json({ message: 'Invalid event ID or amount' });
      }

      await storage.addEventFunds(eventId, amount);
      res.json({ message: 'Funds added successfully' });
    } catch (error) {
      console.error('Error adding event funds:', error);
      res.status(500).json({ message: 'Failed to add event funds' });
    }
  });

  // Admin Tools - User Points
  app.post('/api/admin/users/give-points', isAdmin, async (req, res) => {
    try {
      const { userId, points } = req.body;

      if (!userId || !points || points <= 0) {
        return res.status(400).json({ message: 'Invalid user ID or points amount' });
      }

      await storage.giveUserPoints(userId, points);
      res.json({ message: 'Points given successfully' });
    } catch (error) {
      console.error('Error giving user points:', error);
      res.status(500).json({ message: 'Failed to give user points' });
    }
  });

  // Admin Tools - Give User Coins
  app.post('/api/admin/users/give-coins', isAdmin, async (req, res) => {
    try {
      const { userId, coins } = req.body;

      if (!userId || !coins || coins <= 0) {
        return res.status(400).json({ message: 'Invalid user ID or coins amount' });
      }

      await db
        .update(users)
        .set({ 
          coins: sql`${users.coins} + ${coins}`,
          updatedAt: new Date()
        })
        .where(eq(users.id, userId));

      // Create transaction record
      await storage.createTransaction({
        userId,
        type: 'admin_gift',
        amount: coins.toString(),
        description: `Admin gift: ${coins.toLocaleString()} coins`,
        status: 'completed'
      });

      // Create notification
      await storage.createNotification({
        userId,
        type: 'admin_gift',
        title: '🎁 Admin Gift',
        message: `You received ${coins.toLocaleString()} coins from admin!`,
        data: { coins, type: 'admin_gift' },
      });

      res.json({ message: 'Coins given successfully' });
    } catch (error) {
      console.error('Error giving user coins:', error);
      res.status(500).json({ message: 'Failed to give user coins' });
    }
  });

  // Admin Tools - Event Capacity
  app.post('/api/admin/events/update-capacity', isAdmin, async (req, res) => {
    try {
      const { eventId, additionalSlots } = req.body;

      if (!eventId || !additionalSlots || additionalSlots <= 0) {
        return res.status(400).json({ message: 'Invalid event ID or additional slots' });
      }

      await storage.updateEventCapacity(eventId, additionalSlots);
      res.json({ message: 'Event capacity updated successfully' });
    } catch (error) {
      console.error('Error updating event capacity:', error);
      res.status(500).json({ message: 'Failed to update event capacity' });
    }
  });

  // Admin Tools - Broadcast Message
  app.post('/api/admin/broadcast', isAdmin, async (req, res) => {
    try {
      const { message, type } = req.body;

      if (!message || !type) {
        return res.status(400).json({ message: 'Message and type are required' });
      }

      await storage.broadcastMessage(message, type);
      res.json({ message: 'Message broadcasted successfully' });
    } catch (error) {
      console.error('Error broadcasting message:', error);
      res.status(500).json({ message: 'Failed to broadcast message' });
    }
  });

  // Admin Login Route
  app.post('/api/admin/login', async (req, res) => {
    try {
      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json({ message: 'Username and password are required' });
      }

      // Find user by username or email
      const user = await storage.getUserByUsernameOrEmail(username);
      if (!user) {
        console.log(`Failed admin login attempt - user not found: ${username}`);
        return res.status(401).json({ message: 'Invalid admin credentials' });
      }

      // Verify admin password
      const expectedPassword = process.env.ADMIN_PASSWORD || 'admin123';
      if (password !== expectedPassword) {
        console.log(`Failed admin login attempt - invalid password for user: ${username}`);
        return res.status(401).json({ message: 'Invalid admin credentials' });
      }

      // Check if user is admin
      if (!user.isAdmin) {
        console.log(`Failed admin login attempt - user not admin: ${username}`);
        return res.status(401).json({ message: 'Access denied: Admin privileges required' });
      }

      // Generate admin token
      const adminToken = `admin_${user.id}_${Date.now()}`;

      // Update user's last login
      await storage.updateUserProfile(user.id, {
        lastLogin: new Date()
      });

      // Log successful admin login
      console.log(`Successful admin login: ${username} (${user.id})`);

      res.json({
        message: 'Admin login successful',
        token: adminToken,
        user: {
          id: user.id,
          username: user.username,
          firstName: user.firstName,
          email: user.email,
          isAdmin: user.isAdmin
        }
      });

    } catch (error) {
      console.error('Error during admin login:', error);
      res.status(500).json({ message: 'Admin login failed' });
    }
  });

  // Admin logout route
  app.post('/api/admin/logout', async (req, res) => {
    try {
      const adminToken = req.headers.authorization?.replace('Bearer ', '');
      if (adminToken) {
        console.log(`Admin logout: ${adminToken}`);
      }
      res.json({ message: 'Admin logout successful' });
    } catch (error) {
      console.error('Error during admin logout:', error);
      res.status(500).json({ message: 'Admin logout failed' });
    }
  });

  // Debug route to manually verify specific payment
  app.post('/api/debug/verify-payment', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user.claims.sub;
      const { reference } = req.body;

      if (!reference) {
        return res.status(400).json({ message: "Reference is required" });
      }

      console.log(`Debug verification for reference: ${reference}`);

      // For your specific case, let's manually create the transaction
      if (reference === "dep_45092781_1752662330009") {
        const depositAmount = 2500; // ₦2,500 from your payment

        // Check if transaction already exists
        const existingTransactions = await storage.getTransactions(userId);
        const exists = existingTransactions.some((t: any) => 
          t.reference === reference || t.description?.includes(reference)
        );

        if (!exists) {
          await storage.createTransaction({
            userId,
            type: 'deposit',
            amount: depositAmount.toString(),
            description: `Debug deposit - ${reference}`,
            reference: reference,
            status: 'completed',
          });

          console.log(`✅ Debug transaction created for ${userId}: ₦${depositAmount}`);
          res.json({ message: "Debug transaction created successfully", amount: depositAmount });
        } else {
          res.json({ message: "Transaction already exists" });
        }
      } else {
        res.status(400).json({ message: "Unknown reference" });
      }
    } catch (error) {
      console.error("Debug verification error:", error);
      res.status(500).json({ message: "Debug verification failed" });
    }
  });

  // Debug route to check balance calculation
  app.get('/api/debug/balance', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user.claims.sub;
      
      console.log(`🔍 Debug balance check for user: ${userId}`);
      
      // Get all transactions
      const allTransactions = await storage.getTransactions(userId);
      console.log(`All transactions:`, allTransactions);
      
      // Get calculated balance
      const calculatedBalance = await storage.getUserBalance(userId);
      console.log(`Calculated balance:`, calculatedBalance);
      
      // Manual calculation
      let manualBalance = 0;
      const completedTxns = allTransactions.filter(t => t.status === 'completed');
      for (const txn of completedTxns) {
        const amount = parseFloat(txn.amount);
        if (!isNaN(amount)) {
          manualBalance += amount;
        }
      }
      
      res.json({
        userId,
        totalTransactions: allTransactions.length,
        completedTransactions: completedTxns.length,
        calculatedBalance,
        manualBalance,
        transactions: allTransactions.map(t => ({
          id: t.id,
          type: t.type,
          amount: t.amount,
          parsedAmount: parseFloat(t.amount),
          status: t.status,
          description: t.description,
          reference: t.reference,
          createdAt: t.createdAt
        }))
      });
    } catch (error) {
      console.error("Debug balance error:", error);
      res.status(500).json({ message: "Debug balance failed" });
    }
  });

  // Coin shop routes
  app.post('/api/shop/purchase-coins', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user.claims.sub;
      const { coins, nairaAmount } = req.body;

      if (!coins || !nairaAmount || coins <= 0 || nairaAmount <= 0) {
        return res.status(400).json({ message: "Invalid coin or Naira amount" });
      }

      if (nairaAmount < 50) {
        return res.status(400).json({ message: "Minimum purchase is ₦50" });
      }

      // Check user balance
      const balance = await storage.getUserBalance(userId);
      if (balance.balance < nairaAmount) {
        return res.status(400).json({ message: "Insufficient Naira balance" });
      }

      // Create transactions for both Naira deduction and coin addition
      await storage.createTransaction({
        userId,
        type: 'coin_purchase',
        amount: `-${nairaAmount}`,
        description: `Purchased ${coins.toLocaleString()} coins`,
        status: 'completed',
      });

      await storage.createTransaction({
        userId,
        type: 'coin_purchase',
        amount: coins.toString(),
        description: `Received ${coins.toLocaleString()} coins from purchase`,
        status: 'completed',
      });

      // Update user coins balance
      await db
        .update(users)
        .set({ 
          coins: sql`${users.coins} + ${coins}`,
          updatedAt: new Date()
        })
        .where(eq(users.id, userId));

      // Create notification
      await storage.createNotification({
        userId,
        type: 'coin_purchase',
        title: '🪙 Coins Purchased',
        message: `You purchased ${coins.toLocaleString()} coins for ${formatBalance(nairaAmount)}!`,
        data: { 
          coins: coins,
          nairaAmount: nairaAmount,
          type: 'coin_purchase'
        },
      });

      res.json({ 
        message: "Coins purchased successfully", 
        coins: coins,
        nairaAmount: nairaAmount 
      });
    } catch (error) {
      console.error("Error purchasing coins:", error);
      res.status(500).json({ message: "Failed to purchase coins" });
    }
  });

  app.post('/api/shop/gift-coins', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const senderId = req.user.claims.sub;
      const { recipientId, coins } = req.body;

      if (!recipientId || !coins || coins <= 0) {
        return res.status(400).json({ message: "Invalid recipient or coin amount" });
      }

      if (coins < 100) {
        return res.status(400).json({ message: "Minimum gift is 100 coins" });
      }

      if (senderId === recipientId) {
        return res.status(400).json({ message: "Cannot gift coins to yourself" });
      }

      // Check sender's coin balance
      const senderBalance = await storage.getUserBalance(senderId);
      const senderCoins = typeof senderBalance === 'object' ? (senderBalance.coins || 0) : 0;
      
      if (senderCoins < coins) {
        return res.status(400).json({ message: "Insufficient coins to gift" });
      }

      // Get sender and recipient info
      const sender = await storage.getUser(senderId);
      const recipient = await storage.getUser(recipientId);

      if (!recipient) {
        return res.status(404).json({ message: "Recipient not found" });
      }

      // Create transactions for both users
      await storage.createTransaction({
        userId: senderId,
        type: 'coin_gift_sent',
        amount: `-${coins}`,
        description: `Gifted ${coins.toLocaleString()} coins to @${recipient.firstName || recipient.username}`,
        relatedId: recipientId,
        status: 'completed',
      });

      await storage.createTransaction({
        userId: recipientId,
        type: 'coin_gift_received',
        amount: coins.toString(),
        description: `Received ${coins.toLocaleString()} coins gift from @${sender?.firstName || sender?.username}`,
        relatedId: senderId,
        status: 'completed',
      });

      // Update both users' coin balances
      await db
        .update(users)
        .set({ 
          coins: sql`${users.coins} - ${coins}`,
          updatedAt: new Date()
        })
        .where(eq(users.id, senderId));

      await db
        .update(users)
        .set({ 
          coins: sql`${users.coins} + ${coins}`,
          updatedAt: new Date()
        })
        .where(eq(users.id, recipientId));

      // Create notifications for both users
      await storage.createNotification({
        userId: recipientId,
        type: 'coin_gift_received',
        title: '🎁 Coin Gift Received',
        message: `@${sender?.firstName || sender?.username} gifted you ${coins.toLocaleString()} coins!`,
        data: { 
          coins: coins,
          senderId: senderId,
          senderName: sender?.firstName || sender?.username
        },
      });

      await storage.createNotification({
        userId: senderId,
        type: 'coin_gift_sent',
        title: '🎁 Gift Sent',
        message: `You gifted ${coins.toLocaleString()} coins to @${recipient.firstName || recipient.username}!`,
        data: { 
          coins: coins,
          recipientId: recipientId,
          recipientName: recipient.firstName || recipient.username
        },
      });

      // Send real-time notifications via Pusher
      await pusher.trigger(`user-${recipientId}`, 'coin-gift-received', {
        title: '🎁 Coin Gift Received',
        message: `@${sender?.firstName || sender?.username} gifted you ${coins.toLocaleString()} coins!`,
        coins: coins,
        senderId: senderId,
        senderName: sender?.firstName || sender?.username,
        timestamp: new Date().toISOString(),
      });

      await pusher.trigger(`user-${senderId}`, 'coin-gift-sent', {
        title: '🎁 Gift Sent',
        message: `You gifted ${coins.toLocaleString()} coins to @${recipient.firstName || recipient.username}!`,
        coins: coins,
        recipientId: recipientId,
        recipientName: recipient.firstName || recipient.username,
        timestamp: new Date().toISOString(),
      });

      res.json({ 
        message: "Coin gift sent successfully", 
        coins: coins,
        recipientName: recipient.firstName || recipient.username
      });
    } catch (error) {
      console.error("Error gifting coins:", error);
      res.status(500).json({ message: "Failed to gift coins" });
    }
  });

  // Push notification subscription route
  app.post('/api/push/subscribe', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user.claims.sub;
      const { subscription } = req.body;

      if (!subscription) {
        return res.status(400).json({ message: 'Subscription data is required' });
      }

      // Store subscription in database
      await storage.savePushSubscription(userId, subscription);

      res.json({ message: 'Push subscription saved successfully' });
    } catch (error) {
      console.error('Error saving push subscription:', error);
      res.status(500).json({ message: 'Failed to save push subscription' });
    }
  });

  // Send push notification to user
  app.post('/api/push/send', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const { userId, title, body, data } = req.body;

      if (!userId || !title || !body) {
        return res.status(400).json({ message: 'User ID, title, and body are required' });
      }

      // Send push notification
      await sendPushNotification(userId, { title, body, data });

      res.json({ message: 'Push notification sent successfully' });
    } catch (error) {
      console.error('Error sending push notification:', error);
      res.status(500).json({ message: 'Failed to send push notification' });
    }
  });

  // Helper function to send push notifications
  async function sendPushNotification(userId: string, payload: { title: string; body: string; data?: any }) {
    try {
      const subscriptions = await storage.getPushSubscriptions(userId);

      if (subscriptions.length === 0) {
        console.log(`No push subscriptions found for user ${userId}`);
        return;
      }

      const notificationPayload = JSON.stringify({
        title: payload.title,
        body: payload.body,
        icon: '/assets/bantahlogo.png',
        badge: '/assets/notification.svg',
        data: payload.data || {},
        timestamp: Date.now()
      });

      const promises = subscriptions.map(async (subscription) => {
        try {
          await webpush.sendNotification(subscription, notificationPayload);
        } catch (error) {
          console.error('Error sending notification to subscription:', error);
          // Remove invalid subscription
          await storage.removePushSubscription(subscription.endpoint);
        }
      });

      await Promise.all(promises);
    } catch (error) {
      console.error('Error in sendPushNotification:', error);
    }
  }

  // Helper function to send push notifications to event participants
  async function sendEventPushNotifications(eventId: number, payload: { title: string; body: string; data?: any }) {
    try {
      const participants = await storage.getEventParticipants(eventId);

      for (const participant of participants) {
        await sendPushNotification(participant.userId, payload);
      }
    } catch (error) {
      console.error('Error sending event push notifications:', error);
    }
  }

  const httpServer = createServer(app);

  // WebSocket server for real-time messaging
  const wss = new WebSocketServer({ 
    server: httpServer,
    path: '/ws' 
  });

  // Store connected clients
  const clients = new Map<string, WebSocket>();

  wss.on('connection', (ws, req) => {
    console.log('New WebSocket connection');

    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message.toString());

        switch (data.type) {
          case 'user_join':
            // Store user connection
            clients.set(data.userId, ws);

            // Broadcast join notification to event participants
            if (data.eventId) {
              await broadcastEventSystemMessage(data.eventId, 'user_join', {
                userId: data.userId,
                username: data.username || 'User',
                eventId: data.eventId
              });
            }
            break;

          case 'user_leave':
            // Remove user connection
            clients.delete(data.userId);

            // Broadcast leave notification to event participants
            if (data.eventId) {
              await broadcastEventSystemMessage(data.eventId, 'user_leave', {
                userId: data.userId,
                username: data.username || 'User',
                eventId: data.eventId
              });
            }
            break;

          case 'user_typing':
            // Broadcast typing indicator to other participants (exclude sender)
            if (data.eventId && data.userId) {
              await broadcastToEventParticipants(data.eventId, {
                type: 'user_typing',
                userId: data.userId,
                eventId: data.eventId,
                username: data.username,
                isTyping: data.isTyping
              });
            }
            break;

          case 'event_message':
            // Broadcast new message
            await broadcastToEventParticipants(data.eventId, {
              type: 'event_message',
              eventId: data.eventId,
              messageId: data.messageId
            });
            break;

          case 'message_reaction':
            // Broadcast reaction update
            await broadcastToEventParticipants(data.eventId, {
              type: 'message_reaction',
              eventId: data.eventId,
              messageId: data.messageId,
              userId: data.userId
            });
            break;

          case 'event_started':
            // Broadcast event start notification
            await broadcastEventSystemMessage(data.eventId, 'event_started', {
              eventId: data.eventId,
              eventTitle: data.eventTitle,
              endTime: data.endTime
            });
            break;

          case 'event_ended':
            // Broadcast event end notification
            await broadcastEventSystemMessage(data.eventId, 'event_ended', {
              eventId: data.eventId,
              eventTitle: data.eventTitle,
              result: data.result
            });
            break;

          default:
            console.log('Unknown WebSocket message type:', data.type);
        }
      } catch (error) {
        console.error('Error handling WebSocket message:', error);
      }
    });

    ws.on('close', () => {
      // Remove from clients map when connection closes
      for (const [userId, client] of clients.entries()) {
        if (client === ws) {          clients.delete(userId);
          break;
        }
      }
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });
  });

  // Helper function to broadcast to all event participants
  async function broadcastToEventParticipants(eventId: number, message: any) {
    try {
      const participants = await storage.getEventParticipants(eventId);

      for (const participant of participants) {
        // Skip sending typing indicator to the sender themselves
        if (message.type === 'user_typing' && message.userId === participant.userId) {
          continue;
        }

        const client = clients.get(participant.userId);
        if (client && client.readyState === WebSocket.OPEN) {
          try {
            // Send real-time message via WebSocket
            client.send(JSON.stringify(message));
          } catch (wsError) {
            console.error('Error sending WebSocket message to participant:', participant.userId, wsError);
            // Remove broken connection
            clients.delete(participant.userId);
          }
        } else {
          // User is offline/idle, send push notification for actual messages (not typing indicators)
          if (message.type === 'event_message' && message.message && message.userId !== participant.userId) {
            try {
              const event = await storage.getEventById(eventId);
              const sender = message.user?.firstName || message.user?.username || 'Someone';

              await sendPushNotification(participant.userId, {
                title: `💬 New message in ${event?.title}`,
                body: `${sender}: ${message.message}`,
                data: {
                  type: 'event_message',
                  eventId,
                  messageId: message.id,
                  url: `/events/${eventId}`,
                },
              });
            } catch (pushError) {
              console.error('Error sending push notification:', pushError);
            }
          }
        }
      }
    } catch (error) {
      console.error('Error broadcasting to event participants:', error);
    }
  }

  // Helper function to broadcast system messages
  async function broadcastEventSystemMessage(eventId: number, type: string, data: any) {
    try {
      // Create system message based on type
      let systemMessage;

      switch (type) {
        case 'user_join':
          systemMessage = {
            id: `system_${Date.now()}`,
            type: 'system',
            eventId: eventId,
            message: `@${data.username} joined the event`,
            createdAt: new Date().toISOString(),
            systemType: 'user_join'
          };
          break;

        case 'user_leave':
          systemMessage = {
            id: `system_${Date.now()}`,
            type: 'system',
            eventId: eventId,
            message: `@${data.username} left the event`,
            createdAt: new Date().toISOString(),
            systemType: 'user_leave'
          };
          break;

        case 'event_started':
          const endTime = new Date(data.endTime);
          const timeLeft = Math.max(0, endTime.getTime() - Date.now());
          const hoursLeft = Math.floor(timeLeft / (1000 * 60 * 60));
          const minutesLeft = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));

          systemMessage = {
            id: `system_${Date.now()}`,
            type: 'system',
            eventId: eventId,
            message: `Event has started! ${hoursLeft}h ${minutesLeft}m remaining`,
            createdAt: new Date().toISOString(),
            systemType: 'event_started'
          };
          break;

        case 'event_ended':
          systemMessage = {
            id: `system_${Date.now()}`,
            type: 'system',
            eventId: eventId,
            message: `Event has ended! ${data.result ? `Result: ${data.result}` : 'Check results'}`,
            createdAt: new Date().toISOString(),
            systemType: 'event_ended'
          };
          break;

        default:
          return;
      }

      // Broadcast via WebSocket
      await broadcastToEventParticipants(eventId, {
        type: 'system_message',
        eventId: eventId,
        message: systemMessage
      });

      // Also broadcast via Pusher for fallback
      await pusher.trigger(`event-${eventId}`, 'system-message', systemMessage);

      // Send push notifications for important system events
      if (['user_join', 'user_leave', 'event_started', 'event_ended'].includes(type)) {
        const event = await storage.getEventById(eventId);
        const participants = await storage.getEventParticipants(eventId);

        let notificationTitle = '';
        let notificationBody = '';

        switch (type) {
          case 'event_started':
            notificationTitle = `🚀 Event Started`;
            notificationBody = `${event?.title} has begun!`;
            break;
          case 'event_ended':
            notificationTitle = `🏁 Event Ended`;
            notificationBody = `${event?.title} has concluded`;
            break;
          case 'user_join':
            notificationTitle = `👋 New Participant`;
            notificationBody = `@${data.username} joined ${event?.title}`;
            break;
          case 'user_leave':
            notificationTitle = `👋 Participant Left`;
            notificationBody = `@${data.username} left ${event?.title}`;
            break;
        }

        for (const participant of participants) {
          // Don't send notification to the user who triggered the event
          if (data.userId && data.userId === participant.userId) continue;

          await sendPushNotification(participant.userId, {
            title: notificationTitle,
            body: notificationBody,
            data: {
              type: 'system_event',
              eventId,
              systemType: type,
              url: `/events/${eventId}`,
            },
          });
        }
      }

    } catch (error) {
      console.error('Error broadcasting system message:', error);
    }
  }

  // Notification Algorithm API endpoints
  app.post('/api/notifications/trigger-algorithm', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const { NotificationAlgorithmService } = await import('./notificationAlgorithm');
      const notificationAlgorithm = new NotificationAlgorithmService(storage);
      
      await notificationAlgorithm.executeNotificationAlgorithm();
      
      res.json({ message: 'Notification algorithm executed successfully' });
    } catch (error) {
      console.error('Error executing notification algorithm:', error);
      res.status(500).json({ message: 'Failed to execute notification algorithm' });
    }
  });

  app.post('/api/notifications/handle-action', isAuthenticated, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user.claims.sub;
      const { notificationId, action, targetUserId, eventId } = req.body;

      if (!notificationId || !action) {
        return res.status(400).json({ message: 'Notification ID and action are required' });
      }

      // Mark notification as read
      await storage.markNotificationRead(notificationId);

      // Handle different actions
      switch (action) {
        case 'challenge_user':
          if (!targetUserId) {
            return res.status(400).json({ message: 'Target user ID is required for challenge action' });
          }
          
          // Create a challenge dialog response
          const targetUser = await storage.getUser(targetUserId);
          res.json({
            message: 'Challenge action initiated',
            action: 'open_challenge_dialog',
            targetUser: {
              id: targetUserId,
              name: targetUser?.firstName || targetUser?.username,
              username: targetUser?.username,
              profileImageUrl: targetUser?.profileImageUrl,
            },
          });
          break;

        case 'join_event':
          if (!eventId) {
            return res.status(400).json({ message: 'Event ID is required for join event action' });
          }
          
          res.json({
            message: 'Join event action initiated',
            action: 'navigate_to_event',
            eventId: eventId,
          });
          break;

        case 'create_challenges':
          res.json({
            message: 'Create challenges action initiated',
            action: 'navigate_to_challenges',
          });
          break;

        case 'view':
        default:
          res.json({
            message: 'Notification viewed',
            action: 'mark_read',
          });
          break;
      }
    } catch (error) {
      console.error('Error handling notification action:', error);
      res.status(500).json({ message: 'Failed to handle notification action' });
    }
  });

  // Telegram webhook for bot messages
  app.post('/api/telegram/webhook', async (req, res) => {
    try {
      const update = req.body;
      
      // Verify webhook token if set
      const webhookToken = process.env.TELEGRAM_WEBHOOK_TOKEN;
      if (webhookToken && req.query.token !== webhookToken) {
        return res.status(401).json({ error: 'Invalid webhook token' });
      }
      
      // Handle incoming message
      if (update.message && update.message.text) {
        const messageText = update.message.text;
        const chatId = update.message.chat.id;
        const userId = update.message.from.id;
        const username = update.message.from.username || update.message.from.first_name || 'Telegram User';
        
        console.log(`📨 Telegram Bot → BetChat: ${username}: ${messageText}`);
        
        // Check if message is for a specific event (hashtag format: #event123)
        const eventMatch = messageText.match(/#event(\d+)/);
        
        if (eventMatch) {
          const eventId = parseInt(eventMatch[1]);
          
          try {
            // Create or get telegram user
            const telegramUserId = `telegram_${userId}`;
            let telegramUser = await storage.getUser(telegramUserId);
            
            if (!telegramUser) {
              telegramUser = await storage.createUser({
                id: telegramUserId,
                firstName: username,
                username: username.toLowerCase().replace(/[^a-z0-9]/g, ''),
                email: `${telegramUserId}@telegram.betchat.local`,
                profileImageUrl: null,
                isTelegramUser: true,
                telegramId: userId.toString(),
                coins: 0,
                points: 0,
                level: 1,
                xp: 0
              });
            }
            
            // Create message in event chat
            const newMessage = await storage.createEventMessage(eventId, telegramUser.id, messageText, null, []);
            
            // Broadcast to event participants via Pusher
            await pusher.trigger(`event-${eventId}`, 'new-message', {
              message: {
                ...newMessage,
                user: telegramUser,
                source: 'telegram'
              },
              eventId: eventId,
              userId: telegramUser.id,
              source: 'telegram'
            });
            
            console.log(`✅ Telegram webhook message synced to Event ${eventId}`);
            
          } catch (error) {
            console.error(`❌ Failed to sync webhook message to event ${eventId}:`, error);
          }
        }
      }
      
      // Respond to Telegram
      res.json({ ok: true });
      
    } catch (error) {
      console.error('❌ Error processing Telegram webhook:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Setup OG image generation routes
  setupOGImageRoutes(app, storage);

  return httpServer;
}