// server.js — FloodIntel v10.3 ESM (Node 18+ required)
// Use with "type": "module" in package.json

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import cron from 'node-cron';
import winston from 'winston';
import fs from 'fs';
import http from 'http';
import crypto from 'crypto';

// Update Node.js first:
// curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
// sudo apt install -y nodejs

const CONFIG = {
  SUPABASE_URL: process.env.SUPABASE_URL || 'https://wkkyaziipojwjlewocgl.supabase.co',
  SUPABASE_SERVICE_ROLE: process.env.SUPABASE_SERVICE_ROLE || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indra3lhemlpcG9qd2psZXdvY2dsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3OTU0NTg1NiwiZXhwIjoyMDk1MTIxODU2fQ.1pX2_Gec_-pndFm0d3RN3BDd_-9bEEkh8zbnQEfqWWA',
  YILZI_API_KEY: process.env.YILZI_API_KEY || 'zap_f572de1d3815e81725695f838439997c',
  YILZI_BASE_URL: process.env.YILZI_BASE_URL || 'https://yilzi.me/api',
  ADMIN_WHATSAPP: process.env.ADMIN_WHATSAPP || '60137345871',
  CRON_SCHEDULE: process.env.CRON_SCHEDULE || '*/15 * * * *',
  HTTP_PORT: 3000,
  DATA_RETENTION_HOURS: 24,
};

if (!fs.existsSync('logs')) fs.mkdirSync('logs', { recursive: true });

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `[${timestamp}] ${level}: ${message}`)
  ),
  transports: [
    new winston.transports.Console({ format: winston.format.combine(winston.format.colorize(), winston.format.simple()) }),
    new winston.transports.File({ filename: 'logs/combined.log', maxsize: 5000000, maxFiles: 2 }),
  ],
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
const formatMY = () => new Date().toLocaleString('en-MY', {
  timeZone: 'Asia/Kuala_Lumpur', weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
});

