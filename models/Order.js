const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
    phone: { type: String, required: true },
    items: [{ type: String, required: true }],
    total: { type: Number, required: true },
    date: { type: Date, required: true }
});

const Order = mongoose.model('Order', orderSchema);

module.exports = Order; 