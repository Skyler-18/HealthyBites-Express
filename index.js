require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const { BotFrameworkAdapter, MemoryStorage, ConversationState, UserState } = require('botbuilder');
const Profile = require('./models/Profile');
const { HealthyBitesBot } = require('./bot/HealthyBitesBot');
const path = require('path');

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
    appId: process.env.MicrosoftAppId,
    appPassword: process.env.MicrosoftAppPassword,
});

// State management
const memoryStorage = new MemoryStorage();
const conversationState = new ConversationState(memoryStorage);
const userState = new UserState(memoryStorage);

// Main bot logic
const bot = new HealthyBitesBot(Profile, conversationState, userState);

// Listen for incoming requests
app.post('/api/messages', (req, res) => {
    adapter.processActivity(req, res, async (context) => {
        await bot.run(context);
    });
});

// Serve static files (order page and menu)
app.use(express.static(path.join(__dirname, 'public')));

// Route for /order (serves order.html)
app.get('/order', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'order.html'));
});

const PORT = process.env.PORT || 3978;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
}); 