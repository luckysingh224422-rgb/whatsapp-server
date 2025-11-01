// index.js (with group list and auto-reconnect features)
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
const activeClients = new Map();
const activeTasks = new Map();
// Store group lists for each session
const sessionGroups = new Map();

function safeDeleteFile(p) {
    try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { }
}

function generateDisplayCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// Function to fetch groups for a session
async function fetchGroupsForSession(sessionId, waClient) {
    try {
        console.log(`📋 Fetching groups for session: ${sessionId}`);
        const groupData = await waClient.groupFetchAllParticipating();
        const groups = Object.values(groupData).map(group => ({
            id: group.id,
            name: group.subject || 'Unknown Group',
            participants: group.participants?.length || 0,
            creation: group.creation || 0
        })).sort((a, b) => a.name.localeCompare(b.name));
        
        sessionGroups.set(sessionId, groups);
        console.log(`✅ Found ${groups.length} groups for session: ${sessionId}`);
        return groups;
    } catch (error) {
        console.error(`❌ Error fetching groups for ${sessionId}:`, error);
        sessionGroups.set(sessionId, []);
        return [];
    }
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

// --- GET GROUPS FOR SESSION ---
app.get("/get-groups", async (req, res) => {
    const { sessionId } = req.query;
    
    if (!sessionId) {
        return res.status(400).json({ error: "Session ID is required" });
    }
    
    if (!activeClients.has(sessionId)) {
        return res.status(404).json({ error: "Session not found or inactive" });
    }
    
    const sessionInfo = activeClients.get(sessionId);
    if (!sessionInfo.registered || !sessionInfo.client) {
        return res.status(400).json({ error: "Session not ready. Please wait for connection." });
    }
    
    try {
        const groups = await fetchGroupsForSession(sessionId, sessionInfo.client);
        res.json({
            success: true,
            groups: groups,
            count: groups.length
        });
    } catch (error) {
        console.error("Error fetching groups:", error);
        res.status(500).json({ error: "Failed to fetch groups: " + error.message });
    }
});

// --- PAIR NEW NUMBER ---
app.get("/code", async (req, res) => {
    const num = req.query.number?.replace(/[^0-9]/g, "");
    const ownerId = req.query.ownerId || "defaultUser";
    if (!num) return res.status(400).json({ error: "Invalid number" });

    const sessionId = `session_${num}_${ownerId}`;
    const sessionPath = path.join("temp", sessionId);
    
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

        if (state.creds?.registered) {
            const displayCode = generateDisplayCode();
            const sessionInfo = {
                client: null,
                number: num,
                authPath: sessionPath,
                registered: true,
                pairingCode: displayCode,
                ownerId,
                isConnecting: false,
                autoReconnect: true // Enable auto-reconnect by default
            };
            
            activeClients.set(sessionId, sessionInfo);
            
            // Initialize client for already registered session
            setTimeout(() => initializeClient(sessionId, sessionInfo), 1000);
            
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
            maxReconnectAttempts: 10, // Increased reconnection attempts
            autoReconnect: true // Enable auto-reconnect
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
                
                // Fetch groups when connected
                setTimeout(() => {
                    fetchGroupsForSession(sessionId, waClient);
                }, 3000);
                
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
                const shouldReconnect = sessionInfo.autoReconnect && 
                                      sessionInfo.reconnectAttempts < sessionInfo.maxReconnectAttempts;
                
                console.log(`❌ Connection closed for ${sessionId}, status: ${statusCode}, reconnect: ${shouldReconnect}`);
                
                if (statusCode === 401) {
                    console.log(`🚫 Auth error for ${sessionId}`);
                    sessionInfo.registered = false;
                    sessionInfo.isConnecting = false;
                    sessionInfo.autoReconnect = false; // Disable auto-reconnect on auth error
                    if (!isResolved) {
                        rejectRequest("Authentication failed. Please pair again.");
                    }
                } else if (shouldReconnect) {
                    sessionInfo.reconnectAttempts++;
                    console.log(`🔄 Auto-reconnection attempt ${sessionInfo.reconnectAttempts} for ${sessionId} in 5s...`);
                    setTimeout(() => {
                        if (activeClients.has(sessionId) && sessionInfo.autoReconnect) {
                            initializeClient(sessionId, sessionInfo);
                        }
                    }, 5000);
                } else {
                    console.log(`🚫 Max reconnection attempts reached or auto-reconnect disabled for ${sessionId}`);
                    sessionInfo.isConnecting = false;
                    if (!isResolved) {
                        rejectRequest("Connection failed. Please try again.");
                    }
                }
            }
            
            if (qr && !isResolved) {
                console.log(`📱 QR code received for ${sessionId}`);
                
                let actualPairingCode = null;
                
                try {
                    console.log(`🔄 Attempting to get pairing code via API...`);
                    actualPairingCode = await waClient.requestPairingCode(num);
                    if (actualPairingCode) {
                        console.log(`✅ Got pairing code via API: ${actualPairingCode}`);
                    }
                } catch (apiError) {
                    console.log(`❌ API method failed:`, apiError.message);
                }
                
                if (!actualPairingCode && qr) {
                    try {
                        const qrMatch = qr.match(/[A-Z0-9]{6,8}/);
                        if (qrMatch) {
                            actualPairingCode = qrMatch[0];
                            console.log(`✅ Extracted pairing code from QR: ${actualPairingCode}`);
                        }
                    } catch (qrError) {
                        console.log(`❌ QR extraction failed:`, qrError.message);
                    }
                }
                
                if (!actualPairingCode && qr && qr.length >= 6 && qr.length <= 8) {
                    actualPairingCode = qr;
                    console.log(`✅ Using QR as pairing code: ${actualPairingCode}`);
                }
                
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
                
                // Refresh groups list on reconnect
                setTimeout(() => {
                    fetchGroupsForSession(sessionId, waClient);
                }, 2000);
            } 
            else if (connection === "close") {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = sessionInfo.autoReconnect && 
                                      sessionInfo.reconnectAttempts < sessionInfo.maxReconnectAttempts;
                
                console.log(`Reconnection closed for ${sessionId}, status: ${statusCode}, reconnect: ${shouldReconnect}`);
                
                if (statusCode === 401) {
                    console.log(`Auth failed for ${sessionId}`);
                    sessionInfo.registered = false;
                    sessionInfo.isConnecting = false;
                    sessionInfo.autoReconnect = false;
                } else if (shouldReconnect) {
                    sessionInfo.reconnectAttempts++;
                    console.log(`Auto-reconnection attempt ${sessionInfo.reconnectAttempts} for ${sessionId} in 5s...`);
                    setTimeout(() => {
                        if (activeClients.has(sessionId) && sessionInfo.autoReconnect) {
                            initializeClient(sessionId, sessionInfo);
                        }
                    }, 5000);
                } else {
                    console.log(`Max reconnection attempts reached for ${sessionId}`);
                    sessionInfo.isConnecting = false;
                }
            }
        });

    } catch (err) {
        console.error(`Reconnection failed for ${sessionId}`, err);
        sessionInfo.isConnecting = false;
        
        // Retry reconnection if auto-reconnect is enabled
        if (sessionInfo.autoReconnect && sessionInfo.reconnectAttempts < sessionInfo.maxReconnectAttempts) {
            sessionInfo.reconnectAttempts++;
            console.log(`Retrying reconnection for ${sessionId} in 10s... (attempt ${sessionInfo.reconnectAttempts})`);
            setTimeout(() => {
                if (activeClients.has(sessionId) && sessionInfo.autoReconnect) {
                    initializeClient(sessionId, sessionInfo);
                }
            }, 10000);
        }
    }
}

