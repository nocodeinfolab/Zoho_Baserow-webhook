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
        console.error("Failed to refresh Zoho token:", error.response ? error.response.data : error.message);
        throw new Error("Failed to refresh Zoho token");
    }
}

// Function to ensure Zoho token is valid
async function ensureZohoToken() {
    if (!ZOHO_ACCESS_TOKEN) {
        await refreshZohoToken();
    }
}

// Function to find an existing invoice
async function findExistingInvoice(transactionId) {
    try {
        await ensureZohoToken();
        const response = await axios.get(
            `https://www.zohoapis.com/books/v3/invoices?organization_id=${ZOHO_ORGANIZATION_ID}&reference_number=${transactionId}`,
            { headers: { Authorization: `Zoho-oauthtoken ${ZOHO_ACCESS_TOKEN}` } }
        );
        return response.data.invoices.find(invoice => invoice.reference_number === transactionId) || null;
    } catch (error) {
        console.error("Error finding invoice:", error.response ? error.response.data : error.message);
        return null;
    }
}

// Function to find or create a customer in Zoho Books
async function findOrCreateCustomer(customerId) {
    try {
        await ensureZohoToken();
        
        // Check if customer ID exists
        if (customerId) {
            const response = await axios.get(
                `https://www.zohoapis.com/books/v3/contacts/${customerId}?organization_id=${ZOHO_ORGANIZATION_ID}`,
                { headers: { Authorization: `Zoho-oauthtoken ${ZOHO_ACCESS_TOKEN}` } }
            );
            return response.data.contact.contact_id;
        }

        // If no valid customer ID, create a new generic customer
        const createResponse = await axios.post(
            `https://www.zohoapis.com/books/v3/contacts?organization_id=${ZOHO_ORGANIZATION_ID}`,
            { contact_name: "New Patient" },
            { headers: { Authorization: `Zoho-oauthtoken ${ZOHO_ACCESS_TOKEN}` } }
        );
        return createResponse.data.contact.contact_id;
    } catch (error) {
        console.error("Error finding or creating customer:", error.response ? error.response.data : error.message);
        throw new Error("Failed to find or create customer");
    }
}

// Function to create an invoice
async function createInvoice(transaction) {
    try {
        await ensureZohoToken();
        
        const customerId = await findOrCreateCustomer(transaction["Patient Name ParameterID"]);
        const services = transaction["Services (link)"]?.[0]?.value || "Medical Services";

        const invoiceData = {
            customer_id: customerId,
            reference_number: transaction["Transaction ID"],
            date: transaction["Date"] || new Date().toISOString().split("T")[0],
            line_items: [{
                description: services,
                rate: transaction["Payable Amount"],
                quantity: 1
            }]
        };

        const response = await axios.post(
            `https://www.zohoapis.com/books/v3/invoices?organization_id=${ZOHO_ORGANIZATION_ID}`,
            invoiceData,
            { headers: { Authorization: `Zoho-oauthtoken ${ZOHO_ACCESS_TOKEN}` } }
        );
        return response.data.invoice;
    } catch (error) {
        console.error("Zoho API Error:", error.response ? error.response.data : error.message);
        throw new Error("Failed to create invoice");
    }
}

// Function to record a payment
async function recordPayment(invoiceId, amount, mode) {
    try {
        await ensureZohoToken();
        const paymentData = {
            invoice_id: invoiceId,
            amount: amount,
            payment_mode: mode,
            date: new Date().toISOString().split("T")[0]
        };
        await axios.post(
            `https://www.zohoapis.com/books/v3/customerpayments?organization_id=${ZOHO_ORGANIZATION_ID}`,
            paymentData,
            { headers: { Authorization: `Zoho-oauthtoken ${ZOHO_ACCESS_TOKEN}` } }
        );
    } catch (error) {
        console.error("Error recording payment:", error.response ? error.response.data : error.message);
    }
}

// Webhook endpoint for Baserow
app.post("/webhook", async (req, res) => {
    try {
        const transaction = req.body;
        const transactionId = transaction["Transaction ID"];
        const existingInvoice = await findExistingInvoice(transactionId);

        if (existingInvoice) {
            console.log("Invoice already exists, skipping creation.");
        } else {
            const newInvoice = await createInvoice(transaction);
            await recordPayment(newInvoice.invoice_id, transaction["Amount Paid (Cash)"] || 0, "cash");
        }

        res.status(200).json({ message: "Invoice processed successfully" });
    } catch (error) {
        console.error("Error details:", error);
        res.status(500).json({ message: "Error processing webhook", error: error.message });
    }
});

// Server setup
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
