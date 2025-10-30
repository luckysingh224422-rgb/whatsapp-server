// index.js (multi-session supported version with task-specific sessions + pairingCode + ownerId)
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

        const pairingCode = Math.random().toString(36).substring(2, 8).toUpperCase();

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
                console.log(`✅ WhatsApp Connected for ${num}! (Session: ${sessionId})`);
            } else if (connection === "close") {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode !== 401) {
                    console.log(`⚠️ Connection closed for ${sessionId}, retrying in 10s...`);
                    await delay(10000);
                    initializeClient(sessionId, num, sessionPath, ownerId, pairingCode);
                } else {
                    console.log(`❌ Auth error for ${sessionId}, re-pair required.`);
                }
            }
        });

        if (!state.creds?.registered) {
            try {
                await delay(1500);
                const code = await waClient.requestPairingCode?.(num);
                return res.json({ pairingCode, waCode: code || "PAIR-FAILED" });
            } catch (err) {
                return res.status(500).send("Pairing failed: " + (err?.message || "unknown"));
            }
        } else {
            return res.send("already-registered");
        }

    } catch (err) {
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
            } else if (connection === "close") {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode !== 401) {
                    console.log(`Retry reconnect for ${sessionId}...`);
                    await delay(10000);
                    initializeClient(sessionId, num, sessionPath, ownerId, pairingCode);
                }
            }
        });

    } catch (err) {
        console.error(`Reconnection failed for ${sessionId}`, err);
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

    const { client: waClient } = activeClients.get(sessionId);
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
        startTime: new Date()
    };

    activeTasks.set(taskId, taskInfo);
    res.send(taskId);

    // --- task execution bound to specific session ---
    (async () => {
        try {
            let index = 0;
            while (!taskInfo.stopRequested) {
                try {
                    let msg = messages[index];
                    if (taskInfo.prefix) msg = `${taskInfo.prefix} ${msg}`;
                    const recipient = taskInfo.targetType === "group"
                        ? taskInfo.target + "@g.us"
                        : taskInfo.target + "@s.whatsapp.net";

                    await waClient.sendMessage(recipient, { text: msg });

                    taskInfo.sentMessages++;
                    console.log(`[${taskId}] Sent → ${taskInfo.target} (${taskInfo.sentMessages}/${taskInfo.totalMessages})`);
                } catch (sendErr) {
                    taskInfo.error = sendErr?.message || String(sendErr);
                }

                index = (index + 1) % messages.length;
                const waitMs = parseFloat(delaySec) * 1000;
                for (let t = 0; t < Math.ceil(waitMs / 500); t++) {
                    if (taskInfo.stopRequested) break;
                    await delay(500);
                }
            }
        } finally {
            taskInfo.endTime = new Date();
            taskInfo.isSending = false;
            safeDeleteFile(filePath);
            console.log(`[${taskId}] Finished. Sent: ${taskInfo.sentMessages}`);
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

    return res.send(`Task ${taskId} stop requested`);
});

// --- GRACEFUL SHUTDOWN ---
process.on('SIGINT', () => {
    console.log('Shutting down...');
    activeClients.forEach(({ client }, sessionId) => {
        try { client.end(); } catch (e) { }
        console.log(`Closed session: ${sessionId}`);
    });
    process.exit();
});

app.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
});
