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
        ZOHO_ACCESS_TOKEN = response.data.access_token; // Update the global access token
        console.log("Zoho Access Token Refreshed:", ZOHO_ACCESS_TOKEN);
    } catch (error) {
        console.error("Failed to refresh Zoho token:", error.response ? error.response.data : error.message);
        throw new Error("Failed to refresh Zoho token");
    }
}

// Function to make API requests with token expiration handling
async function makeZohoRequest(config, retry = true) {
    try {
        // Add authorization header to the request
        config.headers = {
            ...config.headers,
            Authorization: `Zoho-oauthtoken ${ZOHO_ACCESS_TOKEN}`
        };

        const response = await axios(config);
        return response.data;
    } catch (error) {
        const isTokenExpired =
            (error.response && error.response.status === 401) || // 401 Unauthorized
            (error.response && error.response.data && error.response.data.code === 57); // Zoho-specific code: 57

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

// Function to update an invoice
async function updateInvoice(invoiceId, invoiceData) {
    try {
        // Add a reason for updating the invoice
        invoiceData.reason = "Correction to invoice details"; // Customize this reason as needed

        const response = await makeZohoRequest({
            method: "put",
            url: `https://www.zohoapis.com/books/v3/invoices/${invoiceId}?organization_id=${ZOHO_ORGANIZATION_ID}`,
            headers: { "content-type": "application/json" },
            data: invoiceData
        });
        console.log("Invoice updated successfully:", JSON.stringify(response, null, 2));
        return response.invoice;
    } catch (error) {
        console.error("Error updating invoice:", error.message);
        throw new Error("Failed to update invoice");
    }
}

// Function to find an existing invoice
async function findExistingInvoice(transactionId) {
    try {
        const response = await makeZohoRequest({
            method: "get",
            url: `https://www.zohoapis.com/books/v3/invoices?organization_id=${ZOHO_ORGANIZATION_ID}&reference_number=${transactionId}`
        });
        console.log("Zoho API Response for Find Invoice:", JSON.stringify(response, null, 2)); // Log the response

        // Filter invoices by reference_number
        const matchingInvoices = response.invoices.filter(
            invoice => invoice.reference_number === transactionId
        );

        if (matchingInvoices.length > 0) {
            return matchingInvoices[0];
        }
        return null;
    } catch (error) {
        console.error("Error finding invoice:", error.message);
        return null;
    }
}

// Function to find or create a customer in Zoho Books
async function findOrCreateCustomer(customerName) {
    try {
        // Search for the customer in Zoho Books
        const searchResponse = await makeZohoRequest({
            method: "get",
            url: `https://www.zohoapis.com/books/v3/contacts?organization_id=${ZOHO_ORGANIZATION_ID}&contact_name=${encodeURIComponent(customerName)}`
        });

        if (searchResponse.contacts && searchResponse.contacts.length > 0) {
            // Customer exists, return the first match
            return searchResponse.contacts[0].contact_id;
        } else {
            // Customer does not exist, create a new one
            const createResponse = await makeZohoRequest({
                method: "post",
                url: `https://www.zohoapis.com/books/v3/contacts?organization_id=${ZOHO_ORGANIZATION_ID}`,
                data: { contact_name: customerName }
            });
            return createResponse.contact.contact_id;
        }
    } catch (error) {
        console.error("Error finding or creating customer:", error.message);
        throw new Error("Failed to find or create customer");
    }
}

// Function to create an invoice
async function createInvoice(transaction) {
    try {
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

        const response = await makeZohoRequest({
            method: "post",
            url: `https://www.zohoapis.com/books/v3/invoices?organization_id=${ZOHO_ORGANIZATION_ID}`,
            data: invoiceData
        });
        console.log("Zoho API Response for Create Invoice:", JSON.stringify(response, null, 2)); // Log the response
        return response.invoice;
    } catch (error) {
        console.error("Zoho API Error:", error.message);
        throw new Error("Failed to create invoice");
    }
}

// Function to create a payment and tie it to the invoice
async function createPayment(invoiceId, amount, mode) {
    try {
        // Fetch the invoice to verify the customer_id and balance
        const invoiceResponse = await makeZohoRequest({
            method: "get",
            url: `https://www.zohoapis.com/books/v3/invoices/${invoiceId}?organization_id=${ZOHO_ORGANIZATION_ID}`
        });
        console.log("Invoice Details:", JSON.stringify(invoiceResponse, null, 2)); // Log the invoice details

        const customerId = invoiceResponse.invoice.customer_id;
        const invoiceBalance = parseFloat(invoiceResponse.invoice.balance) || 0;
        console.log("Customer ID in Invoice:", customerId);
        console.log("Invoice Balance:", invoiceBalance);

        // Adjust the payment amount if it exceeds the invoice balance
        const paymentAmount = Math.min(amount, invoiceBalance);

        if (paymentAmount <= 0) {
            console.log("Invoice balance is zero or negative. Skipping payment creation.");
            return;
        }

        // Payment data with invoice application details
        const paymentData = {
            customer_id: customerId, // Ensure the customer_id is included
            payment_mode: mode,
            amount: paymentAmount,
            date: new Date().toISOString().split("T")[0],
            invoices: [
                {
                    invoice_id: invoiceId,
                    amount_applied: paymentAmount // Apply the payment amount to this invoice
                }
            ]
        };

        console.log("Payment Data:", JSON.stringify(paymentData, null, 2)); // Log the payment data

        const paymentResponse = await makeZohoRequest({
            method: "post",
            url: `https://www.zohoapis.com/books/v3/customerpayments?organization_id=${ZOHO_ORGANIZATION_ID}`,
            data: paymentData
        });
        console.log("Payment created and applied successfully:", JSON.stringify(paymentResponse, null, 2)); // Log the payment response

        // Handle overpayment (if any)
        const overpaymentAmount = amount - paymentAmount;
        if (overpaymentAmount > 0) {
            console.log(`Overpayment detected: ${overpaymentAmount}. Creating a credit note...`);

            const creditNoteData = {
                customer_id: customerId,
                reference_number: `Overpayment for Invoice ${invoiceResponse.invoice.invoice_number}`,
                date: new Date().toISOString().split("T")[0],
                line_items: [
                    {
                        description: "Overpayment Credit",
                        rate: overpaymentAmount,
                        quantity: 1
                    }
                ]
            };

            const creditNoteResponse = await makeZohoRequest({
                method: "post",
                url: `https://www.zohoapis.com/books/v3/creditnotes?organization_id=${ZOHO_ORGANIZATION_ID}`,
                data: creditNoteData
            });
            console.log("Credit Note Created:", JSON.stringify(creditNoteResponse, null, 2));
        }
    } catch (error) {
        console.error("Error creating payment:", error.message);
        throw new Error("Failed to create payment");
    }
}

// Function to update a payment
async function updatePayment(invoiceId, amount) {
    try {
        // Fetch the invoice to verify the customer_id and balance
        const invoiceResponse = await makeZohoRequest({
            method: "get",
            url: `https://www.zohoapis.com/books/v3/invoices/${invoiceId}?organization_id=${ZOHO_ORGANIZATION_ID}`
        });
        console.log("Invoice Details:", JSON.stringify(invoiceResponse, null, 2)); // Log the invoice details

        const customerId = invoiceResponse.invoice.customer_id;
        const invoiceBalance = parseFloat(invoiceResponse.invoice.balance) || 0;
        console.log("Customer ID in Invoice:", customerId);
        console.log("Invoice Balance:", invoiceBalance);

        // Payment data with invoice application details
        const paymentData = {
            customer_id: customerId,
            payment_mode: "cash",
            amount: amount,
            date: new Date().toISOString().split("T")[0],
            invoices: [
                {
                    invoice_id: invoiceId,
                    amount_applied: 0 // Clear the applied amount
                }
            ]
        };

        console.log("Payment Data:", JSON.stringify(paymentData, null, 2)); // Log the payment data

        const paymentResponse = await makeZohoRequest({
            method: "post",
            url: `https://www.zohoapis.com/books/v3/customerpayments?organization_id=${ZOHO_ORGANIZATION_ID}`,
            data: paymentData
        });
        console.log("Payment updated successfully:", JSON.stringify(paymentResponse, null, 2)); // Log the payment response

        return paymentResponse;
    } catch (error) {
        console.error("Error updating payment:", error.message);
        throw new Error("Failed to update payment");
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

            // Step 1: Update the payment
            const totalAmountPaid = parseFloat(transaction["Total Amount Paid"]) || 0;
            if (totalAmountPaid > 0) {
                await updatePayment(existingInvoice.invoice_id, totalAmountPaid);
            } else {
                console.log("Total Amount Paid is zero. Skipping payment update.");
            }

            // Step 2: Update the invoice
            const services = transaction["Services"] || [];
            const prices = transaction["Prices"] || [];
            const newLineItems = services.map((service, index) => ({
                description: service.value || "Service",
                rate: parseFloat(prices[index]?.value) || 0,
                quantity: 1
            }));

            // Extract the total payable amount
            const payableAmount = parseFloat(transaction["Payable Amount"]) || 0;

            // Prepare the updated invoice data
            const updatedInvoiceData = {
                customer_id: existingInvoice.customer_id,
                reference_number: transactionId,
                date: transaction["Date"] || new Date().toISOString().split("T")[0],
                line_items: newLineItems,
                total: payableAmount,
                reason: "Correction to invoice details" // Add a reason for the update
            };

            // Update the existing invoice
            await updateInvoice(existingInvoice.invoice_id, updatedInvoiceData);
        } else {
            console.log("No existing invoice found. Creating a new one...");
            const newInvoice = await createInvoice(transaction);

            // Record payment only if Total Amount Paid is greater than 0
            const totalAmountPaid = parseFloat(transaction["Total Amount Paid"]) || 0;
            if (totalAmountPaid > 0) {
                await createPayment(newInvoice.invoice_id, totalAmountPaid, "cash");
            } else {
                console.log("Total Amount Paid is zero. Skipping payment creation.");
            }
        }

        res.status(200).json({ message: "Invoice processed successfully" });
    } catch (error) {
        console.error("Error details:", error);
        res.status(500).json({ message: "Error processing webhook", error: error.message });
    }
});

// Server setup
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
