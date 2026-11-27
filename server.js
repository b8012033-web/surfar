const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const PLATFORM_API_URL = String(process.env.PLATFORM_API_URL || "").replace(/\/$/, "");
const BOT_TRIAL_SECRET = process.env.BOT_TRIAL_SECRET;
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || "7181451322";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const DATA_FILE = process.env.DATA_FILE || "/data/replies.json";
const PUBLIC_DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN;
const sessions = new Map();
const trialFlow = new Map();
const SESSION_TTL = 12 * 60 * 60 * 1000;

if (!BOT_TOKEN || !ADMIN_PASSWORD || !WEBHOOK_SECRET) {
  console.error("Missing required environment variables: BOT_TOKEN, ADMIN_PASSWORD, WEBHOOK_SECRET");
  process.exit(1);
}

function ensureStore() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ replies: [], defaultReply: "", photoReply: "", paymentPending: {}, paymentRecords: [], paymentAdminFlows: {} }, null, 2));
}
function readStore() {
  ensureStore();
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (!Array.isArray(data.replies)) data.replies = [];
    if (typeof data.defaultReply !== "string") data.defaultReply = "";
    if (typeof data.photoReply !== "string") data.photoReply = "";
    if (typeof data.businessOwnerId !== "string" && typeof data.businessOwnerId !== "number") data.businessOwnerId = "";
    if (!data.paymentPending || typeof data.paymentPending !== "object") data.paymentPending = {};
    if (!Array.isArray(data.paymentRecords)) data.paymentRecords = [];
    if (!data.paymentAdminFlows || typeof data.paymentAdminFlows !== "object") data.paymentAdminFlows = {};
    return data;
  } catch { return { replies: [], defaultReply: "", photoReply: "", paymentPending: {}, paymentRecords: [], paymentAdminFlows: {} }; }
}
function writeStore(data) {
  ensureStore();
  const temp = DATA_FILE + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  fs.renameSync(temp, DATA_FILE);
}
function safeEqual(a, b) {
  const aa = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function cookieToken(req) {
  const cookies = req.headers.cookie || "";
  const match = cookies.match(/(?:^|;\s*)drosak_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}
function requireAdmin(req, res, next) {
  const token = cookieToken(req);
  const expiry = sessions.get(token);
  if (!token || !expiry || expiry < Date.now()) {
    if (token) sessions.delete(token);
    return res.status(401).json({ error: "انتهت الجلسة، سجل الدخول مرة أخرى" });
  }
  sessions.set(token, Date.now() + SESSION_TTL);
  next();
}
async function telegram(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!result.ok) throw new Error(result.description || `Telegram ${method} failed`);
  return result.result;
}
function normalize(s) { return String(s || "").trim().toLocaleLowerCase(); }

function trialKey(message) {
  return `${message.business_connection_id}:${message.chat.id}`;
}
async function sendBusinessText(message, text, reply_markup) {
  const payload = { business_connection_id: message.business_connection_id, chat_id: message.chat.id, text };
  if (reply_markup) payload.reply_markup = reply_markup;
  return telegram("sendMessage", payload);
}
async function createTrialCode(name, section, telegramUserId) {
  if (!PLATFORM_API_URL || !BOT_TRIAL_SECRET) throw new Error("Trial integration is not configured");
  const response = await fetch(`${PLATFORM_API_URL}/api/bot/trial`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bot-trial-secret": BOT_TRIAL_SECRET },
    body: JSON.stringify({ name, section, telegramUserId: String(telegramUserId), hours: 1, maxDevices: 1 })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success || !data.code) {
    const error = new Error(data.error || `Platform trial API returned ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data.code;
}
async function handleTrialFlow(message, text) {
  const key = trialKey(message);
  const state = trialFlow.get(key);
  const normalized = normalize(text);
  if (!state) {
    // Recognize common Egyptian Arabic requests to start a free trial.
    const trialIntent =
      normalized.includes("تجرب") ||
      normalized.includes("تجريب") ||
      normalized.includes("اجرب") ||
      normalized.includes("جرب") ||
      normalized.includes("trial");
    if (trialIntent) {
      trialFlow.set(key, { step: "name", createdAt: Date.now() });
      await sendBusinessText(message, "🎉 أهلاً بيك في منصة دروسك بلس!\n\nعلشان نطلعلك كود التجربة المجانية لمدة ساعة، ابعت اسمك بالكامل.");
      return true;
    }
    return false;
  }
  if (Date.now() - state.createdAt > 15 * 60 * 1000) {
    trialFlow.delete(key);
    await sendBusinessText(message, "انتهت مهلة طلب التجربة. ابعت «تجربة» وابدأ من جديد.");
    return true;
  }
  if (state.step === "name") {
    const name = text.trim().slice(0, 100);
    if (name.length < 2) {
      await sendBusinessText(message, "اكتب اسمك بشكل صحيح من فضلك.");
      return true;
    }
    state.name = name;
    state.step = "section";
    state.createdAt = Date.now();
    trialFlow.set(key, state);
    await sendBusinessText(message, "اختار شعبتك أو ابعتها كتابةً: علمي علوم، علمي رياضة، أدبي، أو أزهر.");
    return true;
  }
  if (state.step === "section") {
    const section = text.trim().slice(0, 80);
    if (section.length < 2) {
      await sendBusinessText(message, "ابعت اسم الشعبة بشكل صحيح.");
      return true;
    }
    trialFlow.delete(key);
    try {
      const code = await createTrialCode(state.name, section, message.from?.id);
      const fullMessage = `🎉 أهلاً بيك في منصة دروسك بلس!\n\n👤 الاسم: ${state.name}\n📚 الشعبة: ${section}\n🔑 كود الدخول: ${code}\n\n🌟 هذا كود ساعة واحدة.\n\n💙 متنساش إن كل المدرسين اللي هتشوفهم في المنصة بـ200ج في الشهر.\n⭐ متنساش تقولنا رأيك في المنصة وتقول لأصحابك.\n\n🌐 رابط الدخول للمنصة:\nhttps://www.durosakplus.com/`;
      await sendBusinessText(message, fullMessage, {
        inline_keyboard: [[{ text: "📋 نسخ الكود", copy_text: { text: code } }]]
      });
    } catch (err) {
      console.error("Trial code creation failed:", err.message);
      if (err.status === 409) {
        await sendBusinessText(message, "معلش يا بطل ❤️\nإنت جربت قبل كده، والتجربة المجانية بتكون مرة واحدة بس لكل حساب، فمش هينفع تجرب تاني للأسف.\n\nهيبقى لازم تشترك. قولي بقى إنت عاوز تشترك في أنهي باقة؟");
      } else {
        await sendBusinessText(message, "حصلت مشكلة أثناء إنشاء كود التجربة. جرّب بعد قليل أو تواصل مع الدعم.");
      }
    }
    return true;
  }
  trialFlow.delete(key);
  return false;
}

async function getTelegramPhotoBuffer(fileId) {
  const file = await telegram("getFile", { file_id: fileId });
  if (!file.file_path) throw new Error("Telegram file path missing");
  const response = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`);
  if (!response.ok) throw new Error(`Photo download failed: ${response.status}`);
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > 8 * 1024 * 1024) throw new Error("Photo too large");
  return Buffer.from(arrayBuffer);
}

// Estimates receipt-likeness only; it cannot prove payment or reliably detect edits.
async function analyzePaymentImage(buffer) {
  if (!OPENAI_API_KEY) return { isReceipt: null, confidence: 0, provider: "غير محدد", warnings: "تحليل الصور غير مفعّل" };
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Analyze whether the image visually resembles an Egyptian payment/transfer receipt. It may be from InstaPay, Vodafone Cash, Orange Cash, Etisalat Cash, Fawry, an app screenshot, or a photo of another phone screen. Return JSON keys is_receipt (boolean), confidence (number 0-100), provider (short Arabic string), visible_reference (string or empty), visual_warnings (short Arabic string). Confidence means visual resemblance to a receipt ONLY, not payment authenticity. Never claim payment is genuine or Photoshop-free; an image alone cannot prove that." },
        { role: "user", content: [{ type: "text", text: "صنّف الصورة كإيصال تحويل محتمل أو صورة عادية، واذكر علامات عدم الوضوح أو الاشتباه الظاهرة فقط." }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${buffer.toString("base64")}`, detail: "high" } }] }
      ],
      max_tokens: 300
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Image analysis failed ${response.status}`);
  const parsed = JSON.parse(data.choices?.[0]?.message?.content || "{}");
  return {
    isReceipt: Boolean(parsed.is_receipt),
    confidence: Math.max(0, Math.min(100, Number(parsed.confidence) || 0)),
    provider: String(parsed.provider || "غير محدد").slice(0, 80),
    visibleReference: String(parsed.visible_reference || "").slice(0, 120),
    warnings: String(parsed.visual_warnings || "").slice(0, 400)
  };
}


function findPaymentRecord(store, id) {
  return store.paymentRecords.find(r => String(r.id) === String(id));
}
async function notifyAdminPayment(record, photoFileId, duplicate) {
  const duplicateText = duplicate
    ? `\n🚨 تنبيه تكرار: نفس الصورة أو مرجع العملية سبق تسجيله. راجع الطلب قبل الموافقة.`
    : "";
  const caption = `📥 طلب مراجعة تحويل جديد\n🧾 رقم الطلب: ${record.id}\n👤 الاسم: ${record.name || "غير متوفر"}\n📚 الشعبة: ${record.section || "غير متوفر"}\n📱 رقم التحويل منه: ${record.senderPhone || "غير متوفر"}\n🆔 Telegram ID: ${record.telegramUserId}\n🔢 مرجع العملية الظاهر: ${record.visibleReference || "غير ظاهر"}\n🏦 المصدر الظاهر: ${record.provider || "غير محدد"}\n🖼️ تشابه الصورة مع إيصال: ${record.receiptConfidence || 0}% (ليس إثباتًا لصحة الدفع)\n⚠️ ملاحظات الصورة: ${record.visualWarnings || "لا توجد"}${duplicateText}\n\nتأكد من وصول المبلغ فعليًا قبل تفعيل الاشتراك.`;
  const reply_markup = { inline_keyboard: [[
    { text: "✅ تم الاستلام", callback_data: `pay:received:${record.id}` },
    { text: "❌ لم يتم الاستلام", callback_data: `pay:missing:${record.id}` }
  ]] };
  let sent;
  try {
    sent = await telegram("sendPhoto", { chat_id: ADMIN_TELEGRAM_ID, photo: photoFileId, caption: caption.slice(0, 1000), reply_markup });
  } catch (err) {
    console.error("Admin payment photo notification failed:", err.message);
    sent = await telegram("sendMessage", { chat_id: ADMIN_TELEGRAM_ID, text: caption.slice(0, 3900), reply_markup });
  }
  if (sent?.message_id) {
    const store = readStore();
    const saved = findPaymentRecord(store, record.id);
    if (saved) { saved.adminMessageId = sent.message_id; writeStore(store); }
  }
}
async function handlePaymentPhoto(message) {
  const bestPhoto = message.photo?.[message.photo.length - 1];
  if (!bestPhoto?.file_id) return;
  const key = trialKey(message);
  try {
    const buffer = await getTelegramPhotoBuffer(bestPhoto.file_id);
    const imageHash = crypto.createHash("sha256").update(buffer).digest("hex");
    let analysis = { isReceipt: null, confidence: 0, provider: "غير محدد", warnings: "", visibleReference: "" };
    try { analysis = await analyzePaymentImage(buffer); }
    catch (err) { console.warn("Payment image analysis skipped:", err.message); }
    const store = readStore();
    store.paymentPending[key] = {
      fileId: bestPhoto.file_id, imageHash,
      receiptConfidence: analysis.confidence || 0,
      provider: analysis.provider || "غير محدد",
      visualWarnings: analysis.warnings || "",
      visibleReference: analysis.visibleReference || "",
      businessConnectionId: message.business_connection_id,
      chatId: String(message.chat.id),
      name: "",
      telegramUserId: String(message.from?.id || message.chat.id),
      step: "phone",
      createdAt: Date.now()
    };
    writeStore(store);
    await sendBusinessText(message, "✅ تمام، وصلتني صورة التحويل.\n\nمحتاج الرقم اللي حولت منه الفلوس، وبعده هطلب اسمك وشعبتك.\n\n📱 ابعت رقم الهاتف اللي تم التحويل منه.");
  } catch (err) {
    console.error("Payment image processing failed:", err.message);
    await sendBusinessText(message, "📩 وصلت الصورة، لكن حصلت مشكلة في حفظها للمراجعة. جرّب إرسالها مرة أخرى بعد قليل.");
  }
}
async function handlePaymentForm(message, text) {
  const key = trialKey(message);
  const store = readStore();
  const pending = store.paymentPending[key];
  if (!pending || Date.now() - pending.createdAt > 24 * 60 * 60 * 1000) {
    if (pending) { delete store.paymentPending[key]; writeStore(store); }
    return false;
  }
  const value = String(text || "").trim().slice(0, 150);
  if (pending.step === "phone") {
    const digits = value.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15) {
      await sendBusinessText(message, "رقم الهاتف مش واضح. ابعت رقم الهاتف اللي حولت منه الفلوس بشكل صحيح.");
      return true;
    }
    pending.senderPhone = value;
    pending.step = "name";
    pending.createdAt = Date.now();
    store.paymentPending[key] = pending; writeStore(store);
    await sendBusinessText(message, "👤 تمام، ابعت اسمك بالكامل.");
    return true;
  }
  if (pending.step === "name") {
    if (value.length < 2) {
      await sendBusinessText(message, "اكتب اسمك بالكامل بشكل صحيح.");
      return true;
    }
    pending.name = value.slice(0, 100);
    pending.step = "section";
    pending.createdAt = Date.now();
    store.paymentPending[key] = pending; writeStore(store);
    await sendBusinessText(message, "🎓 ابعت شعبتك، مثال: علمي علوم أو علمي رياضة أو أدبي أو أزهر.");
    return true;
  }
  if (pending.step === "section") {
    if (value.length < 2) {
      await sendBusinessText(message, "ابعت اسم الشعبة بشكل صحيح.");
      return true;
    }
    const duplicate = store.paymentRecords.find(r =>
      (pending.imageHash && r.imageHash === pending.imageHash) ||
      (pending.visibleReference && r.visibleReference && String(r.visibleReference).trim() === String(pending.visibleReference).trim())
    );
    const record = {
      id: crypto.randomUUID(),
      name: pending.name,
      section: value.slice(0, 80),
      senderPhone: pending.senderPhone,
      telegramUserId: pending.telegramUserId,
      businessConnectionId: pending.businessConnectionId,
      chatId: pending.chatId,
      imageHash: pending.imageHash,
      visibleReference: pending.visibleReference || "",
      provider: pending.provider || "غير محدد",
      receiptConfidence: pending.receiptConfidence || 0,
      visualWarnings: pending.visualWarnings || "",
      duplicate: Boolean(duplicate),
      status: "pending_review",
      createdAt: new Date().toISOString()
    };
    store.paymentRecords.push(record);
    if (store.paymentRecords.length > 2000) store.paymentRecords.splice(0, store.paymentRecords.length - 2000);
    delete store.paymentPending[key];
    writeStore(store);
    await notifyAdminPayment(record, pending.fileId, duplicate);
    await sendBusinessText(message, "✅ تمام، وصلتني صورة التحويل بكل تفاصيلها.\n\nتم إرسال بياناتك للإدارة للمراجعة والتأكد من وصول المبلغ.\n\n⏳ الرجاء عدم إرسال أي رسائل أخرى، وسيتم الرد عليك في أسرع وقت.\n\n💙 شكرًا لاشتراكك في دروسك بلس.");
    return true;
  }
  return false;
}
async function callPlatformPaymentApproval(record, duration) {
  if (!PLATFORM_API_URL || !BOT_TRIAL_SECRET) throw new Error("تكامل إصدار الاشتراك غير مضبوط");
  const response = await fetch(`${PLATFORM_API_URL}/api/bot/payment/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bot-trial-secret": BOT_TRIAL_SECRET },
    body: JSON.stringify({
      requestId: record.id,
      name: record.name,
      section: record.section,
      phone: record.senderPhone,
      telegramUserId: record.telegramUserId,
      duration,
      adminTelegramId: String(ADMIN_TELEGRAM_ID)
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success || !data.code) throw new Error(data.error || `Platform API returned ${response.status}`);
  return data;
}
async function finishPaymentApproval(record, duration) {
  const result = await callPlatformPaymentApproval(record, duration);
  const store = readStore();
  const saved = findPaymentRecord(store, record.id);
  if (saved) {
    saved.status = "approved";
    saved.approvedAt = new Date().toISOString();
    saved.studentCode = result.code;
    saved.subscriptionExpiresAt = result.expiresAt || null;
    saved.subscriptionAction = result.action || "created";
    saved.durationLabel = result.durationLabel || duration.type || "مخصص";
  }
  delete store.paymentAdminFlows[String(ADMIN_TELEGRAM_ID)];
  writeStore(store);
  const studentMessage = {
    business_connection_id: record.businessConnectionId,
    chat: { id: Number(record.chatId) || record.chatId }
  };
  await sendBusinessText(studentMessage, `🎉 تم تأكيد استلام التحويل وتفعيل اشتراكك في دروسك بلس.\n\n👤 الاسم: ${record.name}\n📚 الشعبة: ${record.section}\n🔑 كود الدخول: ${result.code}\n📅 مدة الاشتراك: ${result.durationLabel || "حسب المدة المحددة"}\n🗓️ تاريخ الانتهاء: ${result.expiresAtText || "ظاهر داخل المنصة"}\n\n💙 نتمنى لك التوفيق!`);
  await telegram("sendMessage", { chat_id: ADMIN_TELEGRAM_ID, text: `✅ تم تفعيل الاشتراك بنجاح.\nالطالب: ${record.name}\nالكود: ${result.code}\nالعملية: ${result.action || "إصدار/تجديد"}\nالمدة: ${result.durationLabel || duration.type}\nتاريخ الانتهاء: ${result.expiresAtText || result.expiresAt || "—"}` });
}
async function handlePaymentAdminText(message, text) {
  if (String(message.from?.id) !== String(ADMIN_TELEGRAM_ID)) return false;
  const store = readStore();
  const flow = store.paymentAdminFlows[String(ADMIN_TELEGRAM_ID)];
  if (!flow && message.reply_to_message?.message_id) {
    const repliedRecord = store.paymentRecords.find(r => Number(r.adminMessageId) === Number(message.reply_to_message.message_id));
    const normalizedText = normalize(text);
    if (repliedRecord && repliedRecord.status === "pending_review" && (normalizedText === "تم الاستلام" || normalizedText.includes("تم الاستلام") && !normalizedText.includes("لم يتم الاستلام"))) {
      repliedRecord.status = "awaiting_duration";
      repliedRecord.reviewedAt = new Date().toISOString();
      store.paymentAdminFlows[String(ADMIN_TELEGRAM_ID)] = { recordId: repliedRecord.id, step: "duration", createdAt: Date.now() };
      writeStore(store);
      await telegram("sendMessage", { chat_id: ADMIN_TELEGRAM_ID, text: `✅ تم تأكيد استلام التحويل.
الطالب: ${repliedRecord.name}
الشعبة: ${repliedRecord.section}

حدد مدة الاشتراك:`, reply_markup: { inline_keyboard: [
        [{ text: "شهر", callback_data: `pay:duration:${repliedRecord.id}:month` }, { text: "سنة", callback_data: `pay:duration:${repliedRecord.id}:year` }],
        [{ text: "أيام مخصصة", callback_data: `pay:duration:${repliedRecord.id}:days` }, { text: "حتى تاريخ", callback_data: `pay:duration:${repliedRecord.id}:date` }]
      ]}});
      return true;
    }
    if (repliedRecord && repliedRecord.status === "pending_review" && (normalizedText.includes("لم يتم الاستلام") || normalizedText.includes("لم يصل"))) {
      repliedRecord.status = "payment_not_received";
      repliedRecord.reviewedAt = new Date().toISOString();
      writeStore(store);
      await sendBusinessText({ business_connection_id: repliedRecord.businessConnectionId, chat: { id: Number(repliedRecord.chatId) || repliedRecord.chatId } }, `❌ لم يتم تأكيد وصول التحويل حتى الآن.\n\nيرجى مراجعة بيانات التحويل والتواصل مع الإدارة إذا كنت ترى أن هناك خطأ.`);
      await telegram("sendMessage", { chat_id: ADMIN_TELEGRAM_ID, text: `تم تسجيل عدم الاستلام للطلب ${repliedRecord.id} (${repliedRecord.name}).` });
      return true;
    }
  }
  if (!flow) return false;
  const record = findPaymentRecord(store, flow.recordId);
  if (!record) {
    delete store.paymentAdminFlows[String(ADMIN_TELEGRAM_ID)]; writeStore(store);
    await telegram("sendMessage", { chat_id: ADMIN_TELEGRAM_ID, text: "الطلب غير موجود أو انتهت صلاحيته." });
    return true;
  }
  if (flow.step === "days") {
    const days = Number(String(text).trim());
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      await telegram("sendMessage", { chat_id: ADMIN_TELEGRAM_ID, text: "اكتب عدد أيام صحيح من 1 إلى 3650." });
      return true;
    }
    try { await finishPaymentApproval(record, { type: "days", days }); }
    catch (e) { await telegram("sendMessage", { chat_id: ADMIN_TELEGRAM_ID, text: `تعذر تفعيل الاشتراك: ${e.message}` }); }
    return true;
  }
  if (flow.step === "date") {
    const raw = String(text).trim();
    const match = raw.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
    if (!match) {
      await telegram("sendMessage", { chat_id: ADMIN_TELEGRAM_ID, text: "اكتب التاريخ بصيغة يوم/شهر/سنة، مثال: 1/4/2027" });
      return true;
    }
    const date = `${match[3]}-${String(match[2]).padStart(2,"0")}-${String(match[1]).padStart(2,"0")}`;
    const check = new Date(`${date}T23:59:59+02:00`);
    if (Number.isNaN(check.getTime()) || check.getDate() !== Number(match[1]) || check.getMonth() + 1 !== Number(match[2]) || check.getFullYear() !== Number(match[3]) || check.getTime() <= Date.now()) {
      await telegram("sendMessage", { chat_id: ADMIN_TELEGRAM_ID, text: "التاريخ غير صحيح أو انتهى. ابعت تاريخًا مستقبليًا بصيغة يوم/شهر/سنة." });
      return true;
    }
    try { await finishPaymentApproval(record, { type: "date", date }); }
    catch (e) { await telegram("sendMessage", { chat_id: ADMIN_TELEGRAM_ID, text: `تعذر تفعيل الاشتراك: ${e.message}` }); }
    return true;
  }
  return false;
}
async function handlePaymentCallback(query) {
  const adminId = String(query.from?.id || "");
  if (adminId !== String(ADMIN_TELEGRAM_ID)) {
    await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "هذا الزر مخصص للإدارة فقط.", show_alert: true });
    return;
  }
  const parts = String(query.data || "").split(":");
  const action = parts[1];
  const recordId = parts[2];
  const store = readStore();
  const record = findPaymentRecord(store, recordId);
  if (!record) {
    await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "الطلب غير موجود." });
    return;
  }
  if (action === "missing") {
    if (record.status !== "pending_review") {
      await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "تم التعامل مع الطلب بالفعل." });
      return;
    }
    record.status = "payment_not_received";
    record.reviewedAt = new Date().toISOString();
    writeStore(store);
    await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "تم تسجيل عدم الاستلام." });
    await sendBusinessText({ business_connection_id: record.businessConnectionId, chat: { id: Number(record.chatId) || record.chatId } }, "❌ لم يتم تأكيد وصول التحويل حتى الآن.\n\nيرجى مراجعة بيانات التحويل والتواصل مع الإدارة إذا كنت ترى أن هناك خطأ.");
    await telegram("sendMessage", { chat_id: ADMIN_TELEGRAM_ID, text: `تم تسجيل أن التحويل لم يصل للطلب ${record.id} (${record.name}).` });
    return;
  }
  if (action === "received") {
    if (record.status !== "pending_review") {
      await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "تم التعامل مع الطلب بالفعل." });
      return;
    }
    record.status = "awaiting_duration";
    record.reviewedAt = new Date().toISOString();
    store.paymentAdminFlows[String(ADMIN_TELEGRAM_ID)] = { recordId: record.id, step: "duration", createdAt: Date.now() };
    writeStore(store);
    await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "تم تأكيد الاستلام. حدد مدة الاشتراك." });
    await telegram("sendMessage", {
      chat_id: ADMIN_TELEGRAM_ID,
      text: `✅ تم تأكيد استلام التحويل.\nالطالب: ${record.name}\nالشعبة: ${record.section}\n\nحدد مدة الاشتراك:`,
      reply_markup: { inline_keyboard: [
        [{ text: "شهر", callback_data: `pay:duration:${record.id}:month` }, { text: "سنة", callback_data: `pay:duration:${record.id}:year` }],
        [{ text: "أيام مخصصة", callback_data: `pay:duration:${record.id}:days` }, { text: "حتى تاريخ", callback_data: `pay:duration:${record.id}:date` }]
      ]}
    });
    return;
  }
  if (action === "duration") {
    const mode = parts[3];
    const flow = store.paymentAdminFlows[String(ADMIN_TELEGRAM_ID)];
    if (record.status !== "awaiting_duration" || !flow || flow.recordId !== record.id) {
      await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "اختار مدة الاشتراك من طلب قيد المراجعة." });
      return;
    }
    await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "تم اختيار المدة." });
    if (mode === "month" || mode === "year") {
      try { await finishPaymentApproval(record, { type: mode }); }
      catch (e) { await telegram("sendMessage", { chat_id: ADMIN_TELEGRAM_ID, text: `تعذر تفعيل الاشتراك: ${e.message}` }); }
    } else if (mode === "days") {
      flow.step = "days"; store.paymentAdminFlows[String(ADMIN_TELEGRAM_ID)] = flow; writeStore(store);
      await telegram("sendMessage", { chat_id: ADMIN_TELEGRAM_ID, text: "✏️ ابعت عدد الأيام المطلوبة (من 1 إلى 3650)." });
    } else if (mode === "date") {
      flow.step = "date"; store.paymentAdminFlows[String(ADMIN_TELEGRAM_ID)] = flow; writeStore(store);
      await telegram("sendMessage", { chat_id: ADMIN_TELEGRAM_ID, text: "📆 ابعت تاريخ انتهاء الاشتراك بصيغة يوم/شهر/سنة، مثال: 1/4/2027" });
    }
  }
}

