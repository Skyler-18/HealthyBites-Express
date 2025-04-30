require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const { BotFrameworkAdapter, MemoryStorage, ConversationState, UserState } = require('botbuilder');
const Profile = require('./models/Profile');
const { HealthyBitesBot, formatMenu, loadMenu } = require('./bot/HealthyBitesBot');
const path = require('path');
const Order = require('./models/Order');
const cron = require('node-cron');
const { CardFactory, TurnContext } = require('botbuilder');

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/HealthyBites', {
    useNewUrlParser: true,
    useUnifiedTopology: true,
});

// Express server setup
const app = express();
app.use(express.json());

// Bot Framework Adapter
const adapter = new BotFrameworkAdapter({
    appId: process.env.MicrosoftAppId || '',
    appPassword: process.env.MicrosoftAppPassword || '',
});

// State management
const memoryStorage = new MemoryStorage();
const conversationState = new ConversationState(memoryStorage);
const userState = new UserState(memoryStorage);

// Store last order per user in memory for bot notification
const lastOrderByPhone = {};
// Store conversation references for proactive messaging
const conversationReferences = {};

// Get current server port for dynamic URLs
const PORT = process.env.PORT || 3978;
const BASE_URL = `http://localhost:${PORT}`;

// Main bot logic
const bot = new HealthyBitesBot(Profile, conversationState, userState, lastOrderByPhone);

// Listen for incoming requests
app.post('/api/messages', (req, res) => {
    adapter.processActivity(req, res, async (context) => {
        // Store the conversation reference for proactive messaging
        const reference = TurnContext.getConversationReference(context.activity);
        // Debug log for reference
        console.log('Storing conversation reference:', {
            userId: context.activity.from && context.activity.from.id,
            serviceUrl: reference.serviceUrl,
            conversationId: reference.conversation && reference.conversation.id
        });
        // Always store under user ID
        const userId = context.activity.from && context.activity.from.id;
        if (userId) {
            conversationReferences[userId] = reference;
        }
        // Also try to get phone from user state
        let phone = null;
        try {
            const userProfileAccessor = userState.createProperty('userProfile');
            const userProfile = await userProfileAccessor.get(context, {});
            if (userProfile && userProfile.phone) {
                phone = userProfile.phone;
                conversationReferences[phone] = reference;
            }
        } catch (e) {}
        await bot.run(context);
    });
});

// API endpoint to receive orders
app.post('/api/order', async (req, res) => {
    const { phone, items, total, date } = req.body;
    if (!phone || !items || !total || !date) {
        return res.status(400).json({ error: 'Missing fields' });
    }
    const order = new Order({ phone, items, total, date });
    await order.save();
    // Store for bot to notify on next message
    lastOrderByPhone[phone] = { items, total };
    res.json({ success: true });
});

// API endpoint to get profile subscription status
app.get('/api/profile', async (req, res) => {
    const { phone } = req.query;
    if (!phone) return res.status(400).json({ error: 'Missing phone' });
    const profile = await Profile.findOne({ phone });
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    res.json({ subscriptionStatus: profile.subscriptionStatus, subscriptionEndDate: profile.subscriptionEndDate });
});

// API endpoint to update subscription
app.post('/api/subscribe', async (req, res) => {
    const { phone, type } = req.body;
    if (!phone || !type) return res.status(400).json({ error: 'Missing phone or type' });
    const endDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await Profile.findOneAndUpdate(
        { phone },
        { subscriptionStatus: type, subscriptionEndDate: endDate },
        { new: true }
    );
    res.json({ success: true });
});

// API endpoint to save default order for lunch or dinner
app.post('/api/save-default-order', async (req, res) => {
    const { phone, items, type } = req.body;
    if (!phone || !items || !type || !['lunch', 'dinner'].includes(type)) {
        return res.status(400).json({ error: 'Missing or invalid fields' });
    }
    const update = {};
    if (type === 'lunch') update.order_lunch = items;
    if (type === 'dinner') update.order_dinner = items;
    await Profile.findOneAndUpdate(
        { phone },
        update,
        { new: true }
    );
    res.json({ success: true });
});

// Serve static files (order page and menu)
app.use(express.static(path.join(__dirname, 'public')));

// Route for /order (serves order.html)
app.get('/order', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'order.html'));
});

