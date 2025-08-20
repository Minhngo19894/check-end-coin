require('dotenv').config();
const express = require("express");
const bodyParser = require("body-parser");
const puppeteer = require("puppeteer");
const cron = require("node-cron");
const cors = require("cors");
const nodemailer = require('nodemailer');
const pLimit = require("p-limit");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(cors({ origin: "*", methods: ["GET","POST"], allowedHeaders: ["Content-Type","Authorization"] }));

let monitoredLinks = [];

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS
  }
});

async function sendEmails(coin, emails, url) {
  if (!emails || !emails.length) return;
  try {
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: emails.join(","),
      subject: `${coin} Đã kết thúc`,
      text: `${url}`
    });
    console.log("Email sent to", emails);
  } catch (err) {
    console.error("Email error:", err.message);
  }
}

let browser;
async function getBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox","--disable-setuid-sandbox"]
    });
  }
  return browser;
}

async function crawlLink(url) {
  let status = "Không lấy được";
  let coin = "";
  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", req => {
      if (["image","stylesheet","font"].includes(req.resourceType())) req.abort();
      else req.continue();
    });
    await page.goto(url,{waitUntil:"networkidle2",timeout:60000});
    status = await page.$eval('div.v2_statusTag-activity__44BHZ span',el=>el.textContent.trim());
    coin = await page.$eval('div.v2_title-activity___S0uO span',el=>el.textContent.trim());
  } catch(e){console.error("Crawl error:",e.message);}
  finally{if(page) await page.close();}
  return {status,coin};
}

// API
app.post("/add-links",(req,res)=>{
  const { urls } = req.body;
  if(!urls||!Array.isArray(urls)) return res.status(400).json({error:"urls phải là mảng"});
  for(let item of urls){
    const {url, emails} = item;
    if(!url||!emails||!Array.isArray(emails)) continue;
    const exist = monitoredLinks.find(l=>l.url===url);
    if(exist) exist.emails = Array.from(new Set([...exist.emails,...emails]));
    else monitoredLinks.push({url,emails,status:"Chưa kiểm tra",lastChecked:null,active:true});
  }
  res.json({message:"Đã thêm link",monitoredLinks});
});

app.post("/add-email",(req,res)=>{
  const { url,email } = req.body;
  if(!url||!email) return res.status(400).json({error:"Cần url và email"});
  const link = monitoredLinks.find(l=>l.url===url);
  if(!link) return res.status(404).json({error:"Không tìm thấy URL"});
  if(!link.emails.includes(email)) link.emails.push(email);
  res.json({message:`Đã thêm email ${email}`,emails:link.emails});
});

app.post("/remove-link",(req,res)=>{
  const {url}=req.body;
  const idx = monitoredLinks.findIndex(l=>l.url===url);
  if(idx===-1) return res.status(404).json({error:"Không tìm thấy link"});
  monitoredLinks.splice(idx,1);
  res.json({message:`Đã xoá link ${url}`,monitoredLinks});
});

app.get("/status",(req,res)=>res.json(monitoredLinks));

// Cron mỗi phút
cron.schedule("* * * * *",async ()=>{
  if(!monitoredLinks.length) return;
  console.log("⏳ Cron chạy",new Date().toLocaleString());
  const limit = pLimit(2);
  await Promise.all(monitoredLinks.map(link=>limit(async ()=>{
    if(!link.active) return;
    const {status,coin}=await crawlLink(link.url);
    link.status=status; link.coin=coin; link.lastChecked=new Date().toISOString();
    console.log(`✔ ${link.url}: ${status}`);
    if(status==="Đã kết thúc"){link.active=false; await sendEmails(coin,link.emails,link.url);}
  })));
});

process.on('SIGINT',async ()=>{
  if(browser) await browser.close();
  process.exit();
});

app.listen(PORT,()=>console.log(`🚀 Server chạy tại http://localhost:${PORT}`));