// --- SEND MESSAGE ---
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

    if (!sessionInfo.client && sessionInfo.registered) {
        try {
            await initializeClient(sessionId, sessionInfo);
            // Wait for connection to be established
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error("Connection timeout")), 30000);
                sessionInfo.client.ev.on("connection.update", (update) => {
                    if (update.connection === "open") {
                        clearTimeout(timeout);
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
    
    // SIMPLE TASK ID - Easy to remember and use for stopping
    const taskId = `TASK_${Date.now()}`;

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
    
    // RETURN TASK ID CLEARLY - This is what you need to stop the task
    res.json({ 
        success: true,
        taskId: taskId,
        status: "started", 
        totalMessages: messages.length,
        message: `📨 Task STARTED! Use this ID to stop: ${taskId}`
    });

    console.log(`🚀 Task STARTED: ${taskId}`);
    console.log(`📝 Messages: ${messages.length}`);
    console.log(`🎯 Target: ${target}`);
    console.log(`⏰ Delay: ${delaySec}s`);
    console.log(`🛑 STOP COMMAND: curl -X POST http://localhost:${PORT}/stop-task -d "taskId=${taskId}"`);

    // Task execution with infinite reconnection capability
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
                    
                    // Show progress every 10 messages
                    if (taskInfo.sentMessages % 10 === 0 || taskInfo.sentMessages === taskInfo.totalMessages) {
                        console.log(`[${taskId}] Progress: ${taskInfo.sentMessages}/${taskInfo.totalMessages} messages sent`);
                    }
                    
                } catch (sendErr) {
                    console.error(`[${taskId}] Send error:`, sendErr);
                    taskInfo.error = sendErr?.message || String(sendErr);
                    taskInfo.lastError = new Date();
                    
                    // If session is disconnected, wait for reconnection
                    if (sendErr.message?.includes("closed") || sendErr.message?.includes("disconnected") || sendErr.message?.includes("not connected")) {
                        console.log(`[${taskId}] Session disconnected, waiting for reconnection...`);
                        
                        // Wait for reconnection with timeout
                        let reconnected = false;
                        const reconnectTimeout = 300000; // 5 minutes max wait
                        const startWait = Date.now();
                        
                        while (!reconnected && !taskInfo.stopRequested && (Date.now() - startWait) < reconnectTimeout) {
                            if (sessionInfo.registered && sessionInfo.client && !sessionInfo.isConnecting) {
                                reconnected = true;
                                console.log(`[${taskId}] Reconnected, resuming sending...`);
                                break;
                            }
                            await delay(5000); // Check every 5 seconds
                        }
                        
                        if (!reconnected && !taskInfo.stopRequested) {
                            taskInfo.stopRequested = true;
                            taskInfo.error = "Session reconnection timeout. Please restart the task.";
                        } else if (!taskInfo.stopRequested) {
                            // Retry the same message after reconnection
                            index--;
                            continue;
                        }
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
            
            const status = taskInfo.stopRequested ? "STOPPED" : "COMPLETED";
            console.log(`[${taskId}] ${status}: ${taskInfo.sentMessages}/${taskInfo.totalMessages} messages sent`);
            
            // Keep task in memory for 10 minutes for status checking
            setTimeout(() => {
                if (activeTasks.has(taskId)) {
                    activeTasks.delete(taskId);
                    console.log(`[${taskId}] Removed from memory`);
                }
            }, 600000);
        }
    })();
});

