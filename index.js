const express = require("express");
const QRCode = require("qrcode");
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require("@whiskeysockets/baileys");
const path = require("path");
const rimraf = require("rimraf");

const app = express();
app.use(express.json({ limit: "10kb" }));

const OTP_VALIDITY = 5 * 60 * 1000;
const BLOCK_DURATION = 15 * 60 * 1000;

let sock, currentQR = "", isConnected = false;
const otpStore = new Map();
const requestLog = new Map();
const blocked = new Set();

function block(key) {
  blocked.add(key);
  setTimeout(() => blocked.delete(key), BLOCK_DURATION);
}

function logRequest(ip) {
  const now = Date.now();
  const entries = requestLog.get(ip) || [];
  const recent = entries.filter(t => now - t < 60000);
  recent.push(now);
  requestLog.set(ip, recent);
  return recent.length;
}

function storeOTP(phone, otp) {
  otpStore.set(phone, { otp, expires: Date.now() + OTP_VALIDITY });
  setTimeout(() => otpStore.delete(phone), OTP_VALIDITY);
}

// WhatsApp connection
async function startSocket() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");
  sock = makeWASocket({ auth: state, printQRInTerminal: false });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) currentQR = await QRCode.toDataURL(qr);
    if (connection === "close") {
      const code = (lastDisconnect?.error)?.output?.statusCode;
      isConnected = false;
      if (code === DisconnectReason.loggedOut) {
        rimraf.sync("./auth");
        currentQR = "";
        setTimeout(startSocket, 1500);
      } else startSocket();
    }
    if (connection === "open") {
      isConnected = true;
      currentQR = "";
      console.log("Connected to WhatsApp");
    }
  });
}
startSocket();

// Routes
app.get("/qr", async (req, res) => {
  if (isConnected) return res.send("<h3>Already connected to WhatsApp</h3>");
  if (!currentQR) return res.send("<h3>QR not ready. Try again.</h3>");
  res.send(`<img src="${currentQR}" width="300" height="300" /><p>Scan to connect</p>`);
});

app.post("/otp", async (req, res) => {
  const ip = req.ip;
  if (blocked.has(ip)) return res.status(429).json({ error: "Blocked" });
  if (logRequest(ip) > 5) {
    block(ip);
    return res.status(429).json({ error: "Too many requests" });
  }

  const input = req.body;
  if (!input?.phone) return res.status(400).json({ error: "Invalid input" });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  storeOTP(input.phone, otp);

  const verificationUrl = `https://fts.com/otp?=${otp}`;
  const msg = `*Booking Confirmation OTP*\n\nHello,\nTo confirm your booking with Farhan Transport Service, please use the OTP below:\n\n*OTP:* ${otp}\n\nValid for 5 minutes. Do not share this code.`;

  try {
    // Send OTP with a button
    await sock.sendMessage(`${input.phone}@s.whatsapp.net`, {
      text: msg,
      footer: "Farhan Transport Service",
      buttons: [
        {
          buttonId: `verify_otp_${otp}`,
          buttonText: { displayText: "Verify via Web" },
          type: 1
        }
      ],
      headerType: 1
    });

    // Optional: Send link separately
    await sock.sendMessage(`${input.phone}@s.whatsapp.net`, {
      text: `Or click the link to verify:\n${verificationUrl}`
    });

    res.json({ sent: true });
  } catch (err) {
    console.error("Error sending message:", err);
    res.status(500).json({ error: "Failed to send OTP" });
  }
});

app.post("/verify", (req, res) => {
  const input = req.body;
  if (!input?.phone || !input?.otp)
    return res.status(400).json({ error: "Invalid input" });

  const stored = otpStore.get(input.phone);
  if (stored && stored.otp === input.otp && Date.now() < stored.expires) {
    otpStore.delete(input.phone);
    return res.json({ verified: true });
  }

  block(input.phone);
  res.json({ verified: false, error: "Invalid or expired OTP" });
});

app.listen(3000, () => console.log("API running on http://localhost:3000"));