async function handleBusinessMessage(message) {
  if (!message || !message.business_connection_id || !message.chat) return;
  if (message.from && message.from.is_bot) return;
  const ownerId = readStore().businessOwnerId;
  if (ownerId && message.from && String(message.from.id) === String(ownerId)) return;
  const store = readStore();
  if (Array.isArray(message.photo) && message.photo.length) {
    await handlePaymentPhoto(message);
    return;
  }
  if (!message.text) return;
  const text = message.text.trim();
  if (!text || text.startsWith("/")) return;
  if (await handlePaymentForm(message, text)) return;
  if (await handleTrialFlow(message, text)) return;
  const found = store.replies.filter(r => r.enabled !== false && r.keyword && normalize(text).includes(normalize(r.keyword)))
    .sort((a, b) => normalize(b.keyword).length - normalize(a.keyword).length)[0];
  const reply = found ? found.reply : store.defaultReply;
  if (!reply || !reply.trim()) return;
  await telegram("sendMessage", { business_connection_id: message.business_connection_id, chat_id: message.chat.id, text: reply });
}
async function handleRegularMessage(message) {
  if (!message || !message.from || message.from.is_bot) return;
  if (String(message.from.id) !== String(ADMIN_TELEGRAM_ID) || !message.text) return;
  await handlePaymentAdminText(message, message.text.trim());
}

