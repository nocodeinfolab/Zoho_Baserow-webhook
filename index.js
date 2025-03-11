const axios = require("axios");
const BASEROW_API_URL = "https://api.baserow.io/api/database/rows/table/";
const BASEROW_TABLE_ID = "YOUR_BASEROW_TABLE_ID"; // Replace with your actual Baserow table ID
const BASEROW_API_TOKEN = "YOUR_BASEROW_API_TOKEN"; // Replace with your Baserow API token
const ZOHO_ORGANIZATION_ID = "YOUR_ZOHO_ORG_ID"; // Replace with your Zoho organization ID
const ZOHO_ACCESS_TOKEN = "YOUR_ZOHO_ACCESS_TOKEN"; // Replace with your Zoho access token

async function fetchTransactions() {
    try {
        const response = await axios.get(`${BASEROW_API_URL}${BASEROW_TABLE_ID}/?user_field_names=true`, {
            headers: { Authorization: `Token ${BASEROW_API_TOKEN}` }
        });
        return response.data.results;
    } catch (error) {
        console.error("Error fetching transactions:", error);
        return [];
    }
}

async function findOrCreateCustomer(customerName) {
    try {
        console.log("Searching for customer:", customerName);
        
        const searchResponse = await axios.get(
            `https://www.zohoapis.com/books/v3/contacts?organization_id=${ZOHO_ORGANIZATION_ID}&search_text=${encodeURIComponent(customerName)}`,
            { headers: { Authorization: `Zoho-oauthtoken ${ZOHO_ACCESS_TOKEN}` } }
        );
        
        if (searchResponse.data.contacts.length > 0) {
            console.log("Customer found:", searchResponse.data.contacts[0].contact_id);
            return searchResponse.data.contacts[0].contact_id;
        }
        
        console.log("Customer not found, creating new customer...");
        
        const createResponse = await axios.post(
            `https://www.zohoapis.com/books/v3/contacts?organization_id=${ZOHO_ORGANIZATION_ID}`,
            {
                contact_name: customerName,
                contact_type: "customer",
                company_name: customerName,
                billing_address: { attention: customerName }
            },
            { headers: { Authorization: `Zoho-oauthtoken ${ZOHO_ACCESS_TOKEN}` } }
        );
        
        console.log("New customer created:", createResponse.data.contact.contact_id);
        return createResponse.data.contact.contact_id;
    } catch (error) {
        console.error("Error in findOrCreateCustomer:", error.response ? error.response.data : error.message);
        return null;
    }
}

async function createInvoice(transaction) {
    const customerName = transaction["Patient Name ParameterID"] || "Unknown Customer";
    const customerId = await findOrCreateCustomer(customerName);
    if (!customerId) return;

    try {
        console.log("Creating invoice for customer ID:", customerId);
        
        const invoiceResponse = await axios.post(
            `https://www.zohoapis.com/books/v3/invoices?organization_id=${ZOHO_ORGANIZATION_ID}`,
            {
                customer_id: customerId,
                line_items: [
                    {
                        item_name: "Medical Services",
                        rate: transaction["Amount Paid (cash + bank transfer)"] || 0,
                        quantity: 1
                    }
                ],
                total: transaction["Amount Paid (cash + bank transfer)"] || 0
            },
            { headers: { Authorization: `Zoho-oauthtoken ${ZOHO_ACCESS_TOKEN}` } }
        );
        
        console.log("Invoice created successfully:", invoiceResponse.data.invoice.invoice_id);
    } catch (error) {
        console.error("Error creating invoice:", error.response ? error.response.data : error.message);
    }
}

async function processTransactions() {
    const transactions = await fetchTransactions();
    for (const transaction of transactions) {
        await createInvoice(transaction);
    }
}

processTransactions();