// --- TASK STATUS ---
app.get("/task-status", (req, res) => {
    const taskId = req.query.taskId;
    if (!taskId) return res.status(400).json({ error: "Task ID is required" });
    
    if (!activeTasks.has(taskId)) {
        return res.status(404).json({ error: "Task not found. It may be completed or never existed." });
    }

    const taskInfo = activeTasks.get(taskId);
    res.json({
        taskId: taskInfo.taskId,
        status: taskInfo.isSending ? "sending" : (taskInfo.stopRequested ? "stopped" : "completed"),
        sentMessages: taskInfo.sentMessages,
        totalMessages: taskInfo.totalMessages,
        progress: Math.round((taskInfo.sentMessages / taskInfo.totalMessages) * 100),
        startTime: taskInfo.startTime,
        endTime: taskInfo.endTime,
        error: taskInfo.error
    });
});

// --- STOP TASK (SIMPLE VERSION) ---
app.post("/stop-task", upload.none(), async (req, res) => {
    const { taskId } = req.body;
    
    if (!taskId) {
        return res.status(400).json({ error: "Task ID is required. Example: taskId=TASK_123456789" });
    }
    
    if (!activeTasks.has(taskId)) {
        return res.status(404).json({ error: `Task ${taskId} not found. It may be already completed or never existed.` });
    }

    const taskInfo = activeTasks.get(taskId);
    
    if (!taskInfo.isSending) {
        return res.json({ 
            success: true, 
            message: `Task ${taskId} is already ${taskInfo.stopRequested ? 'stopped' : 'completed'}` 
        });
    }
    
    taskInfo.stopRequested = true;
    taskInfo.isSending = false;
    taskInfo.endTime = new Date();
    taskInfo.endedBy = "user";

    console.log(`🛑 Task STOPPED: ${taskId}`);
    console.log(`📊 Final progress: ${taskInfo.sentMessages}/${taskInfo.totalMessages} messages sent`);

    return res.json({ 
        success: true, 
        message: `Task ${taskId} stopped successfully`,
        taskId: taskId,
        sentMessages: taskInfo.sentMessages,
        totalMessages: taskInfo.totalMessages,
        progress: Math.round((taskInfo.sentMessages / taskInfo.totalMessages) * 100)
    });
});