app.get("/", (_req, res) => res.send("Drosak Plus Auto Reply is running."));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/admin", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.post("/api/login", (req, res) => {
  const username = String(req.body?.username || "");
  const password = String(req.body?.password || "");
  if (!safeEqual(username, ADMIN_USER) || !safeEqual(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ error: "اسم المستخدم أو كلمة المرور غير صحيحة" });
  }
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + SESSION_TTL);
  res.cookie("drosak_session", token, { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: SESSION_TTL });
  res.json({ ok: true, username: ADMIN_USER });
});
app.get("/api/session", (req, res) => {
  const token = cookieToken(req); const expiry = sessions.get(token);
  if (!token || !expiry || expiry < Date.now()) return res.status(401).json({ authenticated: false });
  sessions.set(token, Date.now() + SESSION_TTL);
  res.json({ authenticated: true, username: ADMIN_USER });
});
app.post("/api/logout", (req, res) => {
  sessions.delete(cookieToken(req));
  res.clearCookie("drosak_session", { httpOnly: true, secure: true, sameSite: "strict", path: "/" });
  res.json({ ok: true });
});

app.post(`/telegram/webhook/${WEBHOOK_SECRET}`, async (req, res) => {
  if (req.headers["x-telegram-bot-api-secret-token"] !== WEBHOOK_SECRET) return res.sendStatus(403);
  res.sendStatus(200);
  try {
    const update = req.body || {};
    // Telegram sends business_connection updates containing the owner's Telegram user ID.
    // Save it so outgoing messages written by the account owner are never auto-replied to.
    if (update.business_connection?.user?.id) {
      const store = readStore();
      store.businessOwnerId = String(update.business_connection.user.id);
      writeStore(store);
    }
    if (update.business_message) await handleBusinessMessage(update.business_message);
    if (update.message) await handleRegularMessage(update.message);
    if (update.callback_query) await handlePaymentCallback(update.callback_query);
  } catch (err) { console.error("Update handling error:", err.message); }
});

