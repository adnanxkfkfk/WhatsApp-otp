const express = require("express");
const QRCode = require("qrcode");
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");
const path = require("path");
const rimraf = require("rimraf");

const app = express();
app.use(express.json({ limit: "10kb" }));

const OTP_VALIDITY = 5 * 60 * 1000;
const BLOCK_DURATION = 15 * 60 * 1000;

let sock,
  currentQR = "",
  isConnected = false;
const otpStore = new Map();
const requestLog = new Map();
const blocked = new Set();

// Helper Functions
function block(key) {
  blocked.add(key);
  setTimeout(() => blocked.delete(key), BLOCK_DURATION);
}

function logRequest(ip) {
  const now = Date.now();
  const entries = requestLog.get(ip) || [];
  const recent = entries.filter((t) => now - t < 60000);
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
      const code = lastDisconnect?.error?.output?.statusCode;
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

// Send OTP with URL button
app.post("/message", async (req, res) => {
  const { phone, message } = req.body;

  if (!phone || !message) {
    return res.status(400).json({ error: "Missing phone or message" });
  }

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  storeOTP(phone, otp);

  const buttonMessage = {
    text: `${message}\n\nYour OTP is: *${otp}*\nIt is valid for 5 minutes.\nClick below to verify.`,
    footer: "Do not share this OTP with anyone.",
    templateButtons: [
      {
        index: 0,
        urlButton: {
          displayText: "Verify OTP",
          url: `https://ftstransportservice.com/verify?OTP=${otp}`
        }
      },
      {
        index: 1,
        quickReplyButton: {
          displayText: "Resend OTP",
          id: "resend_otp"
        }
      }
    ]
  };

  try {
    await sock.sendMessage(`${phone}@s.whatsapp.net`, buttonMessage);
    res.json({ sent: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to send message" });
  }
});

// Verify OTP
app.post("/verify", (req, res) => {
  const { phone, otp } = req.body;
  if (!phone || !otp) return res.status(400).json({ error: "Invalid input" });

  const stored = otpStore.get(phone);
  if (stored && stored.otp === otp && Date.now() < stored.expires) {
    otpStore.delete(phone);
    return res.json({ verified: true });
  }

  block(phone);
  res.json({ verified: false, error: "Invalid or expired OTP" });
});

app.listen(3000, () => console.log("API running on http://localhost:3000"));
