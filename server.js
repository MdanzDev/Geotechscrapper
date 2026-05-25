// server.js — FloodIntel v10.2 DEBUG VERSION
// Shows exactly what's failing

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const cron = require('node-cron');
const winston = require('winston');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { execSync } = require('child_process');

// ============================================
// AUTO-INSTALL PLAYWRIGHT
// ============================================
let playwright;
let PLAYWRIGHT_AVAILABLE = false;

function installPlaywright() {
  console.log('\n📦 Installing Playwright browsers...\n');
  try {
    execSync('npx playwright install chromium', { stdio: 'inherit', timeout: 120000 });
    console.log('✅ Playwright installed!\n');
    return true;
  } catch (e) {
    console.log('⚠️  Playwright install failed\n');
    return false;
  }
}

try {
  playwright = require('playwright');
  PLAYWRIGHT_AVAILABLE = true;
  console.log('✅ Playwright loaded');
} catch (e) {
  console.log('⚠️  Playwright not found, installing...');
  if (installPlaywright()) {
    try { playwright = require('playwright'); PLAYWRIGHT_AVAILABLE = true; } catch (e2) {}
  }
}

// ============================================
// CONFIG
// ============================================
const CONFIG = {
  SUPABASE_URL: process.env.SUPABASE_URL || 'https://wkkyaziipojwjlewocgl.supabase.co',
  SUPABASE_SERVICE_ROLE: process.env.SUPABASE_SERVICE_ROLE || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indra3lhemlpcG9qd2psZXdvY2dsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3OTU0NTg1NiwiZXhwIjoyMDk1MTIxODU2fQ.1pX2_Gec_-pndFm0d3RN3BDd_-9bEEkh8zbnQEfqWWA',
  YILZI_API_KEY: process.env.YILZI_API_KEY || 'zap_f572de1d3815e81725695f838439997c',
  YILZI_BASE_URL: process.env.YILZI_BASE_URL || 'https://yilzi.me/api',
  ADMIN_WHATSAPP: process.env.ADMIN_WHATSAPP || '60137345871',
  INFOBANJIR_BASE: 'https://publicinfobanjir.water.gov.my',
  CRON_SCHEDULE: process.env.CRON_SCHEDULE || '*/15 * * * *',
  HTTP_PORT: 3000,
  DATA_RETENTION_HOURS: 24,
};

// ============================================
// LOGGER
// ============================================
if (!fs.existsSync('logs')) fs.mkdirSync('logs', { recursive: true });
const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, stack }) => 
      `[${timestamp}] ${level}: ${message}${stack ? '\n' + stack : ''}`
    )
  ),
  transports: [
    new winston.transports.Console({ format: winston.format.combine(winston.format.colorize(), winston.format.simple()) }),
    new winston.transports.File({ filename: 'logs/combined.log', maxsize: 5000000, maxFiles: 2 }),
  ],
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
const formatMY = () => new Date().toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const STATE_CENTERS = {
  'Perlis':[6.44,100.20],'Kedah':[6.12,100.37],'Pulau Pinang':[5.35,100.37],
  'Perak':[4.59,101.09],'Selangor':[3.07,101.52],'WP Kuala Lumpur':[3.15,101.70],
  'WP Putrajaya':[2.94,101.69],'Negeri Sembilan':[2.73,101.94],'Melaka':[2.19,102.25],
  'Johor':[1.94,103.56],'Pahang':[3.77,102.32],'Terengganu':[5.31,103.11],
  'Kelantan':[5.68,102.03],'Sarawak':[2.50,113.50],'Sabah':[5.50,117.00],'WP Labuan':[5.29,115.25]
};

function getCoords(state) {
  const [lat, lon] = STATE_CENTERS[state] || [4.0, 109.0];
  return { lat: lat + (Math.random()-0.5)*0.5, lon: lon + (Math.random()-0.5)*0.5 };
}

// ============================================
// SUPABASE
// ============================================
const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

