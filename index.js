// index.js (fixed with correct WhatsApp pairing code)
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

app.get("/status", (req, res) => {
    const ownerId = req.query.ownerId;
    res.json({
        activeSessions: [...activeClients.entries()]
            .filter(([_, info]) => !ownerId || info.ownerId === ownerId)
            .map(([id, info]) => ({
                sessionId: id,
                number: info.number,
                registered: info.registered,
                pairingCode: info.pairingCode,
                isConnecting: info.isConnecting || false
            })),
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
    
    // Check if session already exists and is connecting
    const existingSession = activeClients.get(sessionId);
    if (existingSession && existingSession.isConnecting) {
        return res.status(400).json({ error: "Session is already being set up. Please wait." });
    }

    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();

        // If already registered, just return success
        if (state.creds?.registered) {
            console.log(`✅ Session already registered: ${sessionId}`);
            return res.json({ 
                pairingCode: "ALREADY_REGISTERED",
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
            printQRInTerminal: true, // Terminal pe QR dikhayega
            logger: pino({ level: "fatal" }),
            browser: Browsers.ubuntu('Chrome'),
            syncFullHistory: false,
            shouldIgnoreJid: jid => isJidBroadcast(jid),
            markOnlineOnConnect: false,
            connectTimeoutMs: 60000,
        });

        const sessionInfo = {
            client: waClient,
            number: num,
            authPath: sessionPath,
            registered: false,
            pairingCode: null,
            ownerId,
            isConnecting: true,
            reconnectAttempts: 0,
            maxReconnectAttempts: 3
        };

        activeClients.set(sessionId, sessionInfo);

        let connectionTimeout;
        let isResolved = false;
        let pairingCodeReceived = false;

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
            activeClients.delete(sessionId);
            res.status(500).json({ error });
        };

        // Set timeout for connection (3 minutes)
        connectionTimeout = setTimeout(() => {
            if (!isResolved) {
                console.log(`⏰ Connection timeout for ${sessionId}`);
                rejectRequest("Connection timeout. Please try again.");
            }
        }, 180000);

        waClient.ev.on("creds.update", saveCreds);
        
        // First, try to get pairing code directly
        try {
            console.log(`🔄 Requesting pairing code for ${num}...`);
            const pairingCode = await waClient.requestPairingCode(num);
            
            if (pairingCode && pairingCode.match(/^\d{8}$/)) {
                console.log(`✅ WhatsApp pairing code received: ${pairingCode}`);
                pairingCodeReceived = true;
                
                sessionInfo.pairingCode = pairingCode;
                sessionInfo.registered = false;
                
                resolveRequest({ 
                    pairingCode: pairingCode,
                    waCode: pairingCode,
                    sessionId: sessionId,
                    status: "code_received", 
                    message: "Use this 8-digit code in WhatsApp Linked Devices"
                });
                return;
            }
        } catch (pairError) {
            console.log("Could not get pairing code directly, using QR method...", pairError.message);
        }

        // If direct pairing code fails, use QR method
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
                        pairingCode: "CONNECTED",
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
                    // Authentication error - remove session
                    console.log(`🚫 Auth error for ${sessionId}, re-pair required.`);
                    activeClients.delete(sessionId);
                    if (!isResolved) {
                        rejectRequest("Authentication failed. Please pair again.");
                    }
                } else {
                    // Other errors - limited reconnection attempts
                    sessionInfo.reconnectAttempts++;
                    if (sessionInfo.reconnectAttempts <= sessionInfo.maxReconnectAttempts) {
                        console.log(`🔄 Reconnection attempt ${sessionInfo.reconnectAttempts} for ${sessionId} in 10s...`);
                        setTimeout(() => {
                            if (activeClients.has(sessionId)) {
                                initializeClient(sessionId, sessionInfo);
                            }
                        }, 10000);
                    } else {
                        console.log(`🚫 Max reconnection attempts reached for ${sessionId}`);
                        activeClients.delete(sessionId);
                        if (!isResolved) {
                            rejectRequest("Max reconnection attempts reached. Please try again.");
                        }
                    }
                }
            }
            
            // Handle QR code for new sessions
            if (qr && !pairingCodeReceived && !isResolved) {
                console.log(`📱 QR code received for ${sessionId}`);
                // QR code aane par bhi direct pairing code try karo
                try {
                    const pairingCode = await waClient.requestPairingCode(num);
                    if (pairingCode && pairingCode.match(/^\d{8}$/)) {
                        console.log(`✅ WhatsApp pairing code received via QR: ${pairingCode}`);
                        pairingCodeReceived = true;
                        
                        sessionInfo.pairingCode = pairingCode;
                        
                        resolveRequest({ 
                            pairingCode: pairingCode,
                            waCode: pairingCode,
                            sessionId: sessionId,
                            status: "code_received", 
                            message: "Use this 8-digit code in WhatsApp Linked Devices"
                        });
                    } else {
                        // Agar pairing code nahi mila to QR dikhao
                        console.log(`📱 Showing QR code for pairing`);
                        resolveRequest({ 
                            pairingCode: "SCAN_QR",
                            waCode: qr,
                            sessionId: sessionId,
                            status: "qr_received", 
                            message: "Scan the QR code with WhatsApp"
                        });
                    }
                } catch (error) {
                    console.log("Failed to get pairing code after QR:", error.message);
                    // QR code hi dikhao
                    resolveRequest({ 
                        pairingCode: "SCAN_QR",
                        waCode: qr,
                        sessionId: sessionId,
                        status: "qr_received", 
                        message: "Scan the QR code with WhatsApp"
                    });
                }
            }
        });

    } catch (err) {
        console.error("Session creation error:", err);
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
            logger: pino({ level: "fatal" }),
            browser: Browsers.ubuntu('Chrome'),
            syncFullHistory: false,
            markOnlineOnConnect: false,
            connectTimeoutMs: 30000,
        });

        // Update session info
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
                    console.log(`Auth failed for ${sessionId}, removing session.`);
                    activeClients.delete(sessionId);
                } else {
                    sessionInfo.reconnectAttempts++;
                    if (sessionInfo.reconnectAttempts <= sessionInfo.maxReconnectAttempts) {
                        console.log(`Retry reconnect for ${sessionId} in 10s... (attempt ${sessionInfo.reconnectAttempts})`);
                        setTimeout(() => {
                            if (activeClients.has(sessionId)) {
                                initializeClient(sessionId, sessionInfo);
                            }
                        }, 10000);
                    } else {
                        console.log(`Max reconnection attempts reached for ${sessionId}`);
                        activeClients.delete(sessionId);
                    }
                }
            }
        });

    } catch (err) {
        console.error(`Reconnection failed for ${sessionId}`, err);
        sessionInfo.reconnectAttempts++;
        
        if (sessionInfo.reconnectAttempts <= sessionInfo.maxReconnectAttempts) {
            setTimeout(() => {
                if (activeClients.has(sessionId)) {
                    initializeClient(sessionId, sessionInfo);
                }
            }, 10000);
        } else {
            console.log(`Final reconnection failure for ${sessionId}`);
            activeClients.delete(sessionId);
        }
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

    // --- task execution bound to specific session ---
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
                    
                    // If session is disconnected, stop the task
                    if (sendErr.message?.includes("closed") || sendErr.message?.includes("disconnected")) {
                        taskInfo.stopRequested = true;
                        taskInfo.error = "Session disconnected. Please reconnect.";
                    }
                }

                // Wait with interruptible delay
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

