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
        console.log("Zoho Access Token Refreshed:", ZOHO_ACCESS_TOKEN);
    } catch (error) {
        console.error("Failed to refresh Zoho token:", error.response ? error.response.data : error.message);
        throw new Error("Failed to refresh Zoho token");
    }
}

// Function to ensure Zoho token is valid
async function ensureZohoToken() {
    if (!ZOHO_ACCESS_TOKEN) {
        console.log("Access token missing. Refreshing...");
        await refreshZohoToken();
    } else {
        console.log("Access token is present.");
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
        console.log("Zoho API Response for Find Invoice:", JSON.stringify(response.data, null, 2)); // Log the response

        // Filter invoices by reference_number
        const matchingInvoices = response.data.invoices.filter(
            invoice => invoice.reference_number === transactionId
        );

        if (matchingInvoices.length > 0) {
            return matchingInvoices[0];
        }
        return null;
    } catch (error) {
        console.error("Error finding invoice:", error.response ? error.response.data : error.message);
        return null;
    }
}

// Function to find or create a customer in Zoho Books
async function findOrCreateCustomer(customerName) {
    try {
        await ensureZohoToken();

        // Search for the customer in Zoho Books
        const searchResponse = await axios.get(
            `https://www.zohoapis.com/books/v3/contacts?organization_id=${ZOHO_ORGANIZATION_ID}&contact_name=${encodeURIComponent(customerName)}`,
            { headers: { Authorization: `Zoho-oauthtoken ${ZOHO_ACCESS_TOKEN}` } }
        );

        if (searchResponse.data.contacts && searchResponse.data.contacts.length > 0) {
            // Customer exists, return the first match
            return searchResponse.data.contacts[0].contact_id;
        } else {
            // Customer does not exist, create a new one
            const createResponse = await axios.post(
                `https://www.zohoapis.com/books/v3/contacts?organization_id=${ZOHO_ORGANIZATION_ID}`,
                { contact_name: customerName },
                { headers: { Authorization: `Zoho-oauthtoken ${ZOHO_ACCESS_TOKEN}` } }
            );
            return createResponse.data.contact.contact_id;
        }
    } catch (error) {
        console.error("Error finding or creating customer:", error.response ? error.response.data : error.message);
        throw new Error("Failed to find or create customer");
    }
}

// Function to create an invoice
async function createInvoice(transaction) {
    try {
        await ensureZohoToken();

        // Extract the full customer name (including numbers)
        const patientName = transaction["Patient Name"]?.[0]?.value || "Unknown Patient";

        // Find or create the customer in Zoho Books
        const customerId = await findOrCreateCustomer(patientName);

        // Extract the service name
        const services = transaction["Services (link)"]?.[0]?.value || "Medical Services";

        const invoiceData = {
            customer_id: customerId, // Use customer_id instead of customer_name
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
        console.log("Zoho API Response for Create Invoice:", JSON.stringify(response.data, null, 2)); // Log the response
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
        console.log("Payment recorded successfully");
    } catch (error) {
        console.error("Error recording payment:", error.response ? error.response.data : error.message);
    }
}

// Webhook endpoint for Baserow
app.post("/webhook", async (req, res) => {
    console.log("Webhook Payload:", JSON.stringify(req.body, null, 2));
    try {
        // Extract the first item from the payload
        const transaction = req.body.items[0];

        // Extract the transaction ID
        const transactionId = transaction["Transaction ID"];

        // Find an existing invoice
        const existingInvoice = await findExistingInvoice(transactionId);

        if (existingInvoice) {
            console.log("Existing Invoice:", JSON.stringify(existingInvoice, null, 2)); // Log the existing invoice
            console.log("Existing invoice found. Checking for changes...");

            // Check if line_items exists and has at least one item
            if (!existingInvoice.line_items || existingInvoice.line_items.length === 0) {
                throw new Error("Existing invoice has no line items");
            }

            const existingServices = existingInvoice.line_items[0].description;
            const newServices = transaction["Services (link)"]?.[0]?.value || "Medical Services";

            if (existingServices !== newServices ||
                existingInvoice.line_items[0].rate !== transaction["Payable Amount"]) {
                console.log("Invoice details changed. Voiding old invoice and creating a new one...");
                await voidInvoice(existingInvoice.invoice_id);
                const newInvoice = await createInvoice(transaction);
                await recordPayment(newInvoice.invoice_id, transaction["Amount Paid (Cash)"] || 0, "cash");
            }
        } else {
            console.log("No existing invoice found. Creating a new one...");
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
