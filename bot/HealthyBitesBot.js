const { ActivityHandler, MessageFactory, CardFactory } = require('botbuilder');
const fs = require('fs');
const path = require('path');

// Helper: Validate phone number (10 digits)
function isValidPhoneNumber(phone) {
    return /^\d{10}$/.test(phone);
}

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
    SHOW_MENU: 'SHOW_MENU',
};

function loadMenu() {
    const menuPath = path.join(__dirname, '../public/menu.json');
    return JSON.parse(fs.readFileSync(menuPath, 'utf8'));
}

function formatMenu(menu) {
    let msg = `**Today's Menu**\n\n`;
    msg += `**Lunch**\n`;
    menu.Lunch.forEach(item => {
        msg += `- ${item.name}: ${item.desc}\n`;
    });
    msg += `\n**Dinner**\n`;
    menu.Dinner.forEach(item => {
        msg += `- ${item.name}: ${item.desc}\n`;
    });
    msg += `\n**Extra Items**\n`;
    menu.ExtraItems.forEach(item => {
        msg += `- ${item.name}: ₹${item.price}\n`;
    });
    return msg;
}

class HealthyBitesBot extends ActivityHandler {
    constructor(User, conversationState, userState) {
        super();
        this.User = User;
        this.conversationState = conversationState;
        this.userState = userState;
        this.onMembersAdded(async (context, next) => {
            const membersAdded = context.activity.membersAdded;
            for (let member of membersAdded) {
                if (member.id !== context.activity.recipient.id) {
                    await context.sendActivity('Welcome to HealthyBites Express!');
                    await this.conversationState.createProperty('onboardingStep').set(context, ONBOARDING_STEPS.NONE);
                }
            }
            await next();
        });
        this.onMessage(async (context, next) => {
            const onboardingStepAccessor = this.conversationState.createProperty('onboardingStep');
            const userProfileAccessor = this.userState.createProperty('userProfile');
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
                    const existingUser = await this.User.findOne({ phone: text });
                    if (existingUser) {
                        await context.sendActivity('Welcome back! Here are your profile details:');
                        await context.sendActivity({
                            attachments: [this.profileAdaptiveCard(existingUser)],
                        });
                        await onboardingStepAccessor.set(context, ONBOARDING_STEPS.ASK_UPDATE);
                        await context.sendActivity(MessageFactory.suggestedActions(['Yes', 'No'], 'Do you want to update this profile?'));
                    } else {
                        await onboardingStepAccessor.set(context, ONBOARDING_STEPS.ASK_NAME);
                        await context.sendActivity('Great! What is your name?');
                    }
                    break;
                case ONBOARDING_STEPS.ASK_UPDATE:
                    if (text.toLowerCase() === 'yes' || text === 'Yes') {
                        await onboardingStepAccessor.set(context, ONBOARDING_STEPS.UPDATE_NAME);
                        await context.sendActivity("Let's update your profile. What is your name?");
                    } else if (text.toLowerCase() === 'no' || text === 'No') {
                        await context.sendActivity('Okay, your profile remains unchanged.');
                        await onboardingStepAccessor.set(context, ONBOARDING_STEPS.SHOW_MENU);
                        await this.showMenuAndOrderButton(context, userProfile.phone);
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
                    await this.User.findOneAndUpdate(
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
                    const updatedUser = await this.User.findOne({ phone: userProfile.phone });
                    await context.sendActivity({
                        attachments: [this.profileAdaptiveCard(updatedUser)],
                    });
                    await onboardingStepAccessor.set(context, ONBOARDING_STEPS.SHOW_MENU);
                    // Show menu after update
                    await this.showMenuAndOrderButton(context, userProfile.phone);
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
                    const newUser = new this.User(userProfile);
                    await newUser.save();
                    await context.sendActivity('Profile created successfully! Here are your details:');
                    await context.sendActivity({
                        attachments: [this.profileAdaptiveCard(newUser)],
                    });
                    await onboardingStepAccessor.set(context, ONBOARDING_STEPS.SHOW_MENU);
                    // Show menu after profile creation
                    await this.showMenuAndOrderButton(context, userProfile.phone);
                    break;
                case ONBOARDING_STEPS.COMPLETE:
                    await context.sendActivity('Your profile is already set up. If you want to update details, please contact support.');
                    await onboardingStepAccessor.set(context, ONBOARDING_STEPS.SHOW_MENU);
                    // Show menu after profile is shown and user denied update
                    await this.showMenuAndOrderButton(context, userProfile.phone);
                    break;
                case ONBOARDING_STEPS.SHOW_MENU:
                    // If user sends anything after menu, just show menu again
                    await this.showMenuAndOrderButton(context, userProfile.phone);
                    break;
                default:
                    await context.sendActivity('To get started, may I have your phone number?');
                    await onboardingStepAccessor.set(context, ONBOARDING_STEPS.ASK_PHONE);
                    break;
            }
            await userProfileAccessor.set(context, userProfile);
            await this.conversationState.saveChanges(context);
            await this.userState.saveChanges(context);
            await next();
        });
    }

    async showMenuAndOrderButton(context, phone) {
        const menu = loadMenu();
        await context.sendActivity({
            text: formatMenu(menu),
            textFormat: 'markdown',
        });
        await context.sendActivity({
            attachments: [
                CardFactory.adaptiveCard({
                    "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                    "type": "AdaptiveCard",
                    "version": "1.3",
                    "body": [
                        {
                            "type": "TextBlock",
                            "text": "Click the button below to select food items you want to order.",
                            "wrap": true
                        }
                    ],
                    "actions": [
                        {
                            "type": "Action.OpenUrl",
                            "title": "Order Now",
                            "url": `http://localhost:3978/order?phone=${encodeURIComponent(phone)}`
                        }
                    ]
                })
            ]
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

module.exports = { HealthyBitesBot, ONBOARDING_STEPS, isValidPhoneNumber }; 