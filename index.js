require('dotenv').config();
const express = require('express');
const { BotFrameworkAdapter, MemoryStorage, ConversationState, UserState } = require('botbuilder');
const mongoose = require('mongoose');

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/HealthyBites', {
    useNewUrlParser: true,
    useUnifiedTopology: true,
});

// User schema for Profiles collection
const userSchema = new mongoose.Schema({
    phone: { type: String, unique: true, required: true },
    name: String,
    officeAddress: String,
    homeAddress: String,
    heardFrom: String,
    referralCode: String,
});
const User = mongoose.model('Profiles', userSchema);

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

// Main bot logic placeholder
const { ActivityHandler, MessageFactory, CardFactory, InputHints } = require('botbuilder');

// Helper: Validate phone number (10 digits)
function isValidPhoneNumber(phone) {
    return /^\d{10}$/.test(phone);
}

// Onboarding steps
const ONBOARDING_STEPS = {
    NONE: 'NONE',
    ASK_PHONE: 'ASK_PHONE',
    ASK_NAME: 'ASK_NAME',
    ASK_OFFICE: 'ASK_OFFICE',
    ASK_HOME: 'ASK_HOME',
    ASK_HEARD: 'ASK_HEARD',
    COMPLETE: 'COMPLETE',
    ASK_UPDATE: 'ASK_UPDATE',
    UPDATE_NAME: 'UPDATE_NAME',
    UPDATE_OFFICE: 'UPDATE_OFFICE',
    UPDATE_HOME: 'UPDATE_HOME',
    UPDATE_HEARD: 'UPDATE_HEARD',
};