const db = {
  async insertBatch(stations) {
    if (!stations.length) return 0;
    const now = new Date(); let ins = 0;
    for (let i = 0; i < stations.length; i += 100) {
      const chunk = stations.slice(i, i + 100).map((s, idx) => ({
        station_id: s.station_id, station_name: s.station_name,
        district: s.district || '', state: s.state || '', state_code: s.state_code || '',
        water_level: s.water_level,
        threshold_normal: s.threshold_normal || 0, threshold_warning: s.threshold_warning || 0,
        threshold_alert: s.threshold_alert || 0, threshold_danger: s.threshold_danger || 0,
        latitude: s.latitude || 0, longitude: s.longitude || 0,
        rainfall: s.rainfall || 0, rainfall_category: s.rainfall_category || 'Tiada Hujan',
        status: s.status || 'NORMAL', risk_score: s.risk_score || 0,
        last_updated: s.last_updated || '',
        timestamp: s.timestamp || now.toISOString(), created_at: now.toISOString(),
      }));
      try { 
        const { error } = await supabase.from('river_data').upsert(chunk, { onConflict: 'station_id,timestamp' }); 
        if (!error) ins += chunk.length; 
        else logger.warn('DB chunk error:', error.message);
      } catch (e) { logger.warn('DB chunk exception:', e.message); }
      await sleep(30);
    }
    return ins;
  },
  async deleteOldData() {
    try { 
      const cutoff = new Date(Date.now() - CONFIG.DATA_RETENTION_HOURS * 3600000).toISOString();
      await supabase.from('river_data').delete().lt('created_at', cutoff); 
    } catch (e) { logger.warn('Cleanup error:', e.message); }
  },
};

// ============================================
// SCRAPER WITH DEBUG
// ============================================
const STATES = [
  { code:'PLS', name:'Perlis' },{ code:'KDH', name:'Kedah' },{ code:'PNG', name:'Pulau Pinang' },{ code:'PRK', name:'Perak' },
  { code:'SGR', name:'Selangor' },{ code:'WPL', name:'WP Kuala Lumpur' },{ code:'WPJ', name:'WP Putrajaya' },{ code:'NSN', name:'Negeri Sembilan' },
  { code:'MLK', name:'Melaka' },{ code:'JHR', name:'Johor' },{ code:'PHG', name:'Pahang' },{ code:'TRG', name:'Terengganu' },
  { code:'KTN', name:'Kelantan' },{ code:'SWK', name:'Sarawak' },{ code:'SBH', name:'Sabah' },{ code:'LBN', name:'WP Labuan' },
];

async function scrapeWithPlaywright() {
  logger.debug('Launching browser...');
  let browser;
  try {
    browser = await playwright.chromium.launch({ 
      headless: true, 
      args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] 
    });
    logger.debug('Browser launched successfully');
  } catch (e) {
    logger.error('Browser launch failed:', e.message);
    throw e;
  }
  
  const allStations = [];
  let successCount = 0;
  let failCount = 0;
  
  try {
    for (const st of STATES) {
      try {
        logger.debug(`Scraping ${st.name}...`);
        const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
        const pg = await ctx.newPage();
        
        const url = `${CONFIG.INFOBANJIR_BASE}/aras-air/data-paras-air/?state=${st.code}`;
        logger.debug(`  URL: ${url}`);
        
        await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await pg.waitForTimeout(3000);
        
        const data = await pg.evaluate((si) => {
          const r = []; 
          const tables = document.querySelectorAll('table');
          tables.forEach(table => {
            const rows = table.querySelectorAll('tr');
            rows.forEach((row, idx) => {
              if (idx < 2) return; 
              const c = row.querySelectorAll('td'); 
              if (c.length < 8) return;
              const id = (c[1]?.textContent||'').trim();
              const nm = (c[2]?.textContent||'').trim();
              if (!id || id === 'No Data' || nm.length < 3) return;
              if (/^(bilangan|id stesen|nama stesen|petunjuk)$/i.test(nm)) return;
              const n = (x, fb = 0) => { 
                const v = parseFloat((x?.textContent||'').replace(/[^0-9.-]/g,'')); 
                return isNaN(v) ? fb : v; 
              };
              const wl = n(c[7], null);
              r.push({ 
                station_id:id, station_name:nm, 
                district:(c[3]?.textContent||'').trim(), 
                state:si.name, state_code:si.code,
                water_level:(wl===null||wl<=-9998)?null:wl, 
                threshold_normal:n(c[8]), threshold_warning:n(c[9]),
                threshold_alert:n(c[10]), threshold_danger:n(c[11]), 
                last_updated:(c[6]?.textContent||'').trim() 
              });
            });
          });
          return r;
        }, st);
        
        allStations.push(...data);
        successCount++;
        logger.debug(`  ${st.name}: ${data.length} stations`);
        await ctx.close();
      } catch (e) {
        failCount++;
        logger.warn(`  ${st.name} FAILED: ${e.message}`);
      }
      await sleep(200);
    }
  } finally { 
    await browser.close(); 
  }
  
  logger.info(`Scraped: ${successCount}/16 states, ${allStations.length} stations, ${failCount} failed`);
  
  if (allStations.length === 0) {
    throw new Error('No stations scraped from any state');
  }
  
  // Process stations
  const now = new Date();
  return allStations.map(s => {
    const wl = s.water_level; 
    const tw = s.threshold_warning; 
    const ta = s.threshold_alert; 
    const td = s.threshold_danger;
    
    let status = 'NORMAL'; 
    if (wl === null) status = 'NO_DATA'; 
    else if (td>0 && wl>=td) status = 'DANGER'; 
    else if (ta>0 && wl>=ta) status = 'ALERT'; 
    else if (tw>0 && wl>=tw) status = 'WARNING';
    
    let risk = 5;
    if (status==='DANGER'&&wl!==null&&td>0) risk = 80+Math.min(20,((wl-td)/td)*100);
    else if (status==='ALERT'&&wl!==null&&ta>0) { const r=(td||ta*1.15)-ta; risk=60+(r>0?Math.min(20,((wl-ta)/r)*20):0); }
    else if (status==='WARNING'&&wl!==null&&tw>0) { const r=(ta||tw*1.3)-tw; risk=35+(r>0?Math.min(25,((wl-tw)/r)*25):0); }
    else if (status==='NORMAL'&&wl!==null&&tw>0) risk = Math.min(35,(wl/tw)*35);
    
    const coords = getCoords(s.state);
    
    return { 
      station_id:s.station_id, station_name:s.station_name, 
      district:s.district, state:s.state, state_code:s.state_code,
      water_level:s.water_level, 
      threshold_normal:s.threshold_normal, threshold_warning:tw, 
      threshold_alert:ta, threshold_danger:td,
      latitude:coords.lat, longitude:coords.lon, 
      rainfall:0, rainfall_category:'Tiada Hujan', 
      status, risk_score:parseFloat(Math.min(100,Math.max(0,risk)).toFixed(2)),
      last_updated:s.last_updated||'', 
      timestamp:now.toISOString(), created_at:now.toISOString() 
    };
  });
}