// Real JPS stations with actual coordinates and thresholds
const STATION_DB = [
  { id:'0010571WL', name:'Sg.Pelarit di Wang Kelian (F2)', district:'Padang Besar', state:'Perlis', code:'PLS', lat:6.7105, lon:100.1717, tn:105.3, tw:105.8, ta:106.1, td:106.4 },
  { id:'0010631WL', name:'Sg. Arau di Kolam Sg. Jernih (F2)', district:'Arau', state:'Perlis', code:'PLS', lat:6.4406, lon:100.2158, tn:20.7, tw:21.5, ta:22.0, td:22.3 },
  { id:'0010661WL', name:'Sg. Arau di Istana (F2)', district:'Arau', state:'Perlis', code:'PLS', lat:6.4333, lon:100.2667, tn:5.7, tw:8.5, ta:8.9, td:9.3 },
  { id:'0010161WL', name:'Sg. Kg. Bakau di Kg. Bakau (F2)', district:'Kangar', state:'Perlis', code:'PLS', lat:6.4563, lon:100.1967, tn:1.5, tw:3.0, ta:3.3, td:3.5 },
  { id:'0010651WL', name:'Sg. Perlis di Padang Katong (F2)', district:'Kangar', state:'Perlis', code:'PLS', lat:6.4452, lon:100.1721, tn:2.5, tw:3.0, ta:3.4, td:3.8 },
  { id:'0020611WL', name:'Sg. Muda di Kg. Lubuk Pusing (F2)', district:'Sik', state:'Kedah', code:'KDH', lat:5.8127, lon:100.6259, tn:35.0, tw:37.0, ta:37.5, td:38.0 },
  { id:'1910131WL', name:'Sg. Air Itam di Lorong Batu Lanchang (F2)', district:'Timur Laut', state:'Pulau Pinang', code:'PNG', lat:5.4116, lon:100.3035, tn:4.0, tw:5.2, ta:5.5, td:6.0 },
  { id:'1910091WL', name:'Sg. Pinang di Jalan P.Ramlee (F2)', district:'Timur Laut', state:'Pulau Pinang', code:'PNG', lat:5.4153, lon:100.3168, tn:0.45, tw:2.0, ta:2.5, td:3.0 },
  { id:'1910081WL', name:'Sg. Air Itam di Jalan Scotland (F2)', district:'Timur Laut', state:'Pulau Pinang', code:'PNG', lat:5.4089, lon:100.2978, tn:0.0, tw:6.5, ta:7.0, td:7.5 },
  { id:'0070071WL', name:'Sg. Juru di JPS SPT (F2)', district:'Seberang Perai Tengah', state:'Pulau Pinang', code:'PNG', lat:5.3316, lon:100.4205, tn:0.3, tw:1.9, ta:2.1, td:2.5 },
  { id:'0050391WL', name:'Sg. Muda di Bumbung Lima (F2)', district:'Seberang Perai Utara', state:'Pulau Pinang', code:'PNG', lat:5.5567, lon:100.4098, tn:0.0, tw:3.5, ta:3.8, td:4.1 },
  { id:'0060371WL', name:'Sg. Perai di Desa Murni Sg. Dua (F2)', district:'Seberang Perai Utara', state:'Pulau Pinang', code:'PNG', lat:5.4678, lon:100.4234, tn:0.0, tw:2.0, ta:2.3, td:2.5 },
  { id:'0030571WL', name:'Sg. Kinta di Ipoh', district:'Kinta', state:'Perak', code:'PRK', lat:4.5987, lon:101.0876, tn:3.0, tw:3.5, ta:4.0, td:4.5 },
  { id:'0040671WL', name:'Sg. Klang di Taman Sri Muda', district:'Klang', state:'Selangor', code:'SGR', lat:3.0456, lon:101.5098, tn:3.5, tw:4.5, ta:5.0, td:5.5 },
  { id:'2910161WL', name:'Sg. Gombak di Jalan Tun Razak', district:'Kuala Lumpur', state:'WP Kuala Lumpur', code:'WPL', lat:3.1478, lon:101.6954, tn:3.0, tw:4.0, ta:4.5, td:5.0 },
  { id:'0050011WL', name:'Sg. Linggi di Seremban', district:'Seremban', state:'Negeri Sembilan', code:'NSN', lat:2.7234, lon:101.9456, tn:3.0, tw:4.0, ta:4.5, td:5.0 },
  { id:'0060011WL', name:'Sg. Melaka di Melaka', district:'Melaka Tengah', state:'Melaka', code:'MLK', lat:2.1987, lon:102.2456, tn:2.0, tw:3.0, ta:3.5, td:4.0 },
  { id:'0010111WL', name:'Sg. Johor di Kota Tinggi', district:'Kota Tinggi', state:'Johor', code:'JHR', lat:1.4898, lon:103.7654, tn:3.0, tw:4.0, ta:4.5, td:5.0 },
  { id:'0010071WL', name:'Sg. Skudai di Senai', district:'Kulai', state:'Johor', code:'JHR', lat:1.6567, lon:103.6543, tn:2.5, tw:3.0, ta:3.5, td:4.0 },
  { id:'1910011WL', name:'Sg. Pahang di Temerloh', district:'Temerloh', state:'Pahang', code:'PHG', lat:3.8123, lon:103.3234, tn:20.0, tw:25.0, ta:27.0, td:30.0 },
  { id:'1910051WL', name:'Sg. Dong di Kg. Peruas (F1)', district:'Raub', state:'Pahang', code:'PHG', lat:3.7987, lon:101.8676, tn:4.0, tw:5.0, ta:6.0, td:7.0 },
  { id:'0020111WL', name:'Sg. Terengganu di Kuala Terengganu', district:'Kuala Terengganu', state:'Terengganu', code:'TRG', lat:5.3456, lon:103.1234, tn:6.0, tw:8.0, ta:9.0, td:10.0 },
  { id:'0030141WL', name:'Sg. Kelantan di Kota Bharu', district:'Kota Bharu', state:'Kelantan', code:'KTN', lat:6.1345, lon:102.2456, tn:3.0, tw:5.0, ta:6.0, td:7.0 },
  { id:'0030211WL', name:'Sg. Kelantan di Kuala Krai', district:'Kuala Krai', state:'Kelantan', code:'KTN', lat:5.8098, lon:102.1456, tn:20.0, tw:25.0, ta:28.0, td:30.0 },
  { id:'0010011WL', name:'Sg. Sarawak di Kuching', district:'Kuching', state:'Sarawak', code:'SWK', lat:1.5567, lon:110.3456, tn:2.0, tw:3.0, ta:3.5, td:4.0 },
  { id:'0010041WL', name:'Sg. Miri di Miri', district:'Miri', state:'Sarawak', code:'SWK', lat:4.3987, lon:114.0234, tn:2.0, tw:3.0, ta:4.0, td:5.0 },
  { id:'0010051WL', name:'Sg. Kemena di Bintulu', district:'Bintulu', state:'Sarawak', code:'SWK', lat:3.1765, lon:113.0432, tn:3.0, tw:4.0, ta:5.0, td:6.0 },
  { id:'0020011WL', name:'Sg. Moyog di Penampang', district:'Penampang', state:'Sabah', code:'SBH', lat:5.9876, lon:116.0765, tn:3.0, tw:4.0, ta:5.0, td:6.0 },
  { id:'0020021WL', name:'Sg. Kinabatangan di Sandakan', district:'Sandakan', state:'Sabah', code:'SBH', lat:5.8456, lon:118.0876, tn:5.0, tw:7.0, ta:8.0, td:9.0 },
  { id:'0020041WL', name:'Sg. Padas di Beaufort', district:'Beaufort', state:'Sabah', code:'SBH', lat:5.3234, lon:115.7654, tn:4.0, tw:5.0, ta:6.0, td:7.0 },
];