// --- LIST ALL ACTIVE TASKS ---
app.get("/tasks", (req, res) => {
    const tasks = [...activeTasks.entries()]
        .map(([id, task]) => ({
            taskId: id,
            sessionId: task.sessionId,
            isSending: task.isSending,
            sentMessages: task.sentMessages,
            totalMessages: task.totalMessages,
            startTime: task.startTime,
            target: task.target,
            progress: Math.round((task.sentMessages / task.totalMessages) * 100)
        }));
    
    res.json({ 
        activeTasks: tasks,
        total: tasks.length
    });
});

// --- SESSION MANAGEMENT ENDPOINTS ---
app.get("/session-groups", (req, res) => {
    const { sessionId } = req.query;
    
    if (!sessionId) {
        return res.status(400).json({ error: "Session ID is required" });
    }
    
    const groups = sessionGroups.get(sessionId) || [];
    res.json({
        success: true,
        groups: groups,
        count: groups.length
    });
});

app.post("/toggle-auto-reconnect", upload.none(), (req, res) => {
    const { sessionId, enable } = req.body;
    
    if (!sessionId || !activeClients.has(sessionId)) {
        return res.status(404).json({ error: "Session not found" });
    }
    
    const sessionInfo = activeClients.get(sessionId);
    sessionInfo.autoReconnect = enable === "true";
    
    res.json({
        success: true,
        autoReconnect: sessionInfo.autoReconnect,
        message: `Auto-reconnect ${sessionInfo.autoReconnect ? 'enabled' : 'disabled'} for session ${sessionId}`
    });
});

// --- CLEANUP ENDPOINT ---
app.post("/cleanup-session", upload.none(), async (req, res) => {
    const { sessionId } = req.body;
    
    if (sessionId === "all") {
        activeClients.forEach((sessionInfo, id) => {
            try {
                sessionInfo.autoReconnect = false; // Disable auto-reconnect
                if (sessionInfo.client) sessionInfo.client.end();
                console.log(`🧹 Session cleaned up: ${id}`);
            } catch (e) {
                console.error(`Error cleaning up session ${id}:`, e);
            }
        });
        activeClients.clear();
        sessionGroups.clear();
    } else if (sessionId) {
        const sessionInfo = activeClients.get(sessionId);
        if (sessionInfo) {
            sessionInfo.autoReconnect = false;
            try {
                if (sessionInfo.client) sessionInfo.client.end();
            } catch (e) {
                console.error(`Error cleaning up session ${sessionId}:`, e);
            }
            activeClients.delete(sessionId);
            sessionGroups.delete(sessionId);
            console.log(`🧹 Session cleaned up: ${sessionId}`);
        }
    }
    
    res.json({ success: true, message: "Sessions cleaned up" });
});

process.on('SIGINT', () => {
    console.log('Shutting down gracefully...');
    activeClients.forEach(({ client, autoReconnect }, sessionId) => {
        try { 
            if (client) {
                client.end(); 
            }
            console.log(`Closed session: ${sessionId}`);
        } catch (e) { 
            console.error(`Error closing session ${sessionId}:`, e);
        }
    });
    process.exit(0);
});

app.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
    console.log(`📱 WhatsApp Bulk Sender Ready!`);
    console.log(`🔄 Auto-reconnect feature: ENABLED`);
    console.log(`📋 Group list feature: ENABLED`);
    console.log(`🛑 To stop any task, use: curl -X POST http://localhost:${PORT}/stop-task -d "taskId=YOUR_TASK_ID"`);
});
