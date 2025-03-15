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
            return response.customerpayments[0]; // Return the first matching payment
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

        // Extract the total payable amount and discount
        const payableAmount = parseFloat(transaction["Payable Amount"]) || 0;
        const discountAmount = parseFloat(transaction["Discount"]) || 0;

        const invoiceData = {
            customer_id: customerId, // Use customer_id instead of customer_name
            reference_number: transaction["Transaction ID"],
            date: transaction["Date"] || new Date().toISOString().split("T")[0],
            line_items: lineItems,
            total: payableAmount, // Set the total payable amount
            discount: discountAmount, // Apply the discount amount (absolute value)
            discount_type: "entity_level", // Apply discount at the invoice level
            is_discount_before_tax: true // Apply discount before tax
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

// Function to determine the payment mode based on the payload
function determinePaymentMode(transaction) {
    if (transaction["Amount Paid (Cash)"] && parseFloat(transaction["Amount Paid (Cash)"]) > 0) {
        return "Cash";
    } else if (transaction["Bank Transfer"] && parseFloat(transaction["Bank Transfer"]) > 0) {
        return "Bank Transfer";
    } else if (transaction["Cheque"] && parseFloat(transaction["Cheque"]) > 0) {
        return "Check";
    } else if (transaction["POS"] && parseFloat(transaction["POS"]) > 0) {
        return "POS";
    } else {
        return "Cash"; // Default to Cash if no payment mode is specified
    }
}

// Function to check if discount is applied in the invoice
async function isDiscountApplied(invoiceId, discountAmount) {
    try {
        const invoiceResponse = await makeZohoRequest({
            method: "get",
            url: `https://www.zohoapis.com/books/v3/invoices/${invoiceId}?organization_id=${ZOHO_ORGANIZATION_ID}`
        });

        const invoice = invoiceResponse.invoice;
        const appliedDiscount = parseFloat(invoice.discount) || 0;

        // Check if the discount in the invoice matches the discount in the payload
        return appliedDiscount === discountAmount;
    } catch (error) {
        console.error("Error checking discount in invoice:", error.message);
        throw new Error("Failed to check discount in invoice");
    }
}

// Function to apply discount to the invoice
async function applyDiscountToInvoice(invoiceId, discountAmount) {
    try {
        const invoiceResponse = await makeZohoRequest({
            method: "get",
            url: `https://www.zohoapis.com/books/v3/invoices/${invoiceId}?organization_id=${ZOHO_ORGANIZATION_ID}`
        });

        const invoice = invoiceResponse.invoice;

        // Update the invoice with the new discount
        const updatedInvoiceData = {
            discount: discountAmount,
            discount_type: "entity_level",
            is_discount_before_tax: true
        };

        const response = await makeZohoRequest({
            method: "put",
            url: `https://www.zohoapis.com/books/v3/invoices/${invoiceId}?organization_id=${ZOHO_ORGANIZATION_ID}`,
            data: updatedInvoiceData
        });

        console.log("Discount applied to invoice:", JSON.stringify(response, null, 2));
        return response.invoice;
    } catch (error) {
        console.error("Error applying discount to invoice:", error.message);
        throw new Error("Failed to apply discount to invoice");
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

        // Adjust the payment amount if it exceeds the invoice balance
        const paymentAmount = Math.min(amount, invoiceBalance);

        if (paymentAmount <= 0) {
            console.log("Invoice balance is zero or negative. Skipping payment creation.");
            return;
        }

        // Determine the payment mode based on the payload
        const paymentMode = determinePaymentMode(transaction);
        console.log("Payment Mode:", paymentMode);

        // Payment data with invoice application details
        const paymentData = {
            customer_id: customerId, // Required
            payment_mode: paymentMode, // Required
            amount: paymentAmount, // Required
            date: new Date().toISOString().split("T")[0], // Required
            reference_number: transactionId, // Use the Transaction ID as the Reference Number
            invoices: [
                {
                    invoice_id: invoiceId, // Required
                    amount_applied: paymentAmount // Required
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

            // Step 1: Check if the discount is applied
            const discountAmount = parseFloat(transaction["Discount"]) || 0;
            if (discountAmount > 0) {
                const isDiscountAlreadyApplied = await isDiscountApplied(existingInvoice.invoice_id, discountAmount);
                if (!isDiscountAlreadyApplied) {
                    console.log("Discount not applied. Applying discount to invoice...");
                    await applyDiscountToInvoice(existingInvoice.invoice_id, discountAmount);
                } else {
                    console.log("Discount already applied to invoice.");
                }
            }

            // Step 2: Find the payment tied to the invoice
            const existingPayment = await findPaymentByInvoiceId(existingInvoice.invoice_id, existingInvoice.customer_id);
            if (existingPayment) {
                // Step 3: Delete the existing payment
                await deletePayment(existingPayment.payment_id);
                console.log("Payment deleted successfully.");
            }

            // Step 4: Create a new payment for the updated invoice total
            const totalAmountPaid = parseFloat(transaction["Total Amount Paid"]) || 0;
            console.log("Total Amount Paid from Payload:", totalAmountPaid);

            await createPayment(existingInvoice.invoice_id, totalAmountPaid, transactionId, transaction);
            console.log("New payment created and applied successfully.");
        } else {
            console.log("No existing invoice found. Creating a new one...");
            const newInvoice = await createInvoice(transaction);

            // Record payment only if Total Amount Paid is greater than 0
            const totalAmountPaid = parseFloat(transaction["Total Amount Paid"]) || 0;
            if (totalAmountPaid > 0) {
                await createPayment(newInvoice.invoice_id, totalAmountPaid, transactionId, transaction);
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
