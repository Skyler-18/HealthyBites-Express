const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    phone: { type: String, unique: true, required: true },
    name: String,
    officeAddress: String,
    homeAddress: String,
    heardFrom: String,
    subscriptionStatus: { type: String, default: 'None' },
    subscriptionEndDate: { type: Date },
});

const Profile = mongoose.model('Profiles', userSchema);

module.exports = Profile; 