// ============================================
// SAMPLE FALLBACK
// ============================================
const SAMPLE_STATIONS = [
  { id:'0010571WL', name:'Sg.Pelarit di Wang Kelian', district:'Padang Besar', state:'Perlis', code:'PLS', tw:105.8, ta:106.1, td:106.4 },
  { id:'1910131WL', name:'Sg. Air Itam di Lorong Batu Lanchang', district:'Timur Laut', state:'Pulau Pinang', code:'PNG', tw:5.2, ta:5.5, td:6.0 },
  { id:'0040671WL', name:'Sg. Klang di Taman Sri Muda', district:'Klang', state:'Selangor', code:'SGR', tw:4.5, ta:5.0, td:5.5 },
  { id:'1910011WL', name:'Sg. Pahang di Temerloh', district:'Temerloh', state:'Pahang', code:'PHG', tw:25.0, ta:27.0, td:30.0 },
  { id:'0030141WL', name:'Sg. Kelantan di Kota Bharu', district:'Kota Bharu', state:'Kelantan', code:'KTN', tw:5.0, ta:6.0, td:7.0 },
  { id:'0010011WL', name:'Sg. Sarawak di Kuching', district:'Kuching', state:'Sarawak', code:'SWK', tw:3.0, ta:3.5, td:4.0 },
  { id:'0010111WL', name:'Sg. Johor di Kota Tinggi', district:'Kota Tinggi', state:'Johor', code:'JHR', tw:4.0, ta:4.5, td:5.0 },
  { id:'0030571WL', name:'Sg. Kinta di Ipoh', district:'Kinta', state:'Perak', code:'PRK', tw:3.5, ta:4.0, td:4.5 },
  { id:'0020611WL', name:'Sg. Muda di Kg. Lubuk Pusing', district:'Sik', state:'Kedah', code:'KDH', tw:37.0, ta:37.5, td:38.0 },
  { id:'0020011WL', name:'Sg. Moyog di Penampang', district:'Penampang', state:'Sabah', code:'SBH', tw:4.0, ta:5.0, td:6.0 },
];

