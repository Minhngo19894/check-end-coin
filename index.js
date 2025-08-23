require('dotenv').config();
const express = require("express");
const bodyParser = require("body-parser");
const puppeteer = require("puppeteer");
const cron = require("node-cron");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const filePath = path.join(__dirname, "monitoredLinks.json");

const app = express();
const PORT = 3000;
const nodemailer = require('nodemailer');
app.use(bodyParser.json());
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS
  }
});
let isSent;

async function sendEmails(coin, emails, url) {
  if (!emails || !emails.length) return;
  try {
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: emails.join(","),
      subject: coin ? `${coin} Đã kết thúc` : 'Server hết ram khởi động lại đi',
      text: `${url}`
    });
    console.log("Email sent to", emails);
    if (!coin) {
      isSent = true
    }
  } catch (err) {
    console.error("Email error:", err.message);
  }
}

app.use(cors({
  origin: "*",                // Cho phép tất cả domain
  methods: ["GET", "POST"],    // Cho phép method nào
  allowedHeaders: ["Content-Type", "Authorization"]
}));
// Cho phép mọi origin (kể cả file://)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  next();
});

// Danh sách link cần theo dõi
let monitoredLinks = [];

if (fs.existsSync(filePath)) {
  try {
    monitoredLinks = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    console.error("Error reading monitoredLinks.json", e);
  }
}

function saveLinks() {
  fs.writeFileSync(filePath, JSON.stringify(monitoredLinks, null, 2));
}
/**
 * Crawl 1 link
 */

let browser;
let crawlCount = 0;

// Khởi tạo hoặc lấy browser đang mở
async function getBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--no-zygote",
        "--single-process",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-default-apps",
        "--disable-sync",
        "--disable-translate"
      ]
    });
  }
  return browser;
}
async function resetBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
    crawlCount = 0;
    console.log("♻️ Browser reset để giải phóng RAM");
  }
}
async function crawlLink(url, emails) {
  let status = "Không lấy được";
  let coin = "";
  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    crawlCount++;

    // Chặn resource không cần thiết
    await page.setRequestInterception(true);
    const blockedTypes = ["image", "stylesheet", "font", "media", "other"];
    page.on("request", req => {
      if (blockedTypes.includes(req.resourceType())) {
        if (!req.isInterceptResolutionHandled()) req.abort();
      } else {
        if (!req.isInterceptResolutionHandled()) req.continue();
      }
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Lấy status
    status = await page
      .$eval("div.v2_statusTag-activity__44BHZ span", el => el.textContent.trim())
      .catch(() => status);

    // Lấy coin
    coin = await page
      .$eval("div.v2_title-activity___S0uO span", el => el.textContent.trim())
      .catch(() => coin);

  } catch (e) {
    console.error("Crawl error:", e.message);
  } finally {
    if (page) await page.close();
  }

  // Reset browser sau 50 lần crawl (có thể chỉnh số khác)
  if (crawlCount >= 50) {
    await resetBrowser();
  }

  return { status, coin };
}



/**
 * API thêm link mới + email
 */
app.post("/add-links", (req, res) => {
  const { urls } = req.body;
  if (!urls || !Array.isArray(urls)) return res.status(400).json({ error: "urls phải là mảng" });
  for (let item of urls) {
    const { url, emails } = item;
    if (!url || !emails || !Array.isArray(emails)) continue;
    const exist = monitoredLinks.find(l => l.url === url);
    if (exist) exist.emails = Array.from(new Set([...exist.emails, ...emails]));
    else monitoredLinks.push({ url, emails, status: "Chưa kiểm tra", lastChecked: null, active: true });
  }
  res.json({ message: "Đã thêm link", monitoredLinks });
  saveLinks();

});

app.post("/remove-link", async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: "Cần nhập url" });
  }

  const index = monitoredLinks.findIndex(l => l.url === url);
  if (index === -1) {
    return res.status(404).json({ error: "Không tìm thấy link" });
  }

  monitoredLinks.splice(index, 1);

  res.json({ message: `Đã xoá link ${url}`, monitoredLinks });
  saveLinks();

});

app.post("/add-email", (req, res) => {
  const { url, email } = req.body;
  if (!url || !email) return res.status(400).json({ error: "Cần url và email" });
  const link = monitoredLinks.find(l => l.url === url);
  if (!link) return res.status(404).json({ error: "Không tìm thấy URL" });
  if (!link.emails.includes(email)) link.emails.push(email);
  res.json({ message: `Đã thêm email ${email}`, emails: link.emails });
  saveLinks();

});

/**
 * API lấy danh sách link
 */
app.get("/status", (req, res) => {
  res.json(monitoredLinks);
});

// Cron job mỗi phút
cron.schedule("* * * * *", async () => {
  console.log("⏳ Cron chạy...");

  for (let link of monitoredLinks) {
    if (!link.active) continue; // nếu đã kết thúc thì bỏ qua

    // random delay 1–20 giây
    const delay = Math.floor(Math.random() * 20) + 1;
    console.log(`⏲ Đợi ${delay}s trước khi check ${link.url}...`);
    await new Promise(r => setTimeout(r, delay * 1000));

    const { status, coin } = await crawlLink(link.url, link.emails);
    link.status = status;
    link.coin = coin;
    link.lastChecked = new Date().toLocaleString();

    console.log(`✔ ${link.url}: ${status}`);

    if (status === "Đã kết thúc") {
      link.active = false; // không theo dõi nữa
      console.log(`🛑 Ngừng theo dõi: ${link.url}`);

      sendEmails(coin, link.emails, link.url);
    }
  }
});


process.on('SIGINT', async () => {
  if (browser) await browser.close();
  process.exit();
});

app.listen(PORT, () => {
  console.log(`🚀 Server chạy tại http://localhost:${PORT}`);
});

setTimeout(() => {
  console.log("Restarting app to clear RAM...");
  isSent = false;
  process.exit(1); // Railway sẽ auto restart container
  

}, 30 * 60 * 1000);