class HealthyBitesBot extends ActivityHandler {
    constructor() {
        super();
        this.onMembersAdded(async (context, next) => {
            const membersAdded = context.activity.membersAdded;
            for (let member of membersAdded) {
                if (member.id !== context.activity.recipient.id) {
                    await context.sendActivity('Welcome to HealthyBites Express!');
                    await conversationState.createProperty('onboardingStep').set(context, ONBOARDING_STEPS.NONE);
                }
            }
            await next();
        });
        this.onMessage(async (context, next) => {
            const onboardingStepAccessor = conversationState.createProperty('onboardingStep');
            const userProfileAccessor = userState.createProperty('userProfile');
            let onboardingStep = await onboardingStepAccessor.get(context, ONBOARDING_STEPS.NONE);
            let userProfile = await userProfileAccessor.get(context, {});
            const text = context.activity.text && context.activity.text.trim();

            switch (onboardingStep) {
                case ONBOARDING_STEPS.NONE:
                    await context.sendActivity('To get started, may I have your phone number?');
                    await onboardingStepAccessor.set(context, ONBOARDING_STEPS.ASK_PHONE);
                    break;
                case ONBOARDING_STEPS.ASK_PHONE:
                    if (!isValidPhoneNumber(text)) {
                        await context.sendActivity('Please enter a valid 10-digit phone number.');
                        break;
                    }
                    userProfile.phone = text;
                    // Check if user exists
                    const existingUser = await User.findOne({ phone: text });
                    if (existingUser) {
                        await context.sendActivity('Welcome back! Here are your profile details:');
                        await context.sendActivity({
                            attachments: [this.profileAdaptiveCard(existingUser)],
                        });
                        await onboardingStepAccessor.set(context, ONBOARDING_STEPS.ASK_UPDATE);
                        await context.sendActivity(MessageFactory.suggestedActions(['Yes', 'No'], 'Do you want to update this profile?'));
                        break;
                    }
                    await onboardingStepAccessor.set(context, ONBOARDING_STEPS.ASK_NAME);
                    await context.sendActivity('Great! What is your name?');
                    break;
                case ONBOARDING_STEPS.ASK_UPDATE:
                    if (text.toLowerCase() === 'yes' || text === 'Yes') {
                        await onboardingStepAccessor.set(context, ONBOARDING_STEPS.UPDATE_NAME);
                        await context.sendActivity("Let's update your profile. What is your name?");
                    } else if (text.toLowerCase() === 'no' || text === 'No') {
                        await context.sendActivity('Okay, your profile remains unchanged.');
                        await onboardingStepAccessor.set(context, ONBOARDING_STEPS.COMPLETE);
                    } else {
                        await context.sendActivity(MessageFactory.suggestedActions(['Yes', 'No'], 'Do you want to update this profile?'));
                    }
                    break;
                case ONBOARDING_STEPS.UPDATE_NAME:
                    userProfile.name = text;
                    await onboardingStepAccessor.set(context, ONBOARDING_STEPS.UPDATE_OFFICE);
                    await context.sendActivity('What is your office address?');
                    break;
                case ONBOARDING_STEPS.UPDATE_OFFICE:
                    userProfile.officeAddress = text;
                    await onboardingStepAccessor.set(context, ONBOARDING_STEPS.UPDATE_HOME);
                    await context.sendActivity('What is your home address?');
                    break;
                case ONBOARDING_STEPS.UPDATE_HOME:
                    userProfile.homeAddress = text;
                    await onboardingStepAccessor.set(context, ONBOARDING_STEPS.UPDATE_HEARD);
                    await context.sendActivity(MessageFactory.suggestedActions([
                        'Google Ads',
                        'Social Media (Instagram, Facebook etc.)',
                        'Friend',
                        'Newspaper',
                        'Other'
                    ], 'How did you hear about HealthyBites Express?'));
                    break;
                case ONBOARDING_STEPS.UPDATE_HEARD:
                    userProfile.heardFrom = text;
                    // Update the existing profile in DB
                    await User.findOneAndUpdate(
                        { phone: userProfile.phone },
                        {
                            name: userProfile.name,
                            officeAddress: userProfile.officeAddress,
                            homeAddress: userProfile.homeAddress,
                            heardFrom: userProfile.heardFrom,
                        },
                        { new: true }
                    );
                    await context.sendActivity('Profile updated successfully! Here are your updated details:');
                    const updatedUser = await User.findOne({ phone: userProfile.phone });
                    await context.sendActivity({
                        attachments: [this.profileAdaptiveCard(updatedUser)],
                    });
                    await onboardingStepAccessor.set(context, ONBOARDING_STEPS.COMPLETE);
                    break;
                case ONBOARDING_STEPS.ASK_NAME:
                    userProfile.name = text;
                    await onboardingStepAccessor.set(context, ONBOARDING_STEPS.ASK_OFFICE);
                    await context.sendActivity('What is your office address?');
                    break;
                case ONBOARDING_STEPS.ASK_OFFICE:
                    userProfile.officeAddress = text;
                    await onboardingStepAccessor.set(context, ONBOARDING_STEPS.ASK_HOME);
                    await context.sendActivity('What is your home address?');
                    break;
                case ONBOARDING_STEPS.ASK_HOME:
                    userProfile.homeAddress = text;
                    await onboardingStepAccessor.set(context, ONBOARDING_STEPS.ASK_HEARD);
                    await context.sendActivity(MessageFactory.suggestedActions([
                        'Google Ads',
                        'Social Media (Instagram, Facebook etc.)',
                        'Friend',
                        'Newspaper',
                        'Other'
                    ], 'How did you hear about HealthyBites Express?'));
                    break;
                case ONBOARDING_STEPS.ASK_HEARD:
                    userProfile.heardFrom = text;
                    // Save to DB
                    const newUser = new User(userProfile);
                    await newUser.save();
                    await context.sendActivity('Profile created successfully! Here are your details:');
                    await context.sendActivity({
                        attachments: [this.profileAdaptiveCard(newUser)],
                    });
                    await onboardingStepAccessor.set(context, ONBOARDING_STEPS.COMPLETE);
                    break;
                case ONBOARDING_STEPS.COMPLETE:
                    await context.sendActivity('Your profile is already set up. If you want to update details, please contact support.');
                    break;
                default:
                    await context.sendActivity('To get started, may I have your phone number?');
                    await onboardingStepAccessor.set(context, ONBOARDING_STEPS.ASK_PHONE);
                    break;
            }
            await userProfileAccessor.set(context, userProfile);
            await conversationState.saveChanges(context);
            await userState.saveChanges(context);
            await next();
        });
    }

    profileAdaptiveCard(user) {
        return CardFactory.adaptiveCard({
            "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
            "type": "AdaptiveCard",
            "version": "1.3",
            "body": [
                {
                    "type": "TextBlock",
                    "text": "Profile Details",
                    "weight": "Bolder",
                    "size": "Large",
                    "color": "Accent",
                    "horizontalAlignment": "Center"
                },
                {
                    "type": "FactSet",
                    "facts": [
                        { "title": "Name:", "value": user.name },
                        { "title": "Phone:", "value": user.phone },
                        { "title": "Office Address:", "value": user.officeAddress },
                        { "title": "Home Address:", "value": user.homeAddress },
                        { "title": "Heard About Us:", "value": user.heardFrom }
                    ]
                }
            ]
        });
    }
}

const bot = new HealthyBitesBot();

// Listen for incoming requests
app.post('/api/messages', (req, res) => {
    adapter.processActivity(req, res, async (context) => {
        await bot.run(context);
    });
});

const PORT = process.env.PORT || 3978;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
}); 