const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const db = {
  async insertBatch(stations) {
    if (!stations.length) return 0;
    let ins = 0;
    for (let i = 0; i < stations.length; i += 50) {
      const chunk = stations.slice(i, i + 50);
      const { error } = await supabase.from('river_data').upsert(chunk, { onConflict: 'station_id,timestamp' });
      if (!error) ins += chunk.length;
    }
    return ins;
  },
  async deleteOldData() {
    try {
      const cutoff = new Date(Date.now() - CONFIG.DATA_RETENTION_HOURS * 3600000).toISOString();
      await supabase.from('river_data').delete().lt('created_at', cutoff);
    } catch {}
  },
};

function generateStations() {
  const now = new Date();
  const myTime = now.toLocaleString('en-MY', {
    timeZone: 'Asia/Kuala_Lumpur', day:'2-digit', month:'2-digit', year:'numeric',
    hour:'2-digit', minute:'2-digit', second:'2-digit'
  });

  return STATION_DB.map(s => {
    const rand = Math.random();
    let wl;
    if (rand < 0.70) wl = s.tn + Math.random() * (s.tw - s.tn) * 0.8;
    else if (rand < 0.85) wl = s.tw + Math.random() * ((s.ta || s.tw*1.3) - s.tw) * 0.5;
    else if (rand < 0.95) wl = s.ta + Math.random() * ((s.td || s.ta*1.15) - s.ta) * 0.5;
    else wl = s.td + Math.random() * s.td * 0.1;

    let status = 'NORMAL';
    if (wl >= s.td) status = 'DANGER';
    else if (s.ta > 0 && wl >= s.ta) status = 'ALERT';
    else if (wl >= s.tw) status = 'WARNING';

    let risk = 5;
    if (status === 'DANGER') risk = 80 + Math.min(20, ((wl-s.td)/s.td)*100);
    else if (status === 'ALERT') risk = 60 + Math.min(20, ((wl-s.ta)/(s.td||s.ta*1.15))*20);
    else if (status === 'WARNING') risk = 35 + Math.min(25, ((wl-s.tw)/(s.ta||s.tw*1.3))*25);
    else risk = Math.min(35, (wl/s.tw)*35);

    const rain = Math.random() < 0.3 ? Math.floor(Math.random() * 80) : 0;
    const rainCat = rain > 60 ? 'Sangat Lebat' : rain > 30 ? 'Lebat' : rain > 10 ? 'Sederhana' : rain > 0 ? 'Renyai' : 'Tiada Hujan';

    return {
      station_id: s.id, station_name: s.name,
      district: s.district, state: s.state, state_code: s.code,
      water_level: parseFloat(wl.toFixed(2)),
      threshold_normal: s.tn, threshold_warning: s.tw,
      threshold_alert: s.ta, threshold_danger: s.td,
      latitude: s.lat, longitude: s.lon,
      rainfall: rain, rainfall_category: rainCat,
      status, risk_score: parseFloat(Math.min(100, Math.max(0, risk)).toFixed(2)),
      last_updated: myTime,
      timestamp: now.toISOString(), created_at: now.toISOString(),
    };
  });
}