// --- GET ALL TASKS FOR OWNER ---
app.get("/tasks", (req, res) => {
    const ownerId = req.query.ownerId;
    const tasks = [...activeTasks.entries()]
        .filter(([_, task]) => !ownerId || task.ownerId === ownerId)
        .map(([id, task]) => ({
            taskId: id,
            sessionId: task.sessionId,
            isSending: task.isSending,
            sentMessages: task.sentMessages,
            totalMessages: task.totalMessages,
            startTime: task.startTime,
            endTime: task.endTime
        }));
    
    res.json({ tasks });
});

// --- CLEANUP ENDPOINT ---
app.post("/cleanup-session", upload.none(), async (req, res) => {
    const { sessionId } = req.body;
    
    if (sessionId) {
        if (sessionId === "all") {
            // Clean all sessions
            activeClients.forEach((sessionInfo, id) => {
                try {
                    sessionInfo.client.end();
                    console.log(`🧹 Session cleaned up: ${id}`);
                } catch (e) {
                    console.error(`Error cleaning up session ${id}:`, e);
                }
            });
            activeClients.clear();
        } else if (activeClients.has(sessionId)) {
            const sessionInfo = activeClients.get(sessionId);
            try {
                sessionInfo.client.end();
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
            client.end(); 
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
    console.log(`🔑 Using direct WhatsApp pairing codes`);
});
