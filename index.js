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
        console.log("Extracted Patient Name:", patientName);

        // Find or create the customer in Zoho Books
        const customerId = await findOrCreateCustomer(patientName);
        console.log("Customer ID:", customerId);

        // Extract services and prices
        const services = transaction["Services"] || [];
        const prices = transaction["Prices"] || [];
        const lineItems = services.map((service, index) => ({
            description: service.value || "Service",
            rate: parseFloat(prices[index]?.value) || 0,
            quantity: 1
        }));

        // Extract the total payable amount
        const payableAmount = parseFloat(transaction["Payable Amount"]) || 0;

        const invoiceData = {
            customer_id: customerId, // Use customer_id instead of customer_name
            reference_number: transaction["Transaction ID"],
            date: transaction["Date"] || new Date().toISOString().split("T")[0],
            line_items: lineItems,
            total: payableAmount // Set the total payable amount
        };

        console.log("Invoice Data:", JSON.stringify(invoiceData, null, 2)); // Log the invoice data

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

// Function to record a payment and apply it to the invoice
async function recordPayment(invoiceId, amount, mode) {
    try {
        await ensureZohoToken();

        // Fetch the invoice to verify the customer_id
        const invoiceResponse = await axios.get(
            `https://www.zohoapis.com/books/v3/invoices/${invoiceId}?organization_id=${ZOHO_ORGANIZATION_ID}`,
            { headers: { Authorization: `Zoho-oauthtoken ${ZOHO_ACCESS_TOKEN}` } }
        );
        console.log("Invoice Details:", JSON.stringify(invoiceResponse.data, null, 2)); // Log the invoice details

        const customerId = invoiceResponse.data.invoice.customer_id;
        console.log("Customer ID in Invoice:", customerId);

        // Payment data with invoice application details
        const paymentData = {
            customer_id: customerId, // Ensure the customer_id is included
            payment_mode: mode,
            amount: amount,
            date: new Date().toISOString().split("T")[0],
            invoices: [
                {
                    invoice_id: invoiceId,
                    amount_applied: amount // Apply the full payment amount to this invoice
                }
            ]
        };

        console.log("Payment Data:", JSON.stringify(paymentData, null, 2)); // Log the payment data

        const paymentResponse = await axios.post(
            `https://www.zohoapis.com/books/v3/customerpayments?organization_id=${ZOHO_ORGANIZATION_ID}`,
            paymentData,
            { headers: { Authorization: `Zoho-oauthtoken ${ZOHO_ACCESS_TOKEN}` } }
        );
        console.log("Payment recorded and applied successfully:", JSON.stringify(paymentResponse.data, null, 2)); // Log the payment response
    } catch (error) {
        console.error("Error recording payment:", error.response ? error.response.data : error.message);
        throw new Error("Failed to record payment");
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
                console.log("Existing invoice has no line items. Voiding and creating a new invoice...");
                await voidInvoice(existingInvoice.invoice_id); // Void the existing invoice
                const newInvoice = await createInvoice(transaction); // Create a new invoice
                await recordPayment(newInvoice.invoice_id, transaction["Total Amount Paid"] || 0, "cash"); // Record payment
            } else {
                // Compare existing invoice details with new transaction data
                const existingServices = existingInvoice.line_items.map(item => item.description);
                const newServices = transaction["Services"]?.map(service => service.value) || [];

                const existingTotal = existingInvoice.line_items.reduce((sum, item) => sum + item.rate, 0);
                const newTotal = parseFloat(transaction["Payable Amount"]) || 0;

                if (JSON.stringify(existingServices) !== JSON.stringify(newServices) ||
                    existingTotal !== newTotal) {
                    console.log("Invoice details changed. Voiding old invoice and creating a new one...");
                    await voidInvoice(existingInvoice.invoice_id); // Void the existing invoice
                    const newInvoice = await createInvoice(transaction); // Create a new invoice
                    await recordPayment(newInvoice.invoice_id, transaction["Total Amount Paid"] || 0, "cash"); // Record payment
                } else {
                    console.log("No changes detected. Skipping invoice update.");
                }
            }
        } else {
            console.log("No existing invoice found. Creating a new one...");
            const newInvoice = await createInvoice(transaction); // Create a new invoice
            await recordPayment(newInvoice.invoice_id, transaction["Total Amount Paid"] || 0, "cash"); // Record payment
        }

        res.status(200).json({ message: "Invoice processed successfully" });
    } catch (error) {
        console.error("Error details:", error);
        res.status(500).json({ message: "Error processing webhook", error: error.message });
    }
});

// Server setup
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
