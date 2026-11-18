import "dotenv/config";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { google } from "googleapis";
import crypto from "node:crypto";
import express from "express";

// --- Lazy Singleton Database Connection ---
let _db = null;
function getDb() {
  if (!_db) {
    if (!getApps().length) {
      if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
        initializeApp({ credential: cert(serviceAccount) });
      } else {
        initializeApp();
      }
    }
    _db = getFirestore();
  }
  return _db;
}

// Environment & Config
const MERCHANT_UPI_ID = process.env.MERCHANT_UPI_ID || "paytmqr6rwd4k@ptys";
const MERCHANT_NAME = process.env.MERCHANT_NAME || "rinku sinha";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "https://vexpay-seven.vercel.app/oauth2callback";
const FRONTEND_URL = process.env.FRONTEND_URL || "https://vexpay.netlify.app/";

const ORDER_EXPIRY_MS = 5 * 60 * 1000;
const SLOT_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_SLOTS = 30;

let lastSyncMs = 0;
let syncInProgress = null;

const id = (p) => `${p}_${crypto.randomBytes(9).toString("hex").toUpperCase()}`;
const hash = (s) => crypto.createHash("sha256").update(s || "").digest("hex");
const money = (paise) => (paise / 100).toFixed(2);
const now = () => Date.now();

function getOAuthClient() {
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
}

async function triggerAutoSync(minIntervalMs = 4000) {
  const t = now();
  if (syncInProgress) return syncInProgress;
  if (t - lastSyncMs < minIntervalMs) return null;
  lastSyncMs = t;
  syncInProgress = runGmailSync()
    .catch((err) => console.error("Auto sync error:", err.message))
    .finally(() => {
      syncInProgress = null;
    });
  return syncInProgress;
}

// Dynamic Slot Allocation
async function allocateSlot(basePaise) {
  const db = getDb();
  const t = now();

  const snap = await db.collection("orders")
    .where("status", "in", ["PENDING", "SUCCESS", "EXPIRED"])
    .get();

  const recentOrders = snap.docs.map((d) => d.data());

  for (let slot = 1; slot <= MAX_SLOTS; slot++) {
    const candidatePaise = basePaise + slot;
    let isOccupied = false;

    for (const order of recentOrders) {
      if (order.payablePaise !== candidatePaise) continue;

      if (order.status === "PENDING" && t < order.expiresAtMs) {
        isOccupied = true;
        break;
      }

      const releaseTime =
        order.expiredAtMs ||
        (order.verifiedAt ? new Date(order.verifiedAt).getTime() : order.expiresAtMs);
      if (releaseTime && t - releaseTime < SLOT_COOLDOWN_MS) {
        isOccupied = true;
        break;
      }
    }
    if (!isOccupied) return { payablePaise: candidatePaise, suffix: slot };
  }
  throw new Error("All dynamic slots are busy. Retry in 2 minutes.");
}

function decodeBase64Url(data) {
  if (!data) return "";
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf-8");
}

function cleanHtml(s = "") {
  return s
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(div|p|tr|td|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|\u00a0/gi, " ")
    .replace(/&#8377;|&#x20b9;|&inr;/gi, "₹")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function extractAllText(payload) {
  if (!payload) return "";
  let text = "";
  if (payload.body && payload.body.data) {
    const raw = decodeBase64Url(payload.body.data);
    text += (payload.mimeType === "text/html" ? cleanHtml(raw) : raw) + "\n";
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      text += extractAllText(part) + "\n";
    }
  }
  return cleanHtml(text);
}

const app = express();
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-vex-api-key, x-dashboard-admin-key");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});
app.use(express.json());

app.get("/", (req, res) => {
  return res.json({ ok: true, service: "VEX PAY Backend on Vercel" });
});

// ---------------- Google OAuth Handlers ----------------
app.get(["/auth/google", "/api/auth/google"], (req, res) => {
  const oauth2Client = getOAuthClient();
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/userinfo.email"
    ]
  });
  return res.redirect(authUrl);
});