// Helper to send proactive message
async function sendProactiveMenu(phone, name, greeting) {
    // Try both phone and userId as keys
    let conversationReference = conversationReferences[phone];
    if (!conversationReference) {
        // Try userId (assume it's the same as phone for emulator, or fallback to userId from DB if available)
        conversationReference = conversationReferences[name] || conversationReferences[phone.toString()];
    }
    // Try all keys in conversationReferences for debugging
    if (!conversationReference) {
        for (const key of Object.keys(conversationReferences)) {
            if (key.includes(phone)) {
                conversationReference = conversationReferences[key];
                console.log(`Found conversation reference for phone by partial match: ${key}`);
                break;
            }
        }
    }
    if (!conversationReference) {
        console.log(`No conversation reference for phone or userId: ${phone}. Skipping proactive message.`);
        return;
    }
    // Debug log for using reference
    console.log('Using conversation reference for proactive message:', {
        serviceUrl: conversationReference.serviceUrl,
        conversationId: conversationReference.conversation && conversationReference.conversation.id
    });
    console.log(`Sending proactive message to ${phone}`);
    await adapter.continueConversation(conversationReference, async (context) => {
        const menu = loadMenu();
        const menuText = formatMenu(menu);
        await context.sendActivity(`${greeting}${name ? ' ' + name : ''}! Here's today's menu:`);
        await context.sendActivity({
            text: menuText,
            textFormat: 'markdown',
        });
        await context.sendActivity({
            attachments: [
                CardFactory.adaptiveCard({
                    "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                    "type": "AdaptiveCard",
                    "version": "1.3",
                    "body": [
                        { "type": "TextBlock", "text": "Click the button below to select food items you want to order.", "wrap": true }
                    ],
                    "actions": [
                        { "type": "Action.OpenUrl", "title": "Order Now", "url": `${BASE_URL}/order?phone=${encodeURIComponent(phone)}` }
                    ]
                })
            ]
        });
    });
}

// Schedule 6AM Good Morning (for testing, runs every minute)
cron.schedule('11 14 * * *', async () => {
    console.log('Cron job running...');
    const users = await Profile.find({});
    for (const user of users) {
        console.log('Attempting to send proactive message to:', user.phone);
        await sendProactiveMenu(user.phone, user.name, 'Good Morning');
    }
});
// Schedule 2PM Good Afternoon
cron.schedule('07 14 * * *', async () => {
    const users = await Profile.find({});
    for (const user of users) {
        await sendProactiveMenu(user.phone, user.name, 'Good Afternoon');
    }
});

// Cron job for 8:31AM: create orders for MONTHLY_LUNCH and MONTHLY
cron.schedule('31 8 * * *', async () => {
    const users = await Profile.find({ $or: [ { subscriptionStatus: 'Monthly_Lunch' }, { subscriptionStatus: 'Monthly' } ] });
    for (const user of users) {
        if (user.order_lunch && user.order_lunch.length > 0) {
            await Order.create({
                phone: user.phone,
                items: user.order_lunch,
                total: 0, // Subscription order
                date: new Date(),
                status: 'Pending'
            });
        }
    }
});
// Cron job for 4:31PM: create orders for MONTHLY_DINNER and MONTHLY
cron.schedule('01 14 * * *', async () => {
    const users = await Profile.find({ $or: [ { subscriptionStatus: 'Monthly_Dinner' }, { subscriptionStatus: 'Monthly' } ] });
    for (const user of users) {
        if (user.order_dinner && user.order_dinner.length > 0) {
            await Order.create({
                phone: user.phone,
                items: user.order_dinner,
                total: 0, // Subscription order
                date: new Date(),
                status: 'Pending'
            });
        }
    }
});

// Manual endpoint to test proactive messaging
app.get('/api/test-proactive', async (req, res) => {
    // Use a known phone or userId from conversationReferences
    // You can pass ?phone=1234567890 or it will use the first available
    let phone = req.query.phone;
    if (!phone) {
        // Try to get the first phone in conversationReferences
        phone = Object.keys(conversationReferences)[0];
    }
    if (!phone) {
        return res.status(404).send('No conversation reference found. Start a conversation in the Emulator first.');
    }
    await sendProactiveMenu(phone, 'Test User', 'Hello from manual trigger');
    res.send(`Proactive message sent to ${phone} (if reference exists)`);
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
}); 