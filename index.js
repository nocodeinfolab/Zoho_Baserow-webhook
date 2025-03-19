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
            await refreshZohoToken();
            return makeZohoRequest(config, false);
        } else {
            console.error("API request failed:", error.response ? error.response.data : error.message);
            throw new Error("API request failed");
        }
    }
}

// Function to find an existing invoice
async function findExistingInvoice(transactionId) {
    try {
        const response = await makeZohoRequest({
            method: "get",
            url: `https://www.zohoapis.com/books/v3/invoices?organization_id=${ZOHO_ORGANIZATION_ID}&reference_number=${transactionId}`
        });
        const matchingInvoices = response.invoices.filter(invoice => invoice.reference_number === transactionId);
        return matchingInvoices.length > 0 ? matchingInvoices[0] : null;
    } catch (error) {
        console.error("Error finding invoice:", error.message);
        return null;
    }
}

// Function to find a payment by invoice ID and customer ID
async function findPaymentByInvoiceId(invoiceId, customerId) {
    try {
        const response = await makeZohoRequest({
            method: "get",
            url: `https://www.zohoapis.com/books/v3/customerpayments?organization_id=${ZOHO_ORGANIZATION_ID}&invoice_id=${invoiceId}&customer_id=${customerId}`
        });
        if (response.customerpayments && response.customerpayments.length > 0) {
            const matchingPayment = response.customerpayments.find(payment => 
                payment.invoices && payment.invoices.some(inv => inv.invoice_id === invoiceId)
            );
            return matchingPayment || null;
        }
        return null;
    } catch (error) {
        console.error("Error finding payment by invoice ID:", error.message);
        throw new Error("Failed to find payment by invoice ID");
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
        const lineItems = (transaction["Services (link)"] || []).map((service, index) => ({
            description: service.value || "Service",
            rate: parseFloat(transaction["Prices"][index]?.value) || 0,
            quantity: 1
        }));

        const invoiceData = {
            line_items: lineItems,
            total: parseFloat(transaction["Payable Amount"]) || 0,
            discount: parseFloat(transaction["Discount"]) || 0,
            discount_type: "entity_level",
            is_discount_before_tax: true,
            reason: "Updating invoice due to payment adjustment"
        };

        const response = await makeZohoRequest({
            method: "put",
            url: `https://www.zohoapis.com/books/v3/invoices/${invoiceId}?organization_id=${ZOHO_ORGANIZATION_ID}`,
            data: invoiceData
        });
        console.log("Invoice updated successfully");
        return response.invoice;
    } catch (error) {
        console.error("Error updating invoice:", error.message);
        throw new Error("Failed to update invoice");
    }
}

// Webhook endpoint
app.post("/webhook", async (req, res) => {
    try {
        const transaction = req.body.items[0];
        const transactionId = transaction["Transaction ID"];
        const existingInvoice = await findExistingInvoice(transactionId);

        if (existingInvoice) {
            const existingPayment = await findPaymentByInvoiceId(existingInvoice.invoice_id, existingInvoice.customer_id);
            if (existingPayment) {
                await deletePayment(existingPayment.payment_id);
            }
            await updateInvoice(existingInvoice.invoice_id, transaction);
            return res.status(200).json({ message: "Invoice processed successfully." });
        } else {
            return res.status(200).json({ message: "No existing invoice found." });
        }
    } catch (error) {
        console.error("Error processing webhook:", error);
        res.status(500).json({ message: "Error processing webhook", error: error.message });
    }
});

// Server setup
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