app.use("/api", (req, res, next) => {
  if (["/login", "/session", "/logout"].includes(req.path)) return next();
  return requireAdmin(req, res, next);
});
app.get("/api/replies", (_req, res) => res.json(readStore()));
app.put("/api/replies", (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.replies)) return res.status(400).json({ error: "replies must be an array" });
  const replies = body.replies.map(r => ({
    id: String(r.id || Date.now() + Math.random().toString(16).slice(2)),
    keyword: String(r.keyword || "").trim().slice(0, 100),
    reply: String(r.reply || "").trim().slice(0, 4000),
    enabled: r.enabled !== false
  })).filter(r => r.keyword && r.reply);
  const defaultReply = String(body.defaultReply || "").trim().slice(0, 4000);
  const photoReply = String(body.photoReply || "").trim().slice(0, 4000);
  const previous = readStore();
  writeStore({ replies, defaultReply, photoReply, businessOwnerId: previous.businessOwnerId || "", paymentPending: previous.paymentPending || {}, paymentRecords: previous.paymentRecords || [], paymentAdminFlows: previous.paymentAdminFlows || {} });
  res.json({ ok: true, count: replies.length });
});

app.listen(PORT, async () => {
  console.log(`Auto reply server listening on ${PORT}`);
  ensureStore();
  if (PUBLIC_DOMAIN) {
    try {
      await telegram("setWebhook", {
        url: `https://${PUBLIC_DOMAIN}/telegram/webhook/${WEBHOOK_SECRET}`,
        secret_token: WEBHOOK_SECRET,
        allowed_updates: ["business_message", "business_connection", "message", "callback_query"]
      });
      console.log("Telegram webhook configured.");
    } catch (err) { console.error("Could not configure Telegram webhook:", err.message); }
  } else console.warn("RAILWAY_PUBLIC_DOMAIN is not set; configure a Railway public domain and redeploy.");
});
process.on("uncaughtException", err => console.error(err));
process.on("unhandledRejection", err => console.error(err));
