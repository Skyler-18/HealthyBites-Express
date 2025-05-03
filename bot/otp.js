const twilio = require('twilio');

const accountSid = 'AC7299bb21dd7655edb100307367fc1973';
const authToken = 'fa76441b104c62543da4213358079ebe';
const client = twilio(accountSid, authToken);

const otpStore = {}; // In production, use Redis or DB for persistence
const attemptStore = {}; // { phone: [timestamps] }
const MAX_ATTEMPTS = 70;
const WINDOW_MS = 30 * 60 * 1000; // 30 minutes

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function isBlocked(phone) {
    const now = Date.now();
    if (!attemptStore[phone]) return false;
    // Remove old attempts
    attemptStore[phone] = attemptStore[phone].filter(ts => now - ts < WINDOW_MS);
    return attemptStore[phone].length >= MAX_ATTEMPTS;
}

function recordAttempt(phone) {
    const now = Date.now();
    if (!attemptStore[phone]) attemptStore[phone] = [];
    attemptStore[phone].push(now);
    // Keep only recent attempts
    attemptStore[phone] = attemptStore[phone].filter(ts => now - ts < WINDOW_MS);
}

async function sendOTP(phone, channel = 'sms') {
    if (isBlocked(phone)) throw new Error('Too many OTP attempts. Please try again after 30 minutes.');
    const otp = generateOTP();
    otpStore[phone] = { otp, expires: Date.now() + 5 * 60 * 1000 };
    recordAttempt(phone);
    let from, to, body;
    body = `Your OTP for HealthyBites is: ${otp}`;
    if (channel === 'whatsapp') {
        from = 'whatsapp:+14155238886';
        to = phone.startsWith('whatsapp:') ? phone : `whatsapp:${phone}`;
    } else {
        from = '+14155238886';
        to = phone.startsWith('+') ? phone : `+91${phone}`;
    }
    await client.messages.create({ body, from, to });
    return true;
}

async function resendOTP(phone, channel = 'sms') {
    if (isBlocked(phone)) throw new Error('Too many OTP attempts. Please try again after 30 minutes.');
    let otp, expires;
    if (otpStore[phone] && Date.now() < otpStore[phone].expires) {
        otp = otpStore[phone].otp;
        expires = otpStore[phone].expires;
    } else {
        otp = generateOTP();
        expires = Date.now() + 5 * 60 * 1000;
        otpStore[phone] = { otp, expires };
    }
    recordAttempt(phone);
    let from, to, body;
    body = `Your OTP for HealthyBites is: ${otp}`;
    if (channel === 'whatsapp') {
        from = 'whatsapp:+14155238886';
        to = phone.startsWith('whatsapp:') ? phone : `whatsapp:${phone}`;
    } else {
        from = '+14155238886';
        to = phone.startsWith('+') ? phone : `+91${phone}`;
    }
    await client.messages.create({ body, from, to });
    return true;
}

function verifyOTP(phone, otp) {
    if (isBlocked(phone)) return false;
    recordAttempt(phone);
    const record = otpStore[phone];
    if (!record) return false;
    if (Date.now() > record.expires) return false;
    if (record.otp !== otp) return false;
    delete otpStore[phone];
    return true;
}

module.exports = { sendOTP, resendOTP, verifyOTP, isBlocked }; 