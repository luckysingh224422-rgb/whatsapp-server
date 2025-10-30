// index.js (fixed with proper alphanumeric WhatsApp pairing code)
const express = require("express");
const fs = require("fs");
const path = require("path");
const pino = require("pino");
const multer = require("multer");
const {
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    fetchLatestBaileysVersion,
    makeWASocket,
    isJidBroadcast
} = require("@whiskeysockets/baileys");

const app = express();
const PORT = process.env.PORT || 21129;

if (!fs.existsSync("temp")) fs.mkdirSync("temp");
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");

const upload = multer({ dest: "uploads/" });
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --- SESSION MANAGEMENT ---
const activeClients = new Map(); // sessionId → { client, number, authPath, pairingCode, ownerId, isConnecting }
const activeTasks = new Map();   // taskId → taskInfo

function safeDeleteFile(p) {
    try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { }
}

// Generate alphanumeric display code
function generateDisplayCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

app.get("/status", (req, res) => {
    const ownerId = req.query.ownerId;
    const sessions = [...activeClients.entries()]
        .filter(([_, info]) => !ownerId || info.ownerId === ownerId)
        .map(([id, info]) => ({
            sessionId: id,
            number: info.number,
            registered: info.registered,
            pairingCode: info.pairingCode || "WAITING...",
            isConnecting: info.isConnecting || false
        }));

    res.json({
        activeSessions: sessions,
        activeTasks: [...activeTasks.entries()]
            .filter(([_, task]) => !ownerId || task.ownerId === ownerId).length
    });
});

// --- PAIR NEW NUMBER ---
app.get("/code", async (req, res) => {
    const num = req.query.number?.replace(/[^0-9]/g, "");
    const ownerId = req.query.ownerId || "defaultUser";
    if (!num) return res.status(400).json({ error: "Invalid number" });

    const sessionId = `session_${num}_${ownerId}`;
    const sessionPath = path.join("temp", sessionId);
    
    // Check if session already exists
    const existingSession = activeClients.get(sessionId);
    if (existingSession) {
        if (existingSession.isConnecting) {
            return res.status(400).json({ error: "Session is already being set up. Please wait." });
        }
        if (existingSession.registered) {
            return res.json({ 
                pairingCode: existingSession.pairingCode || "CONNECTED",
                waCode: "ALREADY_CONNECTED", 
                sessionId: sessionId,
                status: "already-registered",
                message: "Session already registered and ready to use"
            });
        }
    }

    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();

        // If already registered, return success
        if (state.creds?.registered) {
            const displayCode = generateDisplayCode();
            const sessionInfo = {
                client: null,
                number: num,
                authPath: sessionPath,
                registered: true,
                pairingCode: displayCode,
                ownerId,
                isConnecting: false
            };
            
            activeClients.set(sessionId, sessionInfo);
            
            return res.json({ 
                pairingCode: displayCode,
                waCode: "ALREADY_REGISTERED", 
                sessionId: sessionId,
                status: "already-registered",
                message: "Session already registered and ready to use"
            });
        }

        const waClient = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }))
            },
            printQRInTerminal: true,
            logger: pino({ level: "silent" }),
            browser: Browsers.ubuntu('Chrome'),
            syncFullHistory: false,
            shouldIgnoreJid: jid => isJidBroadcast(jid),
            markOnlineOnConnect: true,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
        });

        const displayCode = generateDisplayCode();
        const sessionInfo = {
            client: waClient,
            number: num,
            authPath: sessionPath,
            registered: false,
            pairingCode: displayCode,
            ownerId,
            isConnecting: true,
            reconnectAttempts: 0,
            maxReconnectAttempts: 3
        };

        activeClients.set(sessionId, sessionInfo);

        let connectionTimeout;
        let isResolved = false;

        const resolveRequest = (data) => {
            if (isResolved) return;
            isResolved = true;
            clearTimeout(connectionTimeout);
            sessionInfo.isConnecting = false;
            res.json(data);
        };

        const rejectRequest = (error) => {
            if (isResolved) return;
            isResolved = true;
            clearTimeout(connectionTimeout);
            sessionInfo.isConnecting = false;
            res.status(500).json({ error });
        };

        // Set timeout for connection (2 minutes)
        connectionTimeout = setTimeout(() => {
            if (!isResolved) {
                console.log(`⏰ Connection timeout for ${sessionId}`);
                rejectRequest("Connection timeout. Please try again.");
            }
        }, 120000);

        waClient.ev.on("creds.update", saveCreds);
        
        waClient.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            console.log(`🔗 Connection update for ${sessionId}: ${connection}`);
            
            if (connection === "open") {
                console.log(`✅ WhatsApp Connected for ${num}! (Session: ${sessionId})`);
                sessionInfo.registered = true;
                sessionInfo.isConnecting = false;
                sessionInfo.reconnectAttempts = 0;
                
                if (!isResolved) {
                    resolveRequest({ 
                        pairingCode: sessionInfo.pairingCode,
                        waCode: "CONNECTED",
                        sessionId: sessionId,
                        status: "connected",
                        message: "WhatsApp connected successfully!"
                    });
                }
            } 
            else if (connection === "close") {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`❌ Connection closed for ${sessionId}, status: ${statusCode}`);
                
                if (statusCode === 401) {
                    console.log(`🚫 Auth error for ${sessionId}`);
                    sessionInfo.registered = false;
                    sessionInfo.isConnecting = false;
                    if (!isResolved) {
                        rejectRequest("Authentication failed. Please pair again.");
                    }
                } else {
                    sessionInfo.reconnectAttempts++;
                    if (sessionInfo.reconnectAttempts <= sessionInfo.maxReconnectAttempts) {
                        console.log(`🔄 Reconnection attempt ${sessionInfo.reconnectAttempts} for ${sessionId} in 5s...`);
                        setTimeout(() => {
                            if (activeClients.has(sessionId)) {
                                initializeClient(sessionId, sessionInfo);
                            }
                        }, 5000);
                    } else {
                        console.log(`🚫 Max reconnection attempts reached for ${sessionId}`);
                        sessionInfo.isConnecting = false;
                        if (!isResolved) {
                            rejectRequest("Max reconnection attempts reached. Please try again.");
                        }
                    }
                }
            }
            
            // Handle QR code - this is where we get the actual WhatsApp pairing code
            if (qr && !isResolved) {
                console.log(`📱 QR code received for ${sessionId}`);
                
                // Try multiple methods to get pairing code
                let actualPairingCode = null;
                
                // Method 1: Try requestPairingCode API
                try {
                    console.log(`🔄 Attempting to get pairing code via API...`);
                    actualPairingCode = await waClient.requestPairingCode(num);
                    if (actualPairingCode) {
                        console.log(`✅ Got pairing code via API: ${actualPairingCode}`);
                    }
                } catch (apiError) {
                    console.log(`❌ API method failed:`, apiError.message);
                }
                
                // Method 2: Extract from QR code if API fails
                if (!actualPairingCode && qr) {
                    try {
                        // WhatsApp QR codes often contain the pairing code
                        // Try to extract alphanumeric code from QR
                        const qrMatch = qr.match(/[A-Z0-9]{6,8}/);
                        if (qrMatch) {
                            actualPairingCode = qrMatch[0];
                            console.log(`✅ Extracted pairing code from QR: ${actualPairingCode}`);
                        }
                    } catch (qrError) {
                        console.log(`❌ QR extraction failed:`, qrError.message);
                    }
                }
                
                // Method 3: Use the QR directly if it looks like a pairing code
                if (!actualPairingCode && qr && qr.length >= 6 && qr.length <= 8) {
                    actualPairingCode = qr;
                    console.log(`✅ Using QR as pairing code: ${actualPairingCode}`);
                }
                
                // Update session info with actual code
                if (actualPairingCode) {
                    sessionInfo.pairingCode = actualPairingCode;
                    
                    resolveRequest({ 
                        pairingCode: actualPairingCode,
                        waCode: actualPairingCode,
                        sessionId: sessionId,
                        status: "code_received", 
                        message: `Use this code in WhatsApp Linked Devices: ${actualPairingCode}`
                    });
                } else {
                    // Fallback: Show QR code
                    resolveRequest({ 
                        pairingCode: sessionInfo.pairingCode,
                        waCode: qr,
                        sessionId: sessionId,
                        status: "qr_received", 
                        message: "Scan the QR code with WhatsApp"
                    });
                }
            }
        });

        // Try to get pairing code immediately after connection
        setTimeout(async () => {
            if (!isResolved) {
                try {
                    console.log(`🔄 Trying to get pairing code directly...`);
                    const pairingCode = await waClient.requestPairingCode(num);
                    if (pairingCode) {
                        console.log(`✅ Got pairing code directly: ${pairingCode}`);
                        sessionInfo.pairingCode = pairingCode;
                        
                        resolveRequest({ 
                            pairingCode: pairingCode,
                            waCode: pairingCode,
                            sessionId: sessionId,
                            status: "code_received", 
                            message: `Use code in WhatsApp: ${pairingCode}`
                        });
                    }
                } catch (error) {
                    console.log(`ℹ️ Direct pairing code not available yet:`, error.message);
                }
            }
        }, 3000);

    } catch (err) {
        console.error("❌ Session creation error:", err);
        activeClients.delete(sessionId);
        return res.status(500).json({ error: err.message || "Server error" });
    }
});

async function initializeClient(sessionId, sessionInfo) {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionInfo.authPath);
        const { version } = await fetchLatestBaileysVersion();

        const waClient = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }))
            },
            printQRInTerminal: false,
            logger: pino({ level: "silent" }),
            browser: Browsers.ubuntu('Chrome'),
            syncFullHistory: false,
            markOnlineOnConnect: false,
        });

        sessionInfo.client = waClient;
        sessionInfo.isConnecting = true;

        waClient.ev.on("creds.update", saveCreds);
        
        waClient.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === "open") {
                console.log(`🔄 Reconnected for ${sessionId}`);
                sessionInfo.registered = true;
                sessionInfo.isConnecting = false;
                sessionInfo.reconnectAttempts = 0;
            } 
            else if (connection === "close") {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`Reconnection closed for ${sessionId}, status: ${statusCode}`);
                
                if (statusCode === 401) {
                    console.log(`Auth failed for ${sessionId}`);
                    sessionInfo.registered = false;
                    sessionInfo.isConnecting = false;
                } else {
                    sessionInfo.reconnectAttempts++;
                    if (sessionInfo.reconnectAttempts <= sessionInfo.maxReconnectAttempts) {
                        setTimeout(() => {
                            if (activeClients.has(sessionId)) {
                                initializeClient(sessionId, sessionInfo);
                            }
                        }, 5000);
                    } else {
                        console.log(`Max reconnection attempts reached for ${sessionId}`);
                        sessionInfo.isConnecting = false;
                    }
                }
            }
        });

    } catch (err) {
        console.error(`Reconnection failed for ${sessionId}`, err);
        sessionInfo.isConnecting = false;
    }
}

// --- SEND MESSAGE (task-specific) ---
app.post("/send-message", upload.single("messageFile"), async (req, res) => {
    const { sessionId, target, targetType, delaySec, prefix, ownerId } = req.body;
    const filePath = req.file?.path;

    if (!sessionId || !activeClients.has(sessionId)) {
        safeDeleteFile(filePath);
        return res.status(400).json({ error: "Invalid or inactive sessionId" });
    }
    
    const sessionInfo = activeClients.get(sessionId);
    if (!sessionInfo.registered || sessionInfo.isConnecting) {
        safeDeleteFile(filePath);
        return res.status(400).json({ error: "Session not ready. Please wait for connection." });
    }

    // Initialize client if needed
    if (!sessionInfo.client && sessionInfo.registered) {
        try {
            const { state, saveCreds } = await useMultiFileAuthState(sessionInfo.authPath);
            const { version } = await fetchLatestBaileysVersion();

            const waClient = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }))
                },
                printQRInTerminal: false,
                logger: pino({ level: "silent" }),
                browser: Browsers.ubuntu('Chrome'),
                syncFullHistory: false,
            });

            sessionInfo.client = waClient;
            waClient.ev.on("creds.update", saveCreds);
            
            // Wait for connection
            await new Promise((resolve) => {
                waClient.ev.on("connection.update", (update) => {
                    if (update.connection === "open") {
                        resolve();
                    }
                });
            });
            
        } catch (err) {
            safeDeleteFile(filePath);
            return res.status(400).json({ error: "Failed to initialize session: " + err.message });
        }
    }

    if (!target || !filePath || !targetType || !delaySec) {
        safeDeleteFile(filePath);
        return res.status(400).json({ error: "Missing required fields" });
    }

    const { client: waClient } = sessionInfo;
    const taskId = `${ownerId || "defaultUser"}_task_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;

    let messages;
    try {
        messages = fs.readFileSync(filePath, "utf-8").split("\n").map(m => m.trim()).filter(Boolean);
        if (messages.length === 0) throw new Error("Message file empty");
    } catch (err) {
        safeDeleteFile(filePath);
        return res.status(400).json({ error: "Invalid message file" });
    }

    const taskInfo = {
        taskId,
        sessionId,
        ownerId: ownerId || "defaultUser",
        isSending: true,
        stopRequested: false,
        totalMessages: messages.length,
        sentMessages: 0,
        target,
        targetType,
        prefix: prefix || "",
        startTime: new Date(),
        lastUpdate: new Date()
    };

    activeTasks.set(taskId, taskInfo);
    res.json({ taskId, status: "started", totalMessages: messages.length });

    // --- task execution ---
    (async () => {
        try {
            for (let index = 0; index < messages.length && !taskInfo.stopRequested; index++) {
                try {
                    let msg = messages[index];
                    if (taskInfo.prefix) msg = `${taskInfo.prefix} ${msg}`;
                    
                    const recipient = taskInfo.targetType === "group"
                        ? (taskInfo.target.includes('@g.us') ? taskInfo.target : taskInfo.target + '@g.us')
                        : (taskInfo.target.includes('@s.whatsapp.net') ? taskInfo.target : taskInfo.target + '@s.whatsapp.net');

                    await waClient.sendMessage(recipient, { text: msg });

                    taskInfo.sentMessages++;
                    taskInfo.lastUpdate = new Date();
                    console.log(`[${taskId}] Sent → ${taskInfo.target} (${taskInfo.sentMessages}/${taskInfo.totalMessages})`);
                    
                } catch (sendErr) {
                    console.error(`[${taskId}] Send error:`, sendErr);
                    taskInfo.error = sendErr?.message || String(sendErr);
                    taskInfo.lastError = new Date();
                    
                    if (sendErr.message?.includes("closed") || sendErr.message?.includes("disconnected")) {
                        taskInfo.stopRequested = true;
                        taskInfo.error = "Session disconnected. Please reconnect.";
                    }
                }

                const waitMs = parseFloat(delaySec) * 1000;
                const chunks = Math.ceil(waitMs / 1000);
                for (let t = 0; t < chunks && !taskInfo.stopRequested; t++) {
                    await delay(1000);
                }
                
                if (taskInfo.stopRequested) break;
            }
        } finally {
            taskInfo.endTime = new Date();
            taskInfo.isSending = false;
            taskInfo.completed = !taskInfo.stopRequested;
            safeDeleteFile(filePath);
            console.log(`[${taskId}] Finished. Sent: ${taskInfo.sentMessages}/${taskInfo.totalMessages}`);
        }
    })();
});

// --- TASK STATUS ---
app.get("/task-status", (req, res) => {
    const taskId = req.query.taskId;
    if (!taskId || !activeTasks.has(taskId)) return res.status(400).json({ error: "Invalid Task ID" });
    res.json(activeTasks.get(taskId));
});

// --- STOP TASK ---
app.post("/stop-task", upload.none(), async (req, res) => {
    const taskId = req.body.taskId;
    if (!taskId || !activeTasks.has(taskId)) return res.status(400).json({ error: "Invalid Task ID" });

    const taskInfo = activeTasks.get(taskId);
    taskInfo.stopRequested = true;
    taskInfo.isSending = false;
    taskInfo.endTime = new Date();
    taskInfo.endedBy = "user";

    return res.json({ success: true, message: `Task ${taskId} stop requested` });
});

// --- CLEANUP ENDPOINT ---
app.post("/cleanup-session", upload.none(), async (req, res) => {
    const { sessionId } = req.body;
    
    if (sessionId) {
        if (sessionId === "all") {
            activeClients.forEach((sessionInfo, id) => {
                try {
                    if (sessionInfo.client) sessionInfo.client.end();
                    console.log(`🧹 Session cleaned up: ${id}`);
                } catch (e) {
                    console.error(`Error cleaning up session ${id}:`, e);
                }
            });
            activeClients.clear();
        } else if (activeClients.has(sessionId)) {
            const sessionInfo = activeClients.get(sessionId);
            try {
                if (sessionInfo.client) sessionInfo.client.end();
                console.log(`🧹 Session cleaned up: ${sessionId}`);
            } catch (e) {
                console.error(`Error cleaning up session ${sessionId}:`, e);
            }
            activeClients.delete(sessionId);
        }
    }
    
    res.json({ success: true, message: "Session cleaned up" });
});

// --- GRACEFUL SHUTDOWN ---
process.on('SIGINT', () => {
    console.log('Shutting down gracefully...');
    activeClients.forEach(({ client }, sessionId) => {
        try { 
            if (client) client.end(); 
            console.log(`Closed session: ${sessionId}`);
        } catch (e) { 
            console.error(`Error closing session ${sessionId}:`, e);
        }
    });
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down...');
    process.exit(0);
});

app.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
    console.log(`📱 WhatsApp Bulk Sender Ready!`);
    console.log(`🔑 Now generating alphanumeric pairing codes for WhatsApp`);
});
