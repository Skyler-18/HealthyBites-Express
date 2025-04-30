const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    phone: { type: String, unique: true, required: true },
    name: String,
    officeAddress: String,
    homeAddress: String,
    heardFrom: String,
    subscriptionStatus: { type: String, default: 'None' },
    subscriptionEndDate: { type: Date },
    order_lunch: [String],
    order_dinner: [String],
    conversationReference: { type: mongoose.Schema.Types.Mixed },
    referralCode: { type: String, unique: true, uppercase: true },
    successfulReferralsGiven: { type: Number, default: 0 },
    referralsUsed: { type: Number, default: 0 },
    allReferralsUsed: { type: [String], default: [] },
});

const Profile = mongoose.model('Profiles', userSchema);

module.exports = Profile; 