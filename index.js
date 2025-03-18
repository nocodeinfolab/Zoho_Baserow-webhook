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

// Function to find a payment by invoice ID and customer ID
async function findPaymentByInvoiceId(invoiceId, customerId) {
    try {
        const response = await makeZohoRequest({
            method: "get",
            url: `https://www.zohoapis.com/books/v3/customerpayments?organization_id=${ZOHO_ORGANIZATION_ID}&invoice_id=${invoiceId}&customer_id=${customerId}`
        });

        if (response.customerpayments && response.customerpayments.length > 0) {
            // Ensure the payment is tied to the correct invoice
            const matchingPayment = response.customerpayments.find(
                payment => {
                    // Check if the payment has an `invoices` array
                    if (payment.invoices && Array.isArray(payment.invoices)) {
                        return payment.invoices.some(inv => inv.invoice_id === invoiceId);
                    }
                    return false; // Skip payments without an `invoices` array
                }
            );

            if (matchingPayment) {
                return matchingPayment; // Return the matching payment
            }
        }
        return null; // No payment found
    } catch (error) {
        console.error("Error finding payment by invoice ID:", error.message);
        throw new Error("Failed to find payment by invoice ID");
    }
}

// Function to delete a payment
async function deletePayment(paymentId) {
    try {
        const response = await makeZohoRequest({
            method: "delete",
            url: `https://www.zohoapis.com/books/v3/customerpayments/${paymentId}?organization_id=${ZOHO_ORGANIZATION_ID}`
        });
        console.log("Payment deleted successfully:", JSON.stringify(response, null, 2)); // Log the response
        return response;
    } catch (error) {
        console.error("Error deleting payment:", error.response ? error.response.data : error.message);
        throw new Error("Failed to delete payment");
    }
}

// Function to update an invoice
async function updateInvoice(invoiceId, transaction) {
    try {
        // Extract services and prices
        const services = transaction["Services (link)"] || [];
        const prices = transaction["Prices"] || [];
        const lineItems = services.map((service, index) => ({
            description: service.value || "Service",
            rate: parseFloat(prices[index]?.value) || 0,
            quantity: 1
        }));

        // Extract the total payable amount and discount
        const payableAmount = parseFloat(transaction["Payable Amount"]) || 0;
        const discountAmount = parseFloat(transaction["Discount"]) || 0;

        // Invoice data with a reason for updating a sent invoice
        const invoiceData = {
            line_items: lineItems,
            total: payableAmount, // Set the total payable amount
            discount: discountAmount, // Apply the discount amount (absolute value)
            discount_type: "entity_level", // Apply discount at the invoice level
            is_discount_before_tax: true, // Apply discount before tax
            reason: "Updating invoice due to payment adjustment" // Mandatory reason for updating a sent invoice
        };

        console.log("Updating Invoice Data:", JSON.stringify(invoiceData, null, 2)); // Log the invoice data

        const response = await makeZohoRequest({
            method: "put",
            url: `https://www.zohoapis.com/books/v3/invoices/${invoiceId}?organization_id=${ZOHO_ORGANIZATION_ID}`,
            data: invoiceData
        });
        console.log("Invoice updated successfully:", JSON.stringify(response, null, 2)); // Log the response
        return response.invoice;
    } catch (error) {
        console.error("Error updating invoice:", error.message);
        throw new Error("Failed to update invoice");
    }
}

// Function to create a payment and tie it to the invoice
async function createPayment(invoiceId, amount, transactionId, transaction) {
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

        // Stop if the payment amount exceeds the invoice balance
        if (amount > invoiceBalance) {
            console.log("Payment amount exceeds the invoice balance. Stopping payment creation.");
            return { success: false, message: "Payment amount exceeds the invoice balance. Process stopped." };
        }

        // Determine the payment mode based on the payload
        const paymentMode = determinePaymentMode(transaction);
        console.log("Payment Mode:", paymentMode);

        // Payment data with invoice application details
        const paymentData = {
            customer_id: customerId, // Required
            payment_mode: paymentMode, // Required
            amount: amount, // Use the full payment amount
            date: new Date().toISOString().split("T")[0], // Required
            reference_number: transactionId, // Use the Transaction ID as the Reference Number
            invoices: [
                {
                    invoice_id: invoiceId, // Required
                    amount_applied: amount // Required
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

        return paymentResponse;
    } catch (error) {
        console.error("Error creating payment:", error.message);
        throw new Error("Failed to create payment");
    }
}

// Function to determine the payment mode based on the payload
function determinePaymentMode(transaction) {
    if (transaction["Amount Paid (Cash)"] && parseFloat(transaction["Amount Paid (Cash)"]) > 0) {
        return "Cash";
    } else if (transaction["Bank Transfer"] && parseFloat(transaction["Bank Transfer"]) > 0) {
        return "Bank Transfer";
    } else if (transaction["Cheque"] && parseFloat(transaction["Cheque"]) > 0) {
        return "Check";
    } else if (transaction["POS Payment"] && parseFloat(transaction["POS"]) > 0) {
        return "POS";
    } else {
        return "Cash"; // Default to Cash if no payment mode is specified
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

            // Step 1: Check if there is a payment tied to the invoice
            let existingPayment;
            try {
                existingPayment = await findPaymentByInvoiceId(existingInvoice.invoice_id, existingInvoice.customer_id);
            } catch (error) {
                console.error("Error finding payment by invoice ID:", error.message);
                existingPayment = null; // Assume no payment exists if there's an error
            }

            if (existingPayment) {
                console.log("Payment tied to the invoice found. Deleting payment...");
                try {
                    await deletePayment(existingPayment.payment_id);
                } catch (error) {
                    console.error("Error deleting payment:", error.message);
                    console.log("Skipping payment deletion and proceeding with invoice update.");
                }
            } else {
                console.log("No payment tied to the invoice found.");
            }

            // Step 2: Update the invoice with the current payload data
            console.log("Updating invoice...");
            await updateInvoice(existingInvoice.invoice_id, transaction);

            // Step 3: Check if "Total Amount Paid" is greater than 0
            const totalAmountPaid = parseFloat(transaction["Total Amount Paid"]) || 0;
            if (totalAmountPaid > 0) {
                // Step 4: Create a new payment for the invoice
                console.log("Creating new payment...");
                const paymentResult = await createPayment(existingInvoice.invoice_id, totalAmountPaid, transactionId, transaction);
                if (paymentResult.success === false) {
                    // If payment creation failed due to overpayment, return an error response
                    return res.status(400).json({ message: paymentResult.message });
                }
            } else {
                console.log("Total Amount Paid is zero. Skipping payment creation.");
            }

            console.log("Invoice and payment processed successfully.");
            return res.status(200).json({ message: "Invoice and payment processed successfully." });
        } else {
            console.log("No existing invoice found. Stopping script.");
            return res.status(200).json({ message: "No existing invoice found. Script stopped." });
        }
    } catch (error) {
        console.error("Error details:", error);
        res.status(500).json({ message: "Error processing webhook", error: error.message });
    }
});

// Server setup
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
