const { ActivityHandler, MessageFactory, CardFactory, TurnContext } = require('botbuilder');
const fs = require('fs');
const path = require('path');
const Order = require('../models/Order');
const axios = require('axios'); // For calling local OTP API

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
    VERIFY_OTP: 'VERIFY_OTP',
    VERIFY_OTP_UPDATE: 'VERIFY_OTP_UPDATE',
    VERIFY_OTP_CANCEL: 'VERIFY_OTP_CANCEL',
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

// Helper: Generate unique referral code
async function generateUniqueReferralCode(phone, UserModel) {
    const last2 = phone.slice(-2);
    let code;
    let exists = true;
    while (exists) {
        const rand = Math.floor(100 + Math.random() * 900); // 3-digit random
        code = `HBE${last2}${rand}`.toUpperCase();
        exists = await UserModel.findOne({ referralCode: code });
    }
    return code;
}

class HealthyBitesBot extends ActivityHandler {
    constructor(User, conversationState, userState, lastOrderByPhone = {}) {
        super();
        this.User = User;
        this.conversationState = conversationState;
        this.userState = userState;
        this.lastOrderByPhone = lastOrderByPhone || {};
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
            let text = context.activity.text && context.activity.text.trim();

            // DEBUG LOG
            console.log('[DEBUG] Incoming message:', { text, onboardingStep, userProfile });

            // Feedback window check
            const now = new Date();
            // Feedback window: 13:30–13:55 (lunch), 20:30–21:30 (dinner)
            const isLunchFeedbackWindow = (now.getHours() === 13 && now.getMinutes() >= 30 && now.getMinutes() <= 55);
            const isDinnerFeedbackWindow = 
                (now.getHours() === 20 && now.getMinutes() >= 30) ||
                (now.getHours() === 21 && now.getMinutes() <= 30);
            if (userProfile.phone && text && (isLunchFeedbackWindow || isDinnerFeedbackWindow)) {
                try {
                const latestOrder = await Order.findOne({ phone: userProfile.phone, status: 'Delivered' }).sort({ date: -1 });
                if (latestOrder) { 
                    await Order.findByIdAndUpdate(latestOrder._id, { feedback: text });
                    await context.sendActivity('Thank you for your feedback!');
                        console.log('[DEBUG] Feedback saved for order:', latestOrder._id);
                    return;
                    }
                } catch (err) {
                    console.error('[ERROR] Saving feedback:', err);
                }
            }

            // Check for pending order for this user
            let pendingOrder = null;
            if (userProfile.phone) {
                try {
                pendingOrder = await Order.findOne({ phone: userProfile.phone, status: 'Pending' }).sort({ date: -1 });
                } catch (err) {
                    console.error('[ERROR] Fetching pending order:', err);
                }
            }

            // Handle cancel order actions (from proactive card)
            if (context.activity.value && context.activity.value.action === 'cancel_order') {
                // Check if within allowed window
                const now = new Date();
                let allowed = false;
                let windowType = context.activity.value.windowType;
                if (windowType === 'lunch') {
                    // 8:35am to 9:00am
                    const mins = now.getHours() * 60 + now.getMinutes();
                    allowed = mins >= (6 * 60 + 35) && mins <= (9 * 60);
                } else if (windowType === 'dinner') {
                    // 4:35pm to 5:00pm
                    const mins = now.getHours() * 60 + now.getMinutes();
                    allowed = mins >= (16 * 60 + 35) && mins <= (17 * 60);
                }
                if (!allowed) {
                    await context.sendActivity('You cannot cancel your order now.');
                    return;
                }
                // Ask for confirmation
                await context.sendActivity({
                    attachments: [CardFactory.adaptiveCard({
                        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                        "type": "AdaptiveCard",
                        "version": "1.3",
                        "body": [
                            { "type": "TextBlock", "text": "Are you sure you want to cancel your order?", "weight": "Bolder", "wrap": true }
                        ],
                        "actions": [
                            { "type": "Action.Submit", "title": "Yes", "data": { action: "cancel_order_confirm", orderId: context.activity.value.orderId, windowType: windowType } },
                            { "type": "Action.Submit", "title": "No", "data": { action: "cancel_order_deny", orderId: context.activity.value.orderId } }
                        ]
                    })]
                });
                return;
            } else if (context.activity.value && context.activity.value.action === 'cancel_order_confirm') {
                try {
                    await axios.post('http://localhost:3978/api/send-otp', { phone: '+91' + userProfile.phone, channel: 'whatsapp' });
                    await context.sendActivity('An OTP has been sent to your WhatsApp. Please enter the OTP to verify before cancelling your order.');
                    userProfile.pendingCancelOrderId = context.activity.value.orderId;
                    await onboardingStepAccessor.set(context, ONBOARDING_STEPS.VERIFY_OTP_CANCEL);
                    await userProfileAccessor.set(context, userProfile);
                    await this.conversationState.saveChanges(context);
                    await this.userState.saveChanges(context);
                    console.log('[DEBUG] Sent OTP for order cancellation:', userProfile.phone);
                    return;
                } catch (e) {
                    console.error('[ERROR] Sending OTP for cancel:', e);
                    await context.sendActivity('Failed to send OTP. Please try again later.');
                return;
                }
            } else if (context.activity.value && context.activity.value.action === 'cancel_order_deny') {
                await context.sendActivity('Your order was not cancelled.');
                return;
            }

            // Handle update_profile action from Adaptive Card or text 'Yes' in ASK_UPDATE
            if ((context.activity.value && context.activity.value.action === 'update_profile') || (onboardingStep === ONBOARDING_STEPS.ASK_UPDATE && (text && text.toLowerCase() === 'yes'))) {
                try {
                const latestProfile = await this.User.findOne({ phone: userProfile.phone });
                if (latestProfile) {
                    await userProfileAccessor.set(context, latestProfile.toObject());
                }
                    await axios.post('http://localhost:3978/api/send-otp', { phone: '+91' + userProfile.phone, channel: 'whatsapp' });
                    await context.sendActivity('An OTP has been sent to your WhatsApp. Please enter the OTP to verify before updating your profile.');
                    await onboardingStepAccessor.set(context, ONBOARDING_STEPS.VERIFY_OTP_UPDATE);
                    await this.conversationState.saveChanges(context);
                    console.log('[DEBUG] Sent OTP for profile update:', userProfile.phone);
                    return;
                } catch (e) {
                    console.error('[ERROR] Sending OTP for profile update:', e);
                    await context.sendActivity('Failed to send OTP. Please try again later.');
                    await onboardingStepAccessor.set(context, ONBOARDING_STEPS.ASK_UPDATE);
                    await this.conversationState.saveChanges(context);
                    return;
                }
            }

            if (pendingOrder) {
                await this.sendOrderStatusCard(context, pendingOrder);
                return;
            }

            if (userProfile.phone && this.lastOrderByPhone[userProfile.phone]) {
                const { items, total } = this.lastOrderByPhone[userProfile.phone];
                await context.sendActivity(`We have received your order of Rs. ${total} for the following food items:\n- ${items.join('\n- ')}`);
                delete this.lastOrderByPhone[userProfile.phone];
            }

            if (userProfile.phone && text && text.toLowerCase().includes('profile')) {
                try {
                const existingUser = await this.User.findOne({ phone: userProfile.phone });
                if (existingUser) {
                    await context.sendActivity({
                        attachments: [this.profileAdaptiveCard(existingUser)],
                    });
                        await context.sendActivity('If you do not see your profile card above, your client may not support Adaptive Cards.');
                    await context.sendActivity({
                        attachments: [CardFactory.adaptiveCard({
                            "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                            "type": "AdaptiveCard",
                            "version": "1.3",
                            "body": [
                                { "type": "TextBlock", "text": "Would you like to update your profile?", "wrap": true },
                            ],
                            "actions": [
                                { "type": "Action.Submit", "title": "Update your profile", "data": { action: "update_profile" } }
                            ]
                        })]
                    });
                    await onboardingStepAccessor.set(context, ONBOARDING_STEPS.ASK_UPDATE);
                    await this.conversationState.saveChanges(context);
                        console.log('[DEBUG] Displayed profile card and asked for update.');
                    return;
                    }
                } catch (err) {
                    console.error('[ERROR] Showing profile card:', err);
                }
            }

            try {
            switch (onboardingStep) {
                case ONBOARDING_STEPS.NONE:
                    await context.sendActivity('To get started, may I have your phone number?');
                    await onboardingStepAccessor.set(context, ONBOARDING_STEPS.ASK_PHONE);
                    await this.conversationState.saveChanges(context);
                        console.log('[DEBUG] Set onboardingStep to ASK_PHONE');
                    break;
                case ONBOARDING_STEPS.ASK_PHONE:
                    if (!isValidPhoneNumber(text)) {
                        await context.sendActivity('Please enter a valid 10-digit phone number.');
                        break;
                    }
                    userProfile.phone = text;
                    try {
                        await axios.post('http://localhost:3978/api/send-otp', { phone: '+91' + text, channel: 'whatsapp' });
                        await context.sendActivity('An OTP has been sent to your WhatsApp. Please enter the OTP to verify your number.');
                        await onboardingStepAccessor.set(context, ONBOARDING_STEPS.VERIFY_OTP);
                            console.log('[DEBUG] Sent OTP for onboarding:', text);
                    } catch (e) {
                            console.error('[ERROR] Sending OTP for onboarding:', e);
                        await context.sendActivity('Failed to send OTP. Please try again later.');
                        await onboardingStepAccessor.set(context, ONBOARDING_STEPS.ASK_PHONE);
                    }
                    await this.conversationState.saveChanges(context);
                    break;
                case ONBOARDING_STEPS.VERIFY_OTP:
                    if (text.toLowerCase() === 'resend otp') {
                        try {
                            const resendRes = await axios.post('http://localhost:3978/api/resend-otp', { phone: '+91' + userProfile.phone, channel: 'whatsapp' });
                            if (resendRes.data && resendRes.data.success) {
                                await context.sendActivity('A new OTP has been sent to your WhatsApp. Please enter the OTP to verify your number.');
                            } else {
                                await context.sendActivity(resendRes.data.message || 'Failed to resend OTP. Please try again later.');
                            }
                                console.log('[DEBUG] Resent OTP for onboarding:', userProfile.phone);
                        } catch (e) {
                                console.error('[ERROR] Resending OTP for onboarding:', e);
                            if (e.response && e.response.data && e.response.data.message) {
                                await context.sendActivity(e.response.data.message);
                            } else {
                                await context.sendActivity('Failed to resend OTP. Please try again later.');
                            }
                        }
                        await context.sendActivity(MessageFactory.suggestedActions(['Resend OTP'], 'Please enter the OTP to verify your number.'));
                        break;
                    }
                    try {
                        const verifyRes = await axios.post('http://localhost:3978/api/verify-otp', { phone: '+91' + userProfile.phone, otp: text });
                        if (verifyRes.data && verifyRes.data.success) {
                            const existingUser = await this.User.findOne({ phone: userProfile.phone });
                            if (existingUser) {
                                await context.sendActivity({
                                    text: 'Phone number verified successfully!\n\nWelcome back! Here are your profile details:',
                                    attachments: [this.profileAdaptiveCard(existingUser)]
                                });
                                await context.sendActivity('If you do not see your profile card above, your client may not support Adaptive Cards.');
                                await onboardingStepAccessor.set(context, ONBOARDING_STEPS.ASK_UPDATE);
                                await context.sendActivity(MessageFactory.suggestedActions(['Yes', 'No'], 'Do you want to update this profile?'));
                                    console.log('[DEBUG] Verified OTP, showed profile, asked for update.');
                            } else {
                                await context.sendActivity('Phone number verified successfully!');
                                await onboardingStepAccessor.set(context, ONBOARDING_STEPS.ASK_NAME);
                                await context.sendActivity('Great! What is your name?');
                                    console.log('[DEBUG] Verified OTP, new user, asking for name.');
                            }
                        } else {
                            await context.sendActivity('Wrong OTP. Please try again.');
                            await context.sendActivity(MessageFactory.suggestedActions(['Resend OTP'], 'Please enter the OTP to verify your number.'));
                                console.log('[DEBUG] Wrong OTP entered for onboarding:', userProfile.phone);
                        }
                    } catch (e) {
                            console.error('[ERROR] Verifying OTP for onboarding:', e);
                        if (e.response && e.response.data && e.response.data.message && e.response.status === 429) {
                            await context.sendActivity(e.response.data.message);
                        } else {
                            await context.sendActivity('Wrong OTP. Please try again.');
                            await context.sendActivity(MessageFactory.suggestedActions(['Resend OTP'], 'Please enter the OTP to verify your number.'));
                        }
                    }
                    await this.conversationState.saveChanges(context);
                    break;
                case ONBOARDING_STEPS.ASK_UPDATE:
                    if (text && (text.toLowerCase() === 'no')) {
                        await context.sendActivity('Okay, your profile remains unchanged.');
                        await onboardingStepAccessor.set(context, ONBOARDING_STEPS.SHOW_MENU);
                        await this.showMenuAndOrderButton(context, userProfile.phone);
                        await this.conversationState.saveChanges(context);
                            console.log('[DEBUG] User chose not to update profile, showing menu.');
                        return;
                    } else if (text && text.toLowerCase() !== 'yes') {
                        await context.sendActivity(MessageFactory.suggestedActions(['Yes', 'No'], 'Do you want to update this profile?'));
                        await this.conversationState.saveChanges(context);
                        return;
                    }
                    await this.conversationState.saveChanges(context);
                    break;
                case ONBOARDING_STEPS.VERIFY_OTP_UPDATE:
                    if (text && text.toLowerCase() === 'resend otp') {
                        try {
                            const resendRes = await axios.post('http://localhost:3978/api/resend-otp', { phone: '+91' + userProfile.phone, channel: 'whatsapp' });
                            if (resendRes.data && resendRes.data.success) {
                                await context.sendActivity('A new OTP has been sent to your WhatsApp. Please enter the OTP to verify before updating your profile.');
                            } else {
                                await context.sendActivity(resendRes.data.message || 'Failed to resend OTP. Please try again later.');
                            }
                                console.log('[DEBUG] Resent OTP for profile update:', userProfile.phone);
                        } catch (e) {
                                console.error('[ERROR] Resending OTP for profile update:', e);
                            if (e.response && e.response.data && e.response.data.message) {
                                await context.sendActivity(e.response.data.message);
                            } else {
                                await context.sendActivity('Failed to resend OTP. Please try again later.');
                            }
                        }
                        await context.sendActivity(MessageFactory.suggestedActions(['Resend OTP'], 'Please enter the OTP to verify before updating your profile.'));
                        await this.conversationState.saveChanges(context);
                        return;
                    }
                    try {
                        const verifyRes = await axios.post('http://localhost:3978/api/verify-otp', { phone: '+91' + userProfile.phone, otp: text });
                        if (verifyRes.data && verifyRes.data.success) {
                            await context.sendActivity('OTP verified! You can now update your profile.');
                            await onboardingStepAccessor.set(context, ONBOARDING_STEPS.UPDATE_NAME);
                            await context.sendActivity("Let's update your profile. What is your name?");
                            await this.conversationState.saveChanges(context);
                                console.log('[DEBUG] Verified OTP for profile update, starting update flow.');
                            return;
                        } else {
                            await context.sendActivity('Wrong OTP. Please try again.');
                            await context.sendActivity(MessageFactory.suggestedActions(['Resend OTP'], 'Please enter the OTP to verify before updating your profile.'));
                            await this.conversationState.saveChanges(context);
                                console.log('[DEBUG] Wrong OTP for profile update:', userProfile.phone);
                            return;
                        }
                    } catch (e) {
                            console.error('[ERROR] Verifying OTP for profile update:', e);
                        if (e.response && e.response.status === 400) {
                            await context.sendActivity('Wrong OTP. Please try again.');
                            await context.sendActivity(MessageFactory.suggestedActions(['Resend OTP'], 'Please enter the OTP to verify before updating your profile.'));
                            await this.conversationState.saveChanges(context);
                            return;
                        } else if (e.response && e.response.data && e.response.data.message && e.response.status === 429) {
                            await context.sendActivity(e.response.data.message);
                            await this.conversationState.saveChanges(context);
                            return;
                        } else {
                            await context.sendActivity('Something went wrong. Please try again or resend OTP.');
                            await context.sendActivity(MessageFactory.suggestedActions(['Resend OTP'], 'Please enter the OTP to verify before updating your profile.'));
                            await this.conversationState.saveChanges(context);
                            return;
                        }
                    }
                    break;
                case ONBOARDING_STEPS.UPDATE_NAME:
                    userProfile.name = text;
                    await onboardingStepAccessor.set(context, ONBOARDING_STEPS.UPDATE_OFFICE);
                    await context.sendActivity('What is your office address?');
                    await this.conversationState.saveChanges(context);
                    break;
                case ONBOARDING_STEPS.UPDATE_OFFICE:
                    userProfile.officeAddress = text;
                    await onboardingStepAccessor.set(context, ONBOARDING_STEPS.UPDATE_HOME);
                    await context.sendActivity('What is your home address?');
                    await this.conversationState.saveChanges(context);
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
                    await this.conversationState.saveChanges(context);
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
                    await context.sendActivity({
                        text: 'Here are your updated profile details:',
                        attachments: [this.profileAdaptiveCard(await this.User.findOne({ phone: userProfile.phone }))]
                    });
                    await onboardingStepAccessor.set(context, ONBOARDING_STEPS.SHOW_MENU);
                    // Show menu after update
                    await this.showMenuAndOrderButton(context, userProfile.phone);
                    await this.conversationState.saveChanges(context);
                    break;
                case ONBOARDING_STEPS.ASK_NAME:
                    userProfile.name = text;
                    await onboardingStepAccessor.set(context, ONBOARDING_STEPS.ASK_OFFICE);
                    await context.sendActivity('What is your office address?');
                    await this.conversationState.saveChanges(context);
                    break;
                case ONBOARDING_STEPS.ASK_OFFICE:
                    userProfile.officeAddress = text;
                    await onboardingStepAccessor.set(context, ONBOARDING_STEPS.ASK_HOME);
                    await context.sendActivity('What is your home address?');
                    await this.conversationState.saveChanges(context);
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
                    await this.conversationState.saveChanges(context);
                    break;
                case ONBOARDING_STEPS.ASK_HEARD:
                    userProfile.heardFrom = text;
                    // Generate unique referral code
                    userProfile.referralCode = await generateUniqueReferralCode(userProfile.phone, this.User);
                    // Save to DB
                    const newUser = new this.User(userProfile);
                    await newUser.save();
                    await context.sendActivity({
                        text: 'Here are your new profile details:',
                        attachments: [this.profileAdaptiveCard(newUser)]
                    });
                    await onboardingStepAccessor.set(context, ONBOARDING_STEPS.SHOW_MENU);
                    // Show menu after profile creation
                    await this.showMenuAndOrderButton(context, userProfile.phone);
                    await this.conversationState.saveChanges(context);
                    break;
                case ONBOARDING_STEPS.COMPLETE:
                    await context.sendActivity('Your profile is already set up. If you want to update details, please contact support.');
                    await onboardingStepAccessor.set(context, ONBOARDING_STEPS.SHOW_MENU);
                    // Show menu after profile is shown and user denied update
                    await this.showMenuAndOrderButton(context, userProfile.phone);
                    await this.conversationState.saveChanges(context);
                    break;
                case ONBOARDING_STEPS.SHOW_MENU:
                    // If user sends anything after menu, just show menu again
                    // (But now, do nothing if order is pending)
                    await this.conversationState.saveChanges(context);
                    break;
                default:
                        console.log('[DEBUG] switch onboardingStep =', onboardingStep, ', text =', text);
                    await this.conversationState.saveChanges(context);
                    break;
                }
            } catch (err) {
                console.error('[ERROR] Main onboarding switch:', err);
                await context.sendActivity('Something went wrong. Please try again.');
            }
            await userProfileAccessor.set(context, userProfile);
            await this.conversationState.saveChanges(context);
            await this.userState.saveChanges(context);
            await next();
        });
    }

    async showMenuAndOrderButton(context, phone) {
        // Time-based menu sending
        const now = new Date();
        const hours = now.getHours();
        const minutes = now.getMinutes();
        // Helper to check if time is in a range
        function inRange(startH, startM, endH, endM) {
            const nowMins = hours * 60 + minutes;
            const start = startH * 60 + startM;
            const end = endH * 60 + endM;
            return nowMins >= start && nowMins <= end;
        }
        const isLunchTime = inRange(6, 0, 8, 30);
        const isDinnerTime = inRange(14, 0, 16, 30);
        if (isLunchTime || isDinnerTime) {
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
        } else {
            await context.sendActivity('You will receive the menu daily at 6am and 2pm. Ordering is open only between 6:00–8:30am for lunch and 2:00–4:30pm for dinner.');
        }
        await this.conversationState.saveChanges(context);
    }

    async sendOrderStatusCard(context, order) {
        // Load menu for price lookup
        const menu = loadMenu();
        const prices = {};
        menu.Lunch.forEach(item => { prices[item.name] = 20; });
        menu.Dinner.forEach(item => { prices[item.name] = 20; });
        menu.ExtraItems.forEach(item => { prices[item.name] = item.price; });
        const itemLines = order.items.map(item => `- ${item}: ₹${prices[item] || 20}`).join('\n');
        await context.sendActivity({
            attachments: [CardFactory.adaptiveCard({
                "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                "type": "AdaptiveCard",
                "version": "1.3",
                "body": [
                    { "type": "TextBlock", "text": `We have received your order of Rs. ${order.total} for the following food items:`, "wrap": true },
                    { "type": "TextBlock", "text": itemLines, "wrap": true },
                ]
                // No actions (no cancel button)
            })]
        });
        await this.conversationState.saveChanges(context);
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
                        { "title": "Heard About Us:", "value": user.heardFrom },
                        { "title": "Referral Code:", "value": user.referralCode || "-" },
                        { "title": "Successful Referrals:", "value": (user.successfulReferralsGiven || 0).toString() },
                        { "title": "Referrals Used:", "value": (user.referralsUsed || 0).toString() }
                    ]
                }
            ]
        });
    }
}

module.exports = { HealthyBitesBot, ONBOARDING_STEPS, isValidPhoneNumber, formatMenu, loadMenu }; 