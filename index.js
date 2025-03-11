require("dotenv").config();
const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json());

// Zoho Credentials
let ZOHO_ACCESS_TOKEN = process.env.ZOHO_ACCESS_TOKEN;
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_ORGANIZATION_ID = process.env.ZOHO_ORGANIZATION_ID;
const PORT = process.env.PORT || 3000;

// Function to refresh Zoho token
async function refreshZohoToken() {
    try {
        console.log("Refreshing Zoho access token...");
        const response = await axios.post("https://accounts.zoho.com/oauth/v2/token", null, {
            params: {
                refresh_token: ZOHO_REFRESH_TOKEN,
                client_id: ZOHO_CLIENT_ID,
                client_secret: ZOHO_CLIENT_SECRET,
                grant_type: "refresh_token"
            }
        });
        ZOHO_ACCESS_TOKEN = response.data.access_token;
        console.log("Zoho Access Token Refreshed");
    } catch (error) {
        console.error("Failed to refresh Zoho token:", error.response?.data || error.message);
        throw new Error("Failed to refresh Zoho token");
    }
}

// Function to ensure Zoho token is valid
async function ensureZohoToken() {
    if (!ZOHO_ACCESS_TOKEN) {
        await refreshZohoToken();
    }
}

// Function to find or create a customer
async function findOrCreateCustomer(customerName) {
    try {
        await ensureZohoToken();
        
        if (!customerName) {
            console.warn("Missing customer name. Cannot proceed.");
            throw new Error("Customer name is required");
        }
        
        const searchResponse = await axios.get(
            `https://www.zohoapis.com/books/v3/contacts?organization_id=${ZOHO_ORGANIZATION_ID}&contact_name=${encodeURIComponent(customerName)}`,
            { headers: { Authorization: `Zoho-oauthtoken ${ZOHO_ACCESS_TOKEN}` } }
        );

        if (searchResponse.data.contacts?.length > 0) {
            return searchResponse.data.contacts[0].contact_id;
        } else {
            const createResponse = await axios.post(
                `https://www.zohoapis.com/books/v3/contacts?organization_id=${ZOHO_ORGANIZATION_ID}`,
                { contact_name: customerName },
                { headers: { Authorization: `Zoho-oauthtoken ${ZOHO_ACCESS_TOKEN}` } }
            );
            return createResponse.data.contact.contact_id;
        }
    } catch (error) {
        console.error("Error finding or creating customer:", error.response?.data || error.message);
        throw new Error("Failed to find or create customer");
    }
}

// Function to create an invoice
async function createInvoice(transaction) {
    try {
        await ensureZohoToken();
        const customerName = transaction["Patient Name ParameterID"] || "Unknown Patient";
        const customerId = await findOrCreateCustomer(customerName);
        const services = transaction["Services (link)"]?.[0]?.value || "Medical Services";
        
        const invoiceData = {
            customer_id: customerId,
            reference_number: transaction["Transaction ID"],
            date: transaction["Date"] || new Date().toISOString().split("T")[0],
            line_items: [{ description: services, rate: transaction["Payable Amount"], quantity: 1 }]
        };
        
        const response = await axios.post(
            `https://www.zohoapis.com/books/v3/invoices?organization_id=${ZOHO_ORGANIZATION_ID}`,
            invoiceData,
            { headers: { Authorization: `Zoho-oauthtoken ${ZOHO_ACCESS_TOKEN}` } }
        );
        return response.data.invoice;
    } catch (error) {
        console.error("Error creating invoice:", error.response?.data || error.message);
        throw new Error("Failed to create invoice");
    }
}

// Function to record a payment
async function recordPayment(invoiceId, amount) {
    try {
        await ensureZohoToken();
        if (!invoiceId || !amount) return;
        
        const paymentData = {
            invoice_id: invoiceId,
            amount: amount,
            payment_mode: "cash",
            date: new Date().toISOString().split("T")[0]
        };
        
        await axios.post(
            `https://www.zohoapis.com/books/v3/customerpayments?organization_id=${ZOHO_ORGANIZATION_ID}`,
            paymentData,
            { headers: { Authorization: `Zoho-oauthtoken ${ZOHO_ACCESS_TOKEN}` } }
        );
        console.log("Payment recorded successfully");
    } catch (error) {
        console.error("Error recording payment:", error.response?.data || error.message);
    }
}

// Webhook endpoint
app.post("/webhook", async (req, res) => {
    console.log("Webhook Payload:", JSON.stringify(req.body, null, 2));
    try {
        const transaction = req.body;
        const newInvoice = await createInvoice(transaction);
        await recordPayment(newInvoice.invoice_id, transaction["Amount Paid (Cash)"] || 0);
        res.status(200).json({ message: "Invoice processed successfully" });
    } catch (error) {
        console.error("Error processing webhook:", error);
        res.status(500).json({ message: "Error processing webhook", error: error.message });
    }
});

// Server setup
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
