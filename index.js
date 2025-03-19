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

// Function to make API requests with token expiration handling
async function makeZohoRequest(config, retry = true) {
    try {
        config.headers = {
            ...config.headers,
            Authorization: `Zoho-oauthtoken ${ZOHO_ACCESS_TOKEN}`
        };
        const response = await axios(config);
        return response.data;
    } catch (error) {
        const isTokenExpired = error.response && (error.response.status === 401 || error.response.data.code === 57);
        if (isTokenExpired && retry) {
            console.log("Access token expired or invalid. Refreshing token and retrying request...");
            await refreshZohoToken();
            return makeZohoRequest(config, false); // Retry the request once with the new token
        } else {
            console.error("API request failed:", error.response ? error.response.data : error.message);
            throw new Error("API request failed");
        }
    }
}

// Function to find an existing invoice
async function findExistingInvoice(referenceNumber) {
    try {
        const response = await makeZohoRequest({
            method: "get",
            url: `https://www.zohoapis.com/books/v3/invoices?organization_id=${ZOHO_ORGANIZATION_ID}&reference_number=${referenceNumber}`
        });
        const matchingInvoices = response.invoices.filter(invoice => invoice.reference_number === referenceNumber);
        return matchingInvoices.length > 0 ? matchingInvoices[0] : null;
    } catch (error) {
        console.error("Error finding invoice:", error.message);
        return null;
    }
}

// Function to find a payment by reference number
async function findPaymentByReferenceNumber(referenceNumber) {
    try {
        const response = await makeZohoRequest({
            method: "get",
            url: `https://www.zohoapis.com/books/v3/customerpayments?organization_id=${ZOHO_ORGANIZATION_ID}&reference_number=${referenceNumber}`
        });
        if (response.customerpayments && response.customerpayments.length > 0) {
            return response.customerpayments[0]; // Return the first matching payment
        }
        return null;
    } catch (error) {
        console.error("Error finding payment by reference number:", error.message);
        throw new Error("Failed to find payment by reference number");
    }
}

// Function to delete a payment
async function deletePayment(paymentId) {
    try {
        await makeZohoRequest({
            method: "delete",
            url: `https://www.zohoapis.com/books/v3/customerpayments/${paymentId}?organization_id=${ZOHO_ORGANIZATION_ID}`
        });
        console.log("Payment deleted successfully");
    } catch (error) {
        console.error("Error deleting payment:", error.response ? error.response.data : error.message);
        throw new Error("Failed to delete payment");
    }
}

// Function to update an invoice
async function updateInvoice(invoiceId, transaction) {
    try {
        // Prepare line items
        const lineItems = (transaction["Services (link)"] || []).map((service, index) => ({
            description: service.value || "Service",
            rate: parseFloat(transaction["Prices"][index]?.value) || 0,
            quantity: 1
        }));

        // Prepare invoice data
        const invoiceData = {
            line_items: lineItems,
            total: parseFloat(transaction["Payable Amount"]) || 0,
            discount: parseFloat(transaction["Discount"]) || 0,
            discount_type: "entity_level",
            is_discount_before_tax: true,
            reason: "Updating invoice due to payment adjustment"
        };

        console.log("Updating Invoice Data:", JSON.stringify(invoiceData, null, 2));

        // Update the invoice
        const response = await makeZohoRequest({
            method: "put",
            url: `https://www.zohoapis.com/books/v3/invoices/${invoiceId}?organization_id=${ZOHO_ORGANIZATION_ID}`,
            data: invoiceData
        });

        console.log("Invoice updated successfully:", JSON.stringify(response, null, 2));
        return response.invoice;
    } catch (error) {
        console.error("Error updating invoice:", error.message);
        throw new Error("Failed to update invoice");
    }
}

// Webhook endpoint
app.post("/webhook", async (req, res) => {
    console.log("Webhook Payload:", JSON.stringify(req.body, null, 2));
    try {
        // Extract the first item from the payload
        const transaction = req.body.items[0];

        // Extract the transaction ID (used as reference number)
        const referenceNumber = transaction["Transaction ID"];

        // Step 1: Find an existing invoice
        console.log("Finding existing invoice...");
        const existingInvoice = await findExistingInvoice(referenceNumber);

        if (existingInvoice) {
            console.log("Existing Invoice Found:", JSON.stringify(existingInvoice, null, 2));

            // Step 2: Find the payment tied to the invoice (using the same reference number)
            console.log("Finding payment tied to the invoice...");
            let existingPayment;
            try {
                existingPayment = await findPaymentByReferenceNumber(referenceNumber);
            } catch (error) {
                console.error("Error finding payment by reference number:", error.message);
                existingPayment = null; // Assume no payment exists if there's an error
            }

            if (existingPayment) {
                console.log("Payment Tied to Invoice Found:", JSON.stringify(existingPayment, null, 2));

                // Step 3: Delete the payment
                console.log("Deleting payment...");
                try {
                    await deletePayment(existingPayment.payment_id);
                    console.log("Payment deleted successfully.");
                } catch (error) {
                    console.error("Error deleting payment:", error.message);
                    throw new Error("Failed to delete payment"); // Stop the script if payment deletion fails
                }
            } else {
                console.log("No payment tied to the invoice found.");
            }

            // Step 4: Update the invoice with the current payload data
            console.log("Updating invoice...");
            try {
                await updateInvoice(existingInvoice.invoice_id, transaction);
                console.log("Invoice updated successfully.");
            } catch (error) {
                console.error("Error updating invoice:", error.message);
                throw new Error("Failed to update invoice"); // Stop the script if invoice update fails
            }

            return res.status(200).json({ message: "Invoice and payment processed successfully." });
        } else {
            console.log("No existing invoice found. Stopping script.");
            return res.status(200).json({ message: "No existing invoice found. Script stopped." });
        }
    } catch (error) {
        console.error("Error processing webhook:", error);
        res.status(500).json({ message: "Error processing webhook", error: error.message });
    }
});

// Server setup
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