function generateSampleStations() {
  const now = new Date();
  return SAMPLE_STATIONS.map(s => {
    const wl = s.tw * (0.3 + Math.random() * 1.4);
    let status = 'NORMAL';
    if (wl >= s.td) status = 'DANGER';
    else if (wl >= s.ta) status = 'ALERT';
    else if (wl >= s.tw) status = 'WARNING';
    let risk = 5;
    if (status === 'DANGER') risk = 80 + Math.min(20, ((wl-s.td)/s.td)*100);
    else if (status === 'ALERT') risk = 60 + Math.min(20, ((wl-s.ta)/(s.td||s.ta*1.15))*20);
    else if (status === 'WARNING') risk = 35 + Math.min(25, ((wl-s.tw)/(s.ta||s.tw*1.3))*25);
    else risk = Math.min(35, (wl/s.tw)*35);
    const coords = getCoords(s.state);
    const rain = Math.random() < 0.3 ? Math.floor(Math.random() * 80) : 0;
    return {
      station_id: s.id, station_name: s.name, district: s.district, state: s.state, state_code: s.code,
      water_level: parseFloat(wl.toFixed(2)),
      threshold_normal: parseFloat((s.tw*0.8).toFixed(1)), threshold_warning: s.tw,
      threshold_alert: s.ta, threshold_danger: s.td,
      latitude: parseFloat(coords.lat.toFixed(4)), longitude: parseFloat(coords.lon.toFixed(4)),
      rainfall: rain, rainfall_category: rain > 60 ? 'Sangat Lebat' : rain > 30 ? 'Lebat' : rain > 10 ? 'Sederhana' : rain > 0 ? 'Renyai' : 'Tiada Hujan',
      status, risk_score: parseFloat(Math.min(100, Math.max(0, risk)).toFixed(2)),
      last_updated: now.toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur' }),
      timestamp: now.toISOString(), created_at: now.toISOString(),
    };
  });
}

// ============================================
// NOTIFIER
// ============================================
class Notifier {
  async send(to, msg) { 
    try { await axios.post(`${CONFIG.YILZI_BASE_URL}/send/message?device=1`, { to: to.replace(/\D/g,''), message: msg }, { headers: { Authorization: `Bearer ${CONFIG.YILZI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 }); } catch (e) { logger.warn('WhatsApp fail:', e.message); } 
  }
  async sendReport(stations, duration, mode) {
    const danger = stations.filter(s => s.status === 'DANGER');
    const alert = stations.filter(s => s.status === 'ALERT');
    let msg = `*FLOODINTEL v10.2*\n${formatMY()}\n\n━━━━━━━━━━━━━━━━━\n*${stations.length} STATIONS* | ${duration}s\nMode: ${mode}\n`;
    if (danger.length) msg += `DANGER: ${danger.length}\n`;
    if (alert.length) msg += `ALERT: ${alert.length}\n`;
    msg += `\n_FloodIntel BIICC 2026_`;
    await this.send(CONFIG.ADMIN_WHATSAPP, msg);
  }
}

// ============================================
// PIPELINE WITH FULL DEBUG
// ============================================
class Pipeline {
  constructor() { this.notifier = new Notifier(); this.running = false; }
  async run() {
    if (this.running) { logger.warn('Pipeline busy'); return; }
    this.running = true;
    const startTime = Date.now();
    
    try {
      logger.info('═══ START ═══');
      
      let stations, mode;
      
      if (PLAYWRIGHT_AVAILABLE) {
        logger.info('[1] Scraping...');
        try {
          stations = await scrapeWithPlaywright();
          mode = 'LIVE';
          logger.info(`[1] ${stations.length} stations`);
        } catch (e) {
          logger.error('Scrape failed:', e.message);
          logger.info('Falling back to sample data...');
          stations = generateSampleStations();
          mode = 'SAMPLE (fallback)';
        }
      } else {
        logger.info('[1] Sample data...');
        stations = generateSampleStations();
        mode = 'SAMPLE';
      }
      
      logger.info('[2] Saving to DB...');
      const inserted = await db.insertBatch(stations);
      logger.info(`[2] ${inserted}/${stations.length}`);
      
      logger.info('[3] Cleanup...');
      await db.deleteOldData();
      
      logger.info('[4] Report...');
      await this.notifier.sendReport(stations, ((Date.now()-startTime)/1000).toFixed(1), mode);
      
      logger.info(`═══ DONE (${((Date.now()-startTime)/1000).toFixed(1)}s) ═══`);
    } catch (e) { 
      logger.error('PIPELINE ERROR:', e.message);
      logger.error('Stack:', e.stack);
    } finally { 
      this.running = false; 
    }
  }
}

// ============================================
// MAIN
// ============================================
async function main() {
  console.log('\n🌊 FLOODINTEL v10.2 DEBUG\n');
  console.log(`Playwright: ${PLAYWRIGHT_AVAILABLE ? '✅' : '❌'}\n`);
  
  const pipeline = new Pipeline();
  
  http.createServer((req, res) => { 
    res.writeHead(200, { 'Content-Type': 'application/json' }); 
    res.end(JSON.stringify({ status:'ok', version:'10.2' })); 
  }).listen(CONFIG.HTTP_PORT, () => logger.info(`API :${CONFIG.HTTP_PORT}`));
  
  cron.schedule(CONFIG.CRON_SCHEDULE, () => pipeline.run().catch(e => logger.error('Cron:', e.message)));
  
  await pipeline.run();
  logger.info('Ready');
}

process.on('SIGINT', () => process.exit(0));
main().catch(e => { logger.error('FATAL:', e.message); process.exit(1); });
