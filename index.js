require("dotenv").config();
const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json());

// Zoho Credentials (loaded from environment variables)
const ZOHO_ACCESS_TOKEN = process.env.ZOHO_ACCESS_TOKEN;
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

        const newAccessToken = response.data.access_token;
        console.log("Zoho Access Token Refreshed:", newAccessToken);
        return newAccessToken;
    } catch (error) {
        console.error("Failed to refresh Zoho token:", error.response ? error.response.data : error.message);
        throw new Error("Zoho token refresh failed");
    }
}

// Function to create Sales Receipt in Zoho Books
async function createSalesReceipt(transaction) {
    try {
        console.log("Processing transaction:", transaction);

        // Extract fields from Baserow
        const {
            "Transaction ID": transactionId,
            "Patient Name": patientName,
            "Date": date,
            "Services": services,
            "Payable Amount": payableAmount,
            "Amount Paid (Cash)": cashAmount,
            "Bank Transfer": bankTransferAmount,
            "Cheque": chequeAmount,
            "POS": posAmount,
            "Total Amount Paid": totalAmountPaid,
            "Pending Amount": pendingAmount,
            "Balance Payment": balancePayment,
            "Balance Payment Mode": balancePaymentMode,
            "Balance Payment Date": balancePaymentDate
        } = transaction;

        // Construct Sales Receipt payload
        const salesReceiptData = {
            customer_name: patientName, // Map to Zoho Books customer
            date: date || new Date().toISOString().split("T")[0], // Use transaction date or today's date
            line_items: [
                {
                    description: services || "Medical Services", // Map to Zoho Books item description
                    rate: payableAmount, // Total payable amount
                    quantity: 1
                }
            ],
            payment_mode: "cash", // Default payment mode (can be updated dynamically)
            reference_number: transactionId, // Use Transaction ID as reference
            notes: `Transaction Details:
                    - Cash: ${cashAmount}
                    - Bank Transfer: ${bankTransferAmount}
                    - Cheque: ${chequeAmount}
                    - POS: ${posAmount}
                    - Total Paid: ${totalAmountPaid}
                    - Pending Amount: ${pendingAmount}
                    - Balance Payment: ${balancePayment}
                    - Balance Payment Mode: ${balancePaymentMode}
                    - Balance Payment Date: ${balancePaymentDate}`
        };

        // Send Sales Receipt request to Zoho Books
        const response = await axios.post(
            `https://books.zoho.com/api/v3/salesreceipts?organization_id=${ZOHO_ORGANIZATION_ID}`,
            salesReceiptData,
            {
                headers: {
                    Authorization: `Zoho-oauthtoken ${ZOHO_ACCESS_TOKEN}`,
                    "Content-Type": "application/json"
                }
            }
        );

        console.log("Sales Receipt Created in Zoho:", response.data);
        return response.data;
    } catch (error) {
        // If token expired, refresh and retry
        if (error.response && error.response.status === 401) {
            console.warn("Zoho Access Token Expired, refreshing...");
            const newAccessToken = await refreshZohoToken();
            process.env.ZOHO_ACCESS_TOKEN = newAccessToken; // Update the environment variable
            return createSalesReceipt(transaction); // Retry with new token
        }

        console.error("Error creating Sales Receipt in Zoho:", error.response ? error.response.data : error.message);
        throw new Error("Failed to create Sales Receipt");
    }
}

// Webhook endpoint for Baserow
app.post("/webhook", async (req, res) => {
    try {
        const transaction = req.body;
        const zohoResponse = await createSalesReceipt(transaction);
        res.status(200).json({ message: "Sales Receipt Created Successfully", data: zohoResponse });
    } catch (error) {
        res.status(500).json({ message: "Failed to process webhook", error: error.message });
    }
});

// Server setup
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
