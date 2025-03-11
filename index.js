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

// Function to delete a payment
async function deletePayment(paymentId) {
    try {
        const response = await makeZohoRequest({
            method: "delete",
            url: `https://www.zohoapis.com/books/v3/customerpayments/${paymentId}?organization_id=${ZOHO_ORGANIZATION_ID}`
        });
        console.log("Payment deleted successfully:", JSON.stringify(response, null, 2));
    } catch (error) {
        console.error("Error deleting payment:", error.message);
        throw new Error("Failed to delete payment");
    }
}

// Function to delete payments associated with an invoice
async function deletePaymentsForInvoice(invoiceId) {
    try {
        // Fetch all payments in the organization
        const paymentsResponse = await makeZohoRequest({
            method: "get",
            url: `https://www.zohoapis.com/books/v3/customerpayments?organization_id=${ZOHO_ORGANIZATION_ID}`
        });

        if (paymentsResponse.customerpayments && paymentsResponse.customerpayments.length > 0) {
            // Filter payments to find those associated with the specific invoice
            const paymentsForInvoice = paymentsResponse.customerpayments.filter(payment =>
                payment.invoices.some(invoice => invoice.invoice_id === invoiceId)
            );

            if (paymentsForInvoice.length > 0) {
                // Delete each payment associated with the invoice
                for (const payment of paymentsForInvoice) {
                    await deletePayment(payment.payment_id);
                    console.log(`Payment ${payment.payment_id} deleted for invoice ${invoiceId}.`);
                }
            } else {
                console.log("No payments found for the invoice.");
            }
        } else {
            console.log("No payments found in the organization.");
        }
    } catch (error) {
        console.error("Error deleting payments for invoice:", error.message);
        throw new Error("Failed to delete payments for invoice");
    }
}

// Function to void an invoice
async function voidInvoice(invoiceId) {
    try {
        // Validate invoiceId
        if (!invoiceId) {
            throw new Error("Invoice ID is missing or invalid.");
        }

        const response = await makeZohoRequest({
            method: "post",
            url: `https://www.zohoapis.com/books/v3/invoices/${invoiceId}/status/void?organization_id=${ZOHO_ORGANIZATION_ID}`,
            data: null
        });
        console.log("Invoice voided successfully:", JSON.stringify(response, null, 2));
    } catch (error) {
        console.error("Error voiding invoice:", error.message);
        throw new Error("Failed to void invoice");
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

// Function to record a payment and apply it to the invoice
async function recordPayment(invoiceId, amount, mode) {
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
                    amount_applied: paymentAmount // Apply the adjusted payment amount to this invoice
                }
            ]
        };

        console.log("Payment Data:", JSON.stringify(paymentData, null, 2)); // Log the payment data

        const paymentResponse = await makeZohoRequest({
            method: "post",
            url: `https://www.zohoapis.com/books/v3/customerpayments?organization_id=${ZOHO_ORGANIZATION_ID}`,
            data: paymentData
        });
        console.log("Payment recorded and applied successfully:", JSON.stringify(paymentResponse, null, 2)); // Log the payment response

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
        console.error("Error recording payment:", error.message);
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

                try {
                    // Delete payments associated with the invoice
                    await deletePaymentsForInvoice(existingInvoice.invoice_id);

                    // Void the existing invoice
                    await voidInvoice(existingInvoice.invoice_id);
                } catch (error) {
                    console.error("Failed to void invoice. Stopping process to avoid duplicates:", error.message);
                    throw new Error("Failed to void invoice. Stopping process to avoid duplicates.");
                }

                // Create a new invoice
                const newInvoice = await createInvoice(transaction);

                // Record payment only if Total Amount Paid is greater than 0
                const totalAmountPaid = parseFloat(transaction["Total Amount Paid"]) || 0;
                if (totalAmountPaid > 0) {
                    await recordPayment(newInvoice.invoice_id, totalAmountPaid, "cash");
                } else {
                    console.log("Total Amount Paid is zero. Skipping payment creation.");
                }
            } else {
                // Compare existing invoice details with new transaction data
                const existingServices = existingInvoice.line_items.map(item => item.description);
                const newServices = transaction["Services"]?.map(service => service.value) || [];

                const existingTotal = existingInvoice.line_items.reduce((sum, item) => sum + item.rate, 0);
                const newTotal = parseFloat(transaction["Payable Amount"]) || 0;

                if (JSON.stringify(existingServices) !== JSON.stringify(newServices) ||
                    existingTotal !== newTotal) {
                    console.log("Invoice details changed. Voiding old invoice and creating a new one...");

                    try {
                        // Delete payments associated with the invoice
                        await deletePaymentsForInvoice(existingInvoice.invoice_id);

                        // Void the existing invoice
                        await voidInvoice(existingInvoice.invoice_id);
                    } catch (error) {
                        console.error("Failed to void invoice. Stopping process to avoid duplicates:", error.message);
                        throw new Error("Failed to void invoice. Stopping process to avoid duplicates.");
                    }

                    // Create a new invoice
                    const newInvoice = await createInvoice(transaction);

                    // Record payment only if Total Amount Paid is greater than 0
                    const totalAmountPaid = parseFloat(transaction["Total Amount Paid"]) || 0;
                    if (totalAmountPaid > 0) {
                        await recordPayment(newInvoice.invoice_id, totalAmountPaid, "cash");
                    } else {
                        console.log("Total Amount Paid is zero. Skipping payment creation.");
                    }
                } else {
                    console.log("No changes detected. Skipping invoice update.");
                }
            }
        } else {
            console.log("No existing invoice found. Creating a new one...");
            const newInvoice = await createInvoice(transaction);

            // Record payment only if Total Amount Paid is greater than 0
            const totalAmountPaid = parseFloat(transaction["Total Amount Paid"]) || 0;
            if (totalAmountPaid > 0) {
                await recordPayment(newInvoice.invoice_id, totalAmountPaid, "cash");
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
