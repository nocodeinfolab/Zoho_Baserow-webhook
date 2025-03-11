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

// Function to create a contact (customer) in Zoho Books
async function createContact(contactName) {
    try {
        const response = await axios.post(
            `https://www.zohoapis.com/books/v3/contacts?organization_id=${ZOHO_ORGANIZATION_ID}`,
            { contact_name: contactName },
            { headers: { Authorization: `Zoho-oauthtoken ${ZOHO_ACCESS_TOKEN}` } }
        );
        console.log("Contact created successfully:", response.data.contact);
        return response.data.contact.contact_id; // Return the contact ID
    } catch (error) {
        console.error("Error creating contact:", error.response ? error.response.data : error.message);
        throw new Error("Failed to create contact");
    }
}

// Webhook endpoint for Baserow
app.post("/webhook", async (req, res) => {
    console.log("Webhook Payload:", JSON.stringify(req.body, null, 2));
    try {
        // Extract the first item from the payload
        const transaction = req.body.items[0];

        // Extract the contact name from the payload
        const contactName = transaction["Patient Name"]?.[0]?.value || "Unknown Contact";
        console.log("Extracted Contact Name:", contactName);

        // Create the contact in Zoho Books
        const contactId = await createContact(contactName);
        console.log("Contact ID:", contactId);

        res.status(200).json({ message: "Contact created successfully", contactId });
    } catch (error) {
        console.error("Error processing webhook:", error);
        res.status(500).json({ message: "Error processing webhook", error: error.message });
    }
});

// Server setup
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