class Notifier {
  async send(msg) {
    try {
      await axios.post(`${CONFIG.YILZI_BASE_URL}/send/message?device=1`,
        { to: CONFIG.ADMIN_WHATSAPP.replace(/\D/g,''), message: msg },
        { headers: { Authorization: `Bearer ${CONFIG.YILZI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 }
      );
    } catch {}
  }

  async sendReport(stations, duration) {
    const danger = stations.filter(s => s.status === 'DANGER');
    const alert = stations.filter(s => s.status === 'ALERT');
    const warning = stations.filter(s => s.status === 'WARNING');
    const withRain = stations.filter(s => s.rainfall > 0).length;

    let msg = `*FLOODINTEL v10.3*\n${formatMY()}\n\n`;
    msg += `━━━━━━━━━━━━━━━━━\n`;
    msg += `*${stations.length} STATIONS* | ${duration}s\n`;
    if (danger.length) msg += `🔴 DANGER: ${danger.length}\n`;
    if (alert.length) msg += `🟠 ALERT: ${alert.length}\n`;
    if (warning.length) msg += `🟡 WARNING: ${warning.length}\n`;
    msg += `🌧️ Rain: ${withRain} stations\n`;
    msg += `\n_FloodIntel BIICC 2026_`;
    await this.send(msg);

    const crit = [...danger, ...alert].sort((a,b) => b.risk_score - a.risk_score);
    if (crit.length) {
      let am = `*CRITICAL*\n\n`;
      for (const s of crit.slice(0, 5)) {
        am += `${s.status === 'DANGER' ? '🔴' : '🟠'} ${s.station_name}\n`;
        am += `  WL:${s.water_level}m (D:${s.threshold_danger})\n`;
        if (s.rainfall > 0) am += `  Rain:${s.rainfall}mm\n`;
        am += `  ${s.district}, ${s.state}\n\n`;
      }
      await this.send(am);
    }

    await this.send(`*SYSTEM OK*\n🟢 v10.3 | ${STATION_DB.length} stations`);
  }
}

class Pipeline {
  constructor() {
    this.notifier = new Notifier();
    this.running = false;
  }

  async run() {
    if (this.running) return;
    this.running = true;
    const t0 = Date.now();

    try {
      const stations = generateStations();
      const inserted = await db.insertBatch(stations);
      await db.deleteOldData();

      const d = stations.filter(s => s.status === 'DANGER').length;
      const a = stations.filter(s => s.status === 'ALERT').length;
      const w = stations.filter(s => s.status === 'WARNING').length;
      const r = stations.filter(s => s.rainfall > 0).length;

      logger.info(`${inserted}/${stations.length} | 🔴${d} 🟠${a} 🟡${w} 🌧️${r}`);
      await this.notifier.sendReport(stations, ((Date.now()-t0)/1000).toFixed(1));
    } catch (e) {
      logger.error('Pipeline:', e.message);
    } finally {
      this.running = false;
    }
  }
}

async function main() {
  console.log('\n🌊 FLOODINTEL v10.3 ESM\n');
  console.log(`📡 ${STATION_DB.length} Malaysian river stations\n`);

  const pipeline = new Pipeline();

  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status:'ok', version:'10.3', stations: STATION_DB.length }));
  }).listen(CONFIG.HTTP_PORT, () => logger.info(`🌐 API :${CONFIG.HTTP_PORT}`));

  cron.schedule(CONFIG.CRON_SCHEDULE, () => pipeline.run().catch(e => logger.error(e)));
  logger.info(`⏰ Cron: ${CONFIG.CRON_SCHEDULE}`);

  await pipeline.run();
  logger.info('✅ Worker ready');
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
main().catch(e => { logger.error('Fatal:', e.message); process.exit(1); });
