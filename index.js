// index.js (fixed version with proper WhatsApp pairing codes)
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
const activeClients = new Map(); // sessionId → { client, number, authPath, pairingCode, ownerId }
const activeTasks = new Map();   // taskId → taskInfo

function safeDeleteFile(p) {
    try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { }
}

// Generate proper 6-digit numeric pairing code
function generatePairingCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
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
                pairingCode: info.pairingCode
            })),
        activeTasks: [...activeTasks.entries()]
            .filter(([_, task]) => !ownerId || task.ownerId === ownerId).length
    });
});

// --- PAIR NEW NUMBER ---
app.get("/code", async (req, res) => {
    const num = req.query.number?.replace(/[^0-9]/g, "");
    const ownerId = req.query.ownerId || "defaultUser";
    if (!num) return res.status(400).send("Invalid number");

    const sessionId = `session_${num}_${ownerId}`;
    const sessionPath = path.join("temp", sessionId);
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
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
            shouldIgnoreJid: jid => isJidBroadcast(jid)
        });

        const pairingCode = generatePairingCode();

        activeClients.set(sessionId, {
            client: waClient,
            number: num,
            authPath: sessionPath,
            registered: !!state.creds?.registered,
            pairingCode,
            ownerId
        });

        waClient.ev.on("creds.update", saveCreds);
        waClient.ev.on("connection.update", async (s) => {
            const { connection, lastDisconnect, qr } = s;
            
            if (connection === "open") {
                console.log(`✅ WhatsApp Connected for ${num}! (Session: ${sessionId})`);
                // Update registration status when connected
                const sessionInfo = activeClients.get(sessionId);
                if (sessionInfo) {
                    sessionInfo.registered = true;
                }
            } else if (connection === "close") {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode !== 401) {
                    console.log(`⚠️ Connection closed for ${sessionId}, retrying in 10s...`);
                    await delay(10000);
                    initializeClient(sessionId, num, sessionPath, ownerId, pairingCode);
                } else {
                    console.log(`❌ Auth error for ${sessionId}, re-pair required.`);
                    // Remove from active clients on auth error
                    activeClients.delete(sessionId);
                }
            }
        });

        if (!state.creds?.registered) {
            try {
                await delay(2000); // Increased delay for stability
                let waCode;
                
                // Try to get pairing code from WhatsApp
                if (waClient.requestPairingCode) {
                    waCode = await waClient.requestPairingCode(num);
                } else {
                    // Fallback: if requestPairingCode not available, use our generated code
                    waCode = pairingCode;
                }
                
                console.log(`📱 Pairing code for ${num}: ${waCode} (Session: ${sessionId})`);
                return res.json({ 
                    pairingCode: pairingCode, 
                    waCode: waCode || pairingCode,
                    sessionId: sessionId
                });
            } catch (err) {
                console.error("Pairing error:", err);
                return res.status(500).send("Pairing failed: " + (err?.message || "unknown"));
            }
        } else {
            console.log(`✅ Session already registered: ${sessionId}`);
            return res.json({ 
                pairingCode: pairingCode,
                waCode: "ALREADY_REGISTERED",
                sessionId: sessionId,
                status: "already-registered"
            });
        }

    } catch (err) {
        console.error("Session creation error:", err);
        return res.status(500).send(err.message || "Server error");
    }
});

async function initializeClient(sessionId, num, sessionPath, ownerId, pairingCode) {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
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
            syncFullHistory: false
        });

        activeClients.set(sessionId, {
            client: waClient,
            number: num,
            authPath: sessionPath,
            registered: !!state.creds?.registered,
            pairingCode,
            ownerId
        });

        waClient.ev.on("creds.update", saveCreds);
        waClient.ev.on("connection.update", async (s) => {
            const { connection, lastDisconnect } = s;
            if (connection === "open") {
                console.log(`🔄 Reconnected for ${sessionId}`);
                // Update registration status
                const sessionInfo = activeClients.get(sessionId);
                if (sessionInfo) {
                    sessionInfo.registered = true;
                }
            } else if (connection === "close") {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode !== 401) {
                    console.log(`Retry reconnect for ${sessionId}...`);
                    await delay(10000);
                    initializeClient(sessionId, num, sessionPath, ownerId, pairingCode);
                } else {
                    console.log(`Auth failed for ${sessionId}, removing session.`);
                    activeClients.delete(sessionId);
                }
            }
        });

    } catch (err) {
        console.error(`Reconnection failed for ${sessionId}`, err);
        activeClients.delete(sessionId);
    }
}

// --- SEND MESSAGE (task-specific) ---
app.post("/send-message", upload.single("messageFile"), async (req, res) => {
    const { sessionId, target, targetType, delaySec, prefix, ownerId } = req.body;
    const filePath = req.file?.path;

    if (!sessionId || !activeClients.has(sessionId)) {
        safeDeleteFile(filePath);
        return res.status(400).send("Invalid or inactive sessionId");
    }
    
    if (!target || !filePath || !targetType || !delaySec) {
        safeDeleteFile(filePath);
        return res.status(400).send("Missing required fields");
    }

    const sessionInfo = activeClients.get(sessionId);
    if (!sessionInfo.registered) {
        safeDeleteFile(filePath);
        return res.status(400).send("Session not registered/connected yet");
    }

    const { client: waClient } = sessionInfo;
    const taskId = `${ownerId || "defaultUser"}_task_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;

    let messages;
    try {
        messages = fs.readFileSync(filePath, "utf-8").split("\n").map(m => m.trim()).filter(Boolean);
        if (messages.length === 0) throw new Error("Message file empty");
    } catch (err) {
        safeDeleteFile(filePath);
        return res.status(400).send("Invalid message file");
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
    if (!taskId || !activeTasks.has(taskId)) return res.status(400).send("Invalid Task ID");
    res.json(activeTasks.get(taskId));
});

// --- STOP TASK ---
app.post("/stop-task", upload.none(), async (req, res) => {
    const taskId = req.body.taskId;
    if (!taskId || !activeTasks.has(taskId)) return res.status(400).send("Invalid Task ID");

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
});
