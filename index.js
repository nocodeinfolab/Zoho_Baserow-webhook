require("dotenv").config();
const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json());

// Zoho Credentials
const ZOHO_ACCESS_TOKEN = process.env.ZOHO_ACCESS_TOKEN;
const ZOHO_ORGANIZATION_ID = process.env.ZOHO_ORGANIZATION_ID;
const PORT = process.env.PORT || 3000;

// Function to create a customer in Zoho Books
async function createCustomer(customerName) {
    try {
        const response = await axios.post(
            `https://www.zohoapis.com/books/v3/contacts?organization_id=${ZOHO_ORGANIZATION_ID}`,
            { contact_name: customerName },
            { headers: { Authorization: `Zoho-oauthtoken ${ZOHO_ACCESS_TOKEN}` } }
        );
        console.log("Customer created successfully:", response.data.contact);
        return response.data.contact.contact_id; // Return the customer ID
    } catch (error) {
        console.error("Error creating customer:", error.response ? error.response.data : error.message);
        throw new Error("Failed to create customer");
    }
}

// Webhook endpoint for Baserow
app.post("/webhook", async (req, res) => {
    console.log("Webhook Payload:", JSON.stringify(req.body, null, 2));
    try {
        const transaction = req.body;

        // Extract the customer name from the payload
        const customerName = transaction["Patient Name"]?.[0]?.value || "Unknown Customer";

        // Create the customer in Zoho Books
        const customerId = await createCustomer(customerName);
        console.log("Customer ID:", customerId);

        res.status(200).json({ message: "Customer created successfully", customerId });
    } catch (error) {
        console.error("Error processing webhook:", error);
        res.status(500).json({ message: "Error processing webhook", error: error.message });
    }
});

// Server setup
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