app.get(["/oauth2callback", "/api/oauth2callback"], async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send("Authorization code missing");

  try {
    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);
    const db = getDb();

    await db.collection("gateway_config").doc("gmail_auth").set({
      tokens,
      connectedAt: new Date().toISOString()
    }, { merge: true });

    await db.collection("activity_logs").add({
      type: "info",
      message: "Gmail account connected successfully",
      at: new Date().toISOString()
    });

    return res.send(`
      <!DOCTYPE html>
      <html>
      <body style="font-family:sans-serif; background:#0b1020; color:#fff; display:flex; align-items:center; justify-content:center; height:100vh; margin:0;">
        <div style="background:#131b34; padding:40px; border-radius:14px; text-align:center;">
          <h2 style="color:#28c995;">✅ Gmail Connected!</h2>
          <a href="${FRONTEND_URL}" style="display:inline-block; margin-top:20px; padding:12px 24px; background:#6d8cff; color:#fff; text-decoration:none; border-radius:8px;">Go to Dashboard</a>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    return res.status(500).send("OAuth failed: " + err.message);
  }
});

// ---------------- Fast Dashboard API ----------------
app.get(["/api/dashboard", "/dashboard"], async (req, res) => {
  try {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    await triggerAutoSync(8000);
    const db = getDb();

    const [ordersSnap, appsSnap, logsSnap, webhooksSnap, authSnap, oldStoreSnap] = await Promise.all([
      db.collection("orders").orderBy("createdAtMs", "desc").limit(35).get(),
      db.collection("apps").get(),
      db.collection("activity_logs").orderBy("at", "desc").limit(20).get(),
      db.collection("webhook_events").orderBy("dispatchedAtMs", "desc").limit(25).get(),
      db.collection("gateway_config").doc("gmail_auth").get(),
      db.collection("vex_pay_gateway").doc("store_data").get()
    ]);

    const orders = ordersSnap.docs.map((d) => ({ ...d.data(), id: d.id }));
    const apps = appsSnap.docs.map((d) => ({ ...d.data(), id: d.id }));
    const logs = logsSnap.docs.map((d) => d.data());

    const events = webhooksSnap.docs.map((d) => {
      const data = d.data();
      const statusValue = data.deliveryStatus || data.delivery_status || data.status || "DELIVERED";
      const timeValue = data.dispatched_at || data.dispatchedAt || data.createdAt || "-";

      return {
        id: d.id,
        eventId: data.eventId || d.id,
        type: data.type || "payment.success",
        appId: data.appId || data.app_id || "APEX_GAMING_01",
        app_id: data.appId || data.app_id || "APEX_GAMING_01",
        status: statusValue,
        deliveryStatus: statusValue,
        delivery_status: statusValue,
        dispatchedAt: timeValue,
        dispatched_at: timeValue,
        createdAt: timeValue,
        ...data
      };
    });

    const isGmailConnected =
      (authSnap.exists && Boolean(authSnap.data()?.tokens)) ||
      (oldStoreSnap.exists && Boolean(oldStoreSnap.data()?.tokens));

    return res.json({
      orders,
      apps,
      events,
      logs,
      gmail: { connected: isGmailConnected }
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ---------------- Admin App Management ----------------
app.post(["/api/admin/apps", "/admin/apps"], async (req, res) => {
  try {
    const { name, webhookUrl } = req.body || {};
    if (!name) return res.status(400).json({ error: "App name is required" });

    const appId = id("APP");
    const apiKey = `vex_${crypto.randomBytes(24).toString("hex")}`;
    const webhookSecret = `whsec_${crypto.randomBytes(24).toString("hex")}`;

    const newApp = {
      id: appId,
      name: name.trim(),
      apiKeyHash: hash(apiKey),
      apiKeyHint: `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`,
      webhookSecret,
      webhookUrl: (webhookUrl || "").trim(),
      active: true,
      createdAt: new Date().toISOString()
    };

    const db = getDb();
    await db.collection("apps").doc(appId).set(newApp);

    await db.collection("activity_logs").add({
      type: "info",
      message: `Application created: ${newApp.name} (${appId})`,
      at: new Date().toISOString()
    });

    return res.json({ success: true, ...newApp, apiKey });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.put(["/api/admin/apps/:appId/webhook", "/admin/apps/:appId/webhook"], async (req, res) => {
  try {
    const { appId } = req.params;
    const { webhookUrl } = req.body || {};
    const db = getDb();
    await db.collection("apps").doc(appId).set({ webhookUrl: (webhookUrl || "").trim() }, { merge: true });
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.put(["/api/admin/apps/:appId/status", "/admin/apps/:appId/status"], async (req, res) => {
  try {
    const { appId } = req.params;
    const { active } = req.body || {};
    const db = getDb();
    await db.collection("apps").doc(appId).set({ active: Boolean(active) }, { merge: true });
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.post(["/api/admin/apps/:appId/rotate-credentials", "/admin/apps/:appId/rotate-credentials"], async (req, res) => {
  try {
    const { appId } = req.params;
    const apiKey = `vex_${crypto.randomBytes(24).toString("hex")}`;
    const webhookSecret = `whsec_${crypto.randomBytes(24).toString("hex")}`;
    const db = getDb();
    await db.collection("apps").doc(appId).set({
      apiKeyHash: hash(apiKey),
      apiKeyHint: `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`,
      webhookSecret
    }, { merge: true });
    return res.json({ success: true, apiKey, webhookSecret });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.delete(["/api/admin/apps/:appId", "/admin/apps/:appId"], async (req, res) => {
  try {
    const { appId } = req.params;
    const db = getDb();

    await db.collection("apps").doc(appId).delete();

    const matchingSnap = await db.collection("apps").where("id", "==", appId).get();
    for (const d of matchingSnap.docs) {
      await d.ref.delete();
    }

    await db.collection("activity_logs").add({
      type: "warning",
      message: `Application deleted: ${appId}`,
      at: new Date().toISOString()
    });

    return res.json({ success: true, deletedId: appId });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ---------------- Export Orders CSV ----------------
app.get(["/api/orders.csv", "/orders.csv"], async (req, res) => {
  try {
    const db = getDb();
    const snap = await db.collection("orders").orderBy("createdAtMs", "desc").limit(500).get();
    const cols = ["orderId", "appId", "appName", "appOrderId", "payableAmount", "slotIndex", "status", "utr", "createdAt", "verifiedAt"];
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [
      cols.join(","),
      ...snap.docs.map((d) => {
        const o = d.data();
        return cols.map((c) => esc(o[c])).join(",");
      })
    ].join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="vex-pay-orders.csv"');
    return res.send(rows);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ---------------- Create Order API ----------------
app.post(["/api/v1/orders", "/v1/orders"], async (req, res) => {
  try {
    const apiKey = req.headers["x-vex-api-key"];
    const db = getDb();

    if (!apiKey) {
      return res.status(401).json({
        success: false,
        error: "Missing API Key: Header 'x-vex-api-key' is required."
      });
    }

    const appSnap = await db.collection("apps")
      .where("apiKeyHash", "==", hash(apiKey))
      .where("active", "==", true)
      .limit(1)
      .get();

    if (appSnap.empty) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized: Invalid or disabled API Key."
      });
    }

    const appRecord = appSnap.docs[0].data();

    const { amount, app_order_id, customer_id, customer_name } = req.body || {};
    if (!amount || isNaN(amount) || Number(amount) <= 0) {
      return res.status(400).json({ success: false, error: "Invalid payment amount" });
    }

    const basePaise = Math.round(Number(amount) * 100);
    const allocation = await allocateSlot(basePaise);

    const createdAtMs = now();
    const expiresAtMs = createdAtMs + ORDER_EXPIRY_MS;
    const orderId = id("VEX");
    const payableFormatted = money(allocation.payablePaise);

    const cleanUser = (customer_name || customer_id || "User").replace(/[^a-zA-Z0-9 ]/g, "").trim();
    const transactionNote = `${cleanUser} Txn ${orderId}`;

    const upiIntentUrl = `upi://pay?pa=${MERCHANT_UPI_ID}&pn=${encodeURIComponent(MERCHANT_NAME)}&am=${payableFormatted}&cu=INR&tn=${encodeURIComponent(transactionNote)}`;
    const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(upiIntentUrl)}`;

    const newOrder = {
      orderId,
      appId: appRecord.id,
      appName: appRecord.name,
      webhookSecret: appRecord.webhookSecret,
      appOrderId: String(app_order_id || orderId),
      customerName: cleanUser,
      originalAmount: money(basePaise),
      payableAmount: payableFormatted,
      payablePaise: allocation.payablePaise,
      slotIndex: allocation.suffix,
      transactionNote,
      upiIntentUrl,
      qrImageUrl,
      createdAt: new Date(createdAtMs).toISOString(),
      createdAtMs,
      expiresAtMs,
      status: "PENDING",
      webhookUrl: appRecord.webhookUrl || ""
    };

    await db.collection("orders").doc(orderId).set(newOrder);

    return res.status(201).json({ success: true, order: newOrder });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

// ---------------- Order Status Check (Auto-Syncs Gmail!) ----------------
app.get(["/api/order-status", "/order-status"], async (req, res) => {
  const { orderId } = req.query;
  const db = getDb();

  let orderSnap = await db.collection("orders").doc(String(orderId || "")).get();
  let orderData = orderSnap.exists ? orderSnap.data() : null;

  if (!orderData && orderId) {
    const qSnap = await db.collection("orders").where("appOrderId", "==", String(orderId)).limit(1).get();
    if (!qSnap.empty) orderData = qSnap.docs[0].data();
  }

  if (!orderData) return res.status(404).json({ error: "Order not found" });

  if (orderData.status === "PENDING") {
    await triggerAutoSync(4000);
    const refreshedSnap = await db.collection("orders").doc(orderData.orderId).get();
    if (refreshedSnap.exists) {
      orderData = refreshedSnap.data();
    }
  }

  const isExpired = orderData.status === "PENDING" && now() > orderData.expiresAtMs;
  return res.json({
    success: true,
    orderId: orderData.orderId,
    status: isExpired ? "EXPIRED" : orderData.status,
    payableAmount: orderData.payableAmount,
    utr: orderData.utr || null,
    expiresAt: orderData.expiresAtMs
  });
});

// ---------------- Manual Sync Endpoint ----------------
app.all(["/api/sync", "/sync"], async (req, res) => {
  try {
    const result = await runGmailSync();
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ---------------- Payment Verification Engine (Strict Expiry Check) ----------------
async function runGmailSync() {
  const db = getDb();
  const t = now();

  // 1. Expire outdated orders first
  const pendingSnap = await db.collection("orders").where("status", "==", "PENDING").get();
  for (const doc of pendingSnap.docs) {
    const ord = doc.data();
    if (t > ord.expiresAtMs) {
      await doc.ref.update({ status: "EXPIRED", expiredAtMs: t });
    }
  }

  // 2. Get Gmail Auth Tokens
  let tokens = null;
  const authDoc = await db.collection("gateway_config").doc("gmail_auth").get();
  if (authDoc.exists && authDoc.data().tokens) {
    tokens = authDoc.data().tokens;
  } else {
    const oldSnap = await db.collection("vex_pay_gateway").doc("store_data").get();
    if (oldSnap.exists && oldSnap.data().tokens) {
      tokens = oldSnap.data().tokens;
    }
  }

  if (!tokens) {
    return { verifiedCount: 0, status: "Gmail not connected" };
  }

  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials(tokens);

  oauth2Client.on("tokens", async (refreshedTokens) => {
    await db.collection("gateway_config").doc("gmail_auth").set({
      tokens: { ...tokens, ...refreshedTokens }
    }, { merge: true });
  });

  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  const listRes = await gmail.users.messages.list({
    userId: "me",
    q: "from:paytm.com OR from:paytm newer_than:1d",
    maxResults: 20
  });

  const messages = listRes.data.messages || [];
  let verifiedCount = 0;

  const metaRef = db.collection("gateway_config").doc("seen_registry");
  const metaSnap = await metaRef.get();
  const seenIds = new Set(metaSnap.exists ? (metaSnap.data()?.ids || []) : []);

  for (const msg of messages) {
    if (seenIds.has(msg.id)) continue;

    const emailData = await gmail.users.messages.get({ userId: "me", id: msg.id, format: "full" });
    const emailTimestampMs = Number(emailData.data.internalDate) || Date.now();

    const headers = emailData.data.payload?.headers || [];
    const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value || "";
    const bodyContent = extractAllText(emailData.data.payload);
    const snippet = cleanHtml(emailData.data.snippet || "");

    const combinedText = `${subject}\n${snippet}\n${bodyContent}`;

    const amountRegex = /(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\.\d{1,2}|\.\d{1,2})?)/gi;
    const utrRegex = /(?:Order\s*ID|Transaction\s*ID|Txn\s*ID|Txn|UTR|UPI\s*Ref(?:\s*No)?|RRN)[:\s#-]*([A-Z0-9]{8,35})/i;

    const utrMatch = combinedText.match(utrRegex);
    const utr = utrMatch ? utrMatch[1] : `TXN_${msg.id.slice(0, 10).toUpperCase()}`;

    const extractedPaiseSet = new Set();
    let match;
    while ((match = amountRegex.exec(combinedText)) !== null) {
      const amtStr = match[1].replace(/,/g, "");
      const val = parseFloat(amtStr);
      if (Number.isFinite(val) && val > 0) {
        extractedPaiseSet.add(Math.round(val * 100));
      }
    }

    let matchedThisEmail = false;

    for (const amtPaise of extractedPaiseSet) {
      const orderMatches = await db.collection("orders")
        .where("payablePaise", "==", amtPaise)
        .where("status", "==", "PENDING")
        .get();

      for (const orderDoc of orderMatches.docs) {
        const targetOrder = orderDoc.data();
        const orderCreatedMs = Number(targetOrder.createdAtMs) || 0;
        const orderExpiresMs = Number(targetOrder.expiresAtMs) || (orderCreatedMs + ORDER_EXPIRY_MS);

        // ==========================================
        // STRICT EXPIRY TIME CHECK IMPLEMENTED HERE
        // ==========================================
        const strictBufferMs = 10000; // 10 seconds leeway for minor clock skews

        if (emailTimestampMs < (orderCreatedMs - strictBufferMs)) {
          // Email is older than order creation time
          continue;
        }

        if (emailTimestampMs > orderExpiresMs) {
          // Payment arrived AFTER order expiration -> EXPIRED & REJECTED!
          await orderDoc.ref.update({ status: "EXPIRED", expiredAtMs: t });
          continue;
        }
        // ==========================================

        const verifiedAt = new Date().toISOString();
        const verifiedAtMs = Date.now();

        await orderDoc.ref.update({
          status: "SUCCESS",
          verifiedAt,
          verifiedAtMs,
          utr
        });

        await db.collection("activity_logs").add({
          type: "success",
          message: `Strictly verified Order ${targetOrder.orderId} for ₹${targetOrder.payableAmount} (UTR: ${utr})`,
          at: verifiedAt
        });

        const webhookEventId = id("EVT");
        let deliveryStatus = "DELIVERED";

        if (targetOrder.webhookUrl) {
          try {
            const whRes = await fetch(targetOrder.webhookUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                event: "payment.success",
                orderId: targetOrder.orderId,
                appOrderId: targetOrder.appOrderId,
                amount: targetOrder.payableAmount,
                utr,
                timestamp: verifiedAt
              })
            });
            deliveryStatus = whRes.ok ? "DELIVERED" : `FAILED_${whRes.status}`;
          } catch (e) {
            deliveryStatus = "FAILED_NETWORK";
          }
        }

        await db.collection("webhook_events").doc(webhookEventId).set({
          eventId: webhookEventId,
          type: "payment.success",
          appId: targetOrder.appId,
          app_id: targetOrder.appId,
          orderId: targetOrder.orderId,
          amount: targetOrder.payableAmount,
          status: deliveryStatus,
          deliveryStatus: deliveryStatus,
          delivery_status: deliveryStatus,
          dispatchedAt: verifiedAt,
          dispatched_at: verifiedAt,
          dispatchedAtMs: verifiedAtMs,
          createdAt: verifiedAt
        });

        verifiedCount++;
        matchedThisEmail = true;
        break;
      }

      if (matchedThisEmail) break;
    }

    if (matchedThisEmail || (t - emailTimestampMs > 15 * 60 * 1000)) {
      seenIds.add(msg.id);
    }
  }

  const trimmed = Array.from(seenIds).slice(-150);
  await metaRef.set({ ids: trimmed });

  return { verifiedCount, scannedTotal: messages.length };
}

export default app;
