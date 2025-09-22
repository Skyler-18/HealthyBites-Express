Here is the list of all features this chatbot offers:

---

# **1. Menu Sharing (Proactive Messaging)**
- **Good Morning Menu:**  
  - **When:** 6:00AM (or your test time, e.g., 14:11)  
  - **How:** Cron job sends a proactive message to all users with a valid conversation reference.
  - **Message:** “Good Morning [Name]! Here’s today’s menu: ...”
- **Good Afternoon Menu:**  
  - **When:** 2:00PM (or your test time, e.g., 20:16)  
  - **How:** Cron job sends a proactive message to all users with a valid conversation reference.
  - **Message:** “Good Afternoon [Name]! Here’s today’s menu: ...”

---

# **2. Menu Ordering Windows**
- **Lunch Ordering Window:**  
  - **When:** 6:00AM to 8:30AM  
  - **How:** If a user interacts with the bot or opens the order page during this window:
    - The menu and “Order Now” button are shown.
    - On the web page, only Lunch and Extra Items are visible.
    - The “Save these items for everyday” button is available (unless user has a dinner-only subscription).
- **Dinner Ordering Window:**  
  - **When:** 2:00PM to 4:30PM  
  - **How:** If a user interacts with the bot or opens the order page during this window:
    - The menu and “Order Now” button are shown.
    - On the web page, only Dinner and Extra Items are visible.
    - The “Save these items for everyday” button is available (unless user has a lunch-only subscription).
- **Outside These Windows:**  
  - The bot/webpage tells the user:  
    “You will receive the menu daily at 6am and 2pm. Ordering is open only between 6:00–8:30am for lunch and 2:00–4:30pm for dinner.”
  - The order button is hidden.

---

# **3. Default Orders (Subscription Users)**
- **At 8:31AM:**  
  - Cron job checks all users with `Monthly_Lunch` or `Monthly` subscription.
  - If the user has a default lunch order and **no pending order**, it creates a new pending order for them.
- **At 4:31PM:**  
  - Cron job checks all users with `Monthly_Dinner` or `Monthly` subscription.
  - If the user has a default dinner order and **no pending order**, it creates a new pending order for them.

---

# **4. Cancel Window**
- **At 8:35AM:**  
  - Cron job sends a proactive message to all users with a pending lunch order created before 8:35AM.
  - Message includes a “Cancel Order” button.
  - **Cancel Window:** 8:35AM–9:00AM
    - If the user clicks the cancel button during this window, the bot asks for confirmation and cancels the order if confirmed.
    - If outside this window, the bot replies: “You cannot cancel your order now.”
- **At 4:35PM:**  
  - Cron job sends a proactive message to all users with a pending dinner order created before 4:35PM.
  - Message includes a “Cancel Order” button.
  - **Cancel Window:** 4:35PM–5:00PM
    - Same logic as above.

---

# **5. Feedback Window**
- **At 1:30PM:**  
  - Cron job finds all orders with status `Pending`.
  - For each, sends a proactive message: “Hope you have received your order. Please share your feedback about our service.”
  - All those orders are then marked as `Delivered`.
  - **Feedback Window:** 1:30PM–1:55PM
    - If the user sends a message during this window, it is stored as feedback in their latest delivered order.
- **At 8:30PM:**  
  - Cron job finds all orders with status `Pending`.
  - For each, sends a proactive message: “Hope you have received your order. Please share your feedback about our service.”
  - All those orders are then marked as `Delivered`.
  - **Feedback Window:** 8:30PM–9:30PM
    - If the user sends a message during this window, it is stored as feedback in their latest delivered order.

---

# **6. Web Page Logic**
- **Menu visibility:**  
  - Lunch/Extra Items: 6:00–8:30AM  
  - Dinner/Extra Items: 2:00–4:30PM  
  - Otherwise: message about order windows, no order button.
- **Save Default Button:**  
  - Only shown during valid order windows.
  - Disabled if user’s subscription does not allow saving for that meal type.
- **Order Confirmation Page:**  
  - Tells user:  
    “You can close this window. If you wish, you can cancel your order between 8:35am to 9am for lunch and between 4:35pm to 5pm for dinner.”

---

# **7. Subscription/Payment Logic**
- If user is `Monthly`, or has the correct meal subscription for the current window, they can order without payment.
- If user has a lunch-only subscription and tries to order dinner (or vice versa), they can only “Pay for Today” (no subscribe button).
- If unsubscribed, both “Pay for Today” and “Subscribe for a Month” are shown.

---

# **8. Conversation Reference Persistence**
- Conversation references are stored in the user’s profile in the database.
- Proactive messages (menu, cancel, feedback) work even after server restarts, as long as the user has interacted with the bot at least once.

---

# **9. Order Table State Transitions**
- **Created:**  
  - By user order, or by default order cron job.
- **Pending:**  
  - Until cancel window or feedback window.
- **Canceled:**  
  - If user cancels during the allowed window.
- **Delivered:**  
  - After feedback cron job runs (1:30PM or 8:30PM).

---

# **10. Feedback Storage**
- Only the latest delivered order for a user is updated with feedback, and only if the message is sent during the feedback window.

---

## **Summary Table**

| Event                | Time Window         | Action/Message                                 | Validity/Effect                |
|----------------------|--------------------|------------------------------------------------|-------------------------------|
| Menu Proactive       | 6:00AM, 2:00PM     | Menu shared to all users                       | Until next menu or order window|
| Lunch Order Window   | 6:00–8:30AM        | User can order lunch                           | Only during this window        |
| Dinner Order Window  | 2:00–4:30PM        | User can order dinner                          | Only during this window        |
| Default Order Insert | 8:31AM, 4:31PM     | Default order added if no pending order        | Once per meal per day          |
| Cancel Window        | 8:35–9:00AM, 4:35–5:00PM | Cancel button works for pending orders   | Only during this window        |
| Feedback Request     | 1:30PM, 8:30PM     | Feedback message sent, orders marked delivered  | Only at these times            |
| Feedback Window      | 1:30–1:55PM, 8:30–9:30PM | User feedback stored in latest delivered order | Only during this window        |

---
