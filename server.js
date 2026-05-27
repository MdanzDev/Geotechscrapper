// server.js — FloodIntel v10.0 FINAL COMPLETE
// All fixes: Auto-resolve alerts, correct timestamps, auto-cleanup, working DB
// WhatsApp + Telegram notifications to all subscribed users
// BIICC 2026

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import playwright from 'playwright';
import axios from 'axios';
import cron from 'node-cron';
import winston from 'winston';
import fs from 'fs';
import http from 'http';
import crypto from 'crypto';

// ============================================
// CONFIGURATION
// ============================================

const CONFIG = {
  SUPABASE_URL: process.env.SUPABASE_URL || 'https://wkkyaziipojwjlewocgl.supabase.co',
  SUPABASE_SERVICE_ROLE: process.env.SUPABASE_SERVICE_ROLE || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indra3lhemlpcG9qd2psZXdvY2dsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3OTU0NTg1NiwiZXhwIjoyMDk1MTIxODU2fQ.1pX2_Gec_-pndFm0d3RN3BDd_-9bEEkh8zbnQEfqWWA',
  YILZI_API_KEY: process.env.YILZI_API_KEY || 'zap_f572de1d3815e81725695f838439997c',
  YILZI_BASE_URL: process.env.YILZI_BASE_URL || 'https://yilzi.me/api',
  ADMIN_WHATSAPP: process.env.ADMIN_WHATSAPP || '60137345871',
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '8878886366:AAGnCm9uODcyZNqrxrbJfzTfbBM9ucqjXIo',
  SERPAPI_KEY: process.env.SERPAPI_KEY || '',
  GEOCODE_CACHE_FILE: process.env.GEOCODE_CACHE_FILE || './geocode_cache.json',
  INFOBANJIR_BASE: 'https://publicinfobanjir.water.gov.my',
  CRON_SCHEDULE: process.env.CRON_SCHEDULE || '*/4 * * * *',
  PAGE_TIMEOUT_MS: 15000,
  PAGE_WAIT_MS: 2000,
  HTTP_PORT: 3000,
  DATA_RETENTION_HOURS: 2,
};

// ============================================
// LOGGER
// ============================================

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

// ============================================
// UTILITIES
// ============================================

const sleep = ms => new Promise(r => setTimeout(r, ms));
const formatMY = () => new Date().toLocaleString('en-MY', {
  timeZone: 'Asia/Kuala_Lumpur', weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
});
const uid = (len = 8) => crypto.randomBytes(len).toString('hex');

const MY_BOUNDS = { minLat: 0.8, maxLat: 7.5, minLon: 99.5, maxLon: 119.5 };
function inMalaysia({ lat, lon }) { 
  return lat >= MY_BOUNDS.minLat && lat <= MY_BOUNDS.maxLat && lon >= MY_BOUNDS.minLon && lon <= MY_BOUNDS.maxLon; 
}

function parseMalaysiaTime(dateStr) {
  if (!dateStr || dateStr === 'No Data' || dateStr === 'Tiada Data Terkini') return null;
  const clean = dateStr.trim();
  const match = clean.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (match) {
    const [, day, month, year, hour, minute, second] = match;
    const myDate = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second || '00'}+08:00`);
    if (!isNaN(myDate.getTime())) return myDate.toISOString();
  }
  return null;
}

// ============================================
// COORDINATES
// ============================================

const DISTRICT_COORDS = {
  'Padang Besar':[6.66,100.33],'Arau':[6.43,100.27],'Kangar':[6.44,100.20],
  'Kota Setar':[6.12,100.37],'Kuala Muda':[5.65,100.48],'Kulim':[5.37,100.57],
  'Sik':[5.82,100.73],'Baling':[5.67,100.90],'Langkawi':[6.35,99.80],
  'Kubang Pasu':[6.35,100.33],'Pendang':[6.00,100.47],'Bandar Baharu':[5.13,100.50],
  'Timur Laut':[5.42,100.32],'Barat Daya':[5.35,100.23],
  'Seberang Perai Utara':[5.45,100.40],'Seberang Perai Tengah':[5.35,100.45],
  'Seberang Perai Selatan':[5.20,100.48],
  'Kinta':[4.58,101.08],'Hilir Perak':[3.95,100.93],'Larut Matang':[4.77,100.65],
  'Kerian':[5.02,100.50],'Kuala Kangsar':[4.77,100.93],'Batang Padang':[4.02,101.23],
  'Manjung':[4.18,100.63],'Hulu Perak':[5.27,101.07],
  'Klang':[3.03,101.45],'Petaling':[3.08,101.58],'Hulu Langat':[3.08,101.82],
  'Kuala Selangor':[3.33,101.25],'Hulu Selangor':[3.57,101.63],'Sepang':[2.82,101.73],
  'Gombak':[3.27,101.72],'Kuala Langat':[2.78,101.48],'Sabak Bernam':[3.77,100.98],
  'Kuala Lumpur':[3.15,101.70],'Putrajaya':[2.94,101.69],
  'Seremban':[2.73,101.94],'Port Dickson':[2.52,101.80],'Jempol':[2.92,102.42],
  'Kuala Pilah':[2.73,102.25],'Rembau':[2.58,102.08],'Tampin':[2.47,102.23],
  'Alor Gajah':[2.38,102.22],'Jasin':[2.32,102.43],'Melaka Tengah':[2.20,102.25],
  'Johor Bahru':[1.47,103.76],'Kota Tinggi':[1.73,103.90],'Muar':[2.03,102.57],
  'Segamat':[2.50,102.82],'Kluang':[2.03,103.32],'Batu Pahat':[1.85,102.93],
  'Pontian':[1.48,103.38],'Mersing':[2.43,103.83],'Kulai':[1.67,103.60],
  'Tangkak':[2.27,102.55],
  'Kuantan':[3.82,103.33],'Pekan':[3.48,103.40],'Temerloh':[3.45,102.42],
  'Raub':[3.78,101.87],'Lipis':[4.18,102.05],'Bentong':[3.52,101.92],
  'Cameron Highlands':[4.48,101.38],'Jerantut':[3.93,102.37],'Rompin':[2.78,103.48],
  'Maran':[3.58,102.78],'Bera':[3.27,102.45],
  'Kuala Terengganu':[5.33,103.14],'Dungun':[4.77,103.42],'Kemaman':[4.23,103.45],
  'Besut':[5.83,102.57],'Hulu Terengganu':[5.08,102.75],'Marang':[5.20,103.20],
  'Setiu':[5.58,102.75],'Kuala Nerus':[5.38,103.07],
  'Kota Bharu':[6.13,102.25],'Gua Musang':[4.88,101.97],'Kuala Krai':[5.53,102.20],
  'Pasir Mas':[6.03,102.13],'Tumpat':[6.20,102.17],'Tanah Merah':[5.80,102.15],
  'Machang':[5.77,102.22],'Pasir Puteh':[5.83,102.40],'Bachok':[6.07,102.40],
  'Jeli':[5.70,101.83],
  'Kuching':[1.56,110.35],'Miri':[4.40,114.00],'Sibu':[2.30,111.82],
  'Bintulu':[3.17,113.03],'Limbang':[4.75,115.00],'Sri Aman':[1.23,111.47],
  'Sarikei':[2.13,111.52],'Kapit':[2.02,112.93],'Mukah':[2.90,112.10],
  'Samarahan':[1.47,110.50],'Betong':[1.42,111.53],'Serian':[1.17,110.57],
  'Kota Kinabalu':[5.98,116.07],'Sandakan':[5.83,118.12],'Tawau':[4.25,117.90],
  'Beaufort':[5.33,115.75],'Keningau':[5.33,116.17],'Lahad Datu':[5.03,118.33],
  'Sipitang':[5.08,115.55],'Tenom':[5.13,115.95],'Ranau':[5.95,116.67],
  'Kudat':[6.88,116.85],'Kota Marudu':[6.48,116.73],'Penampang':[5.92,116.10],
  'Papar':[5.73,115.93],'Semporna':[4.48,118.62],'Kunak':[4.68,118.25],
  'Labuan':[5.29,115.25]
};

const STATE_CENTERS = {
  'Perlis':[6.44,100.20],'Kedah':[6.12,100.37],'Pulau Pinang':[5.35,100.37],
  'Perak':[4.59,101.09],'Selangor':[3.07,101.52],'WP Kuala Lumpur':[3.15,101.70],
  'WP Putrajaya':[2.94,101.69],'Negeri Sembilan':[2.73,101.94],'Melaka':[2.19,102.25],
  'Johor':[1.94,103.56],'Pahang':[3.77,102.32],'Terengganu':[5.31,103.11],
  'Kelantan':[5.68,102.03],'Sarawak':[2.50,113.50],'Sabah':[5.50,117.00],
  'WP Labuan':[5.29,115.25]
};

function getCoords(district, state) {
  if (district) {
    const key = Object.keys(DISTRICT_COORDS).find(k => 
      district.toLowerCase().includes(k.toLowerCase()) || k.toLowerCase().includes(district.toLowerCase())
    );
    if (key) {
      const [lat, lon] = DISTRICT_COORDS[key];
      return { lat: lat + (Math.random()-0.5)*0.015, lon: lon + (Math.random()-0.5)*0.015 };
    }
  }
  const [lat, lon] = STATE_CENTERS[state] || [4.0, 109.0];
  return { lat: lat + (Math.random()-0.5)*0.2, lon: lon + (Math.random()-0.5)*0.2 };
}

// ============================================
// GEOCODE CACHE
// ============================================

class GeocodeCache {
  constructor(filePath) { this.filePath = filePath; this.data = {}; }
  load() { 
    try { if (fs.existsSync(this.filePath)) this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf8')); } 
    catch { this.data = {}; } 
  }
  save() { try { fs.writeFileSync(this.filePath, JSON.stringify(this.data)); } catch {} }
  get(id) { return this.data[id] || null; }
  set(id, e) { this.data[id] = e; }
}

// ============================================
// GEOCODER
// ============================================

class Geocoder {
  constructor(cache) { this.cache = cache; }
  
  async resolveOne(station) {
    const id = station.station_id;
    if (this.cache.get(id)) return this.cache.get(id);
    
    const q = [station.station_name, station.district, station.state, 'Malaysia'].filter(Boolean).join(', ');
    
    if (CONFIG.SERPAPI_KEY) {
      try {
        const r = await axios.get('https://serpapi.com/search', {
          params: { engine: 'google_maps', q, type: 'search', api_key: CONFIG.SERPAPI_KEY, hl: 'ms', gl: 'my' },
          timeout: 8000
        });
        const d = r.data;
        let c = d?.place_results?.gps_coordinates || d?.local_results?.[0]?.gps_coordinates || d?.knowledge_graph?.gps_coordinates;
        if (c) {
          const { latitude: lat, longitude: lon } = c;
          if (inMalaysia({ lat, lon })) {
            const e = { lat, lon, source: 'serpapi' };
            this.cache.set(id, e);
            return e;
          }
        }
      } catch {}
    }
    
    const e = { ...getCoords(station.district, station.state), source: 'district_table' };
    this.cache.set(id, e);
    return e;
  }
  
  async resolveAll(stations) {
    const needs = stations.filter(s => !this.cache.get(s.station_id));
    if (needs.length) {
      for (let i = 0; i < needs.length; i += 10) {
        await Promise.all(needs.slice(i, i + 10).map(s => this.resolveOne(s)));
        if (i + 10 < needs.length) await sleep(200);
      }
      this.cache.save();
    }
    const m = new Map();
    for (const s of stations) m.set(s.station_id, this.cache.get(s.station_id) || getCoords(s.district, s.state));
    return m;
  }
}

// ============================================
// SUPABASE
// ============================================

const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const db = {
  async initTables() {
    const sql = `
      CREATE TABLE IF NOT EXISTS alerts (
        id TEXT PRIMARY KEY,
        type TEXT DEFAULT 'river_level',
        title TEXT NOT NULL,
        message TEXT,
        severity TEXT DEFAULT 'high',
        location_name TEXT,
        latitude NUMERIC,
        longitude NUMERIC,
        risk_score NUMERIC DEFAULT 0,
        status TEXT DEFAULT 'active',
        triggered_at TIMESTAMPTZ DEFAULT NOW(),
        triggered_by TEXT DEFAULT 'auto'
      );
    `;
    try { await supabase.rpc('exec_sql', { sql }).catch(() => {}); } catch {}
  },

  async insertBatch(stations) {
    if (!stations.length) return 0;
    const now = new Date();
    let ins = 0;
    
    for (let i = 0; i < stations.length; i += 100) {
      const chunk = stations.slice(i, i + 100).map((s, idx) => ({
        station_id: s.station_id,
        station_name: s.station_name,
        district: s.district || '',
        state: s.state || '',
        state_code: s.state_code || '',
        river_basin: s.river_basin || '',
        water_level: s.water_level,
        threshold_normal: s.threshold_normal || 0,
        threshold_warning: s.threshold_warning || 0,
        threshold_alert: s.threshold_alert || 0,
        threshold_danger: s.threshold_danger || 0,
        latitude: s.latitude || 0,
        longitude: s.longitude || 0,
        rainfall: s.rainfall || 0,
        rainfall_category: s.rainfall_category || 'Tiada Hujan',
        flood_warning: s.flood_warning || '',
        weather_alert: s.weather_alert || '',
        alert_active: s.alert_active || false,
        status: s.status || 'NORMAL',
        risk_score: s.risk_score || 0,
        last_updated: s.last_updated || '',
        coord_source: s.coord_source || 'district_table',
        timestamp: s.timestamp || now.toISOString(),
        created_at: now.toISOString(),
      }));
      
      try {
        const { error } = await supabase.from('river_data').upsert(chunk, {
          onConflict: 'station_id,timestamp',
          ignoreDuplicates: false
        });
        if (!error) ins += chunk.length;
        else {
          const ids = chunk.map(s => s.station_id);
          const ts = chunk.map(s => s.timestamp);
          try { await supabase.from('river_data').delete().in('station_id', ids).in('timestamp', ts); } catch {}
          const { error: e2 } = await supabase.from('river_data').insert(chunk);
          if (!e2) ins += chunk.length;
        }
      } catch (e) {
        for (const row of chunk) {
          try {
            const { error } = await supabase.from('river_data').upsert([row], { onConflict: 'station_id,timestamp' });
            if (!error) ins++;
          } catch {}
        }
      }
      await sleep(30);
    }
    return ins;
  },

  async deleteOldData() {
    const cutoff = new Date(Date.now() - CONFIG.DATA_RETENTION_HOURS * 3600000).toISOString();
    try {
      const { error, count } = await supabase.from('river_data')
        .delete({ count: 'exact' }).lt('created_at', cutoff);
      if (!error && count > 0) {
        logger.info(`🧹 Deleted ${count} records (>${CONFIG.DATA_RETENTION_HOURS}h old)`);
      }
    } catch (e) { logger.warn('Cleanup:', e.message); }
  },

  async manageAlerts(processedStations) {
    const dangerStations = processedStations
      .filter(s => ['DANGER', 'ALERT'].includes(s.status))
      .map(s => ({
        name: s.station_name.toLowerCase(),
        district: s.district.toLowerCase(),
        state: s.state.toLowerCase(),
      }));

    const { data: activeAlerts } = await supabase
      .from('alerts')
      .select('*')
      .eq('status', 'active');

    let resolvedCount = 0;
    let newAlertCount = 0;

    if (activeAlerts?.length) {
      for (const alert of activeAlerts) {
        const alertName = (alert.location_name || '').toLowerCase();
        const stillInDanger = dangerStations.some(s => 
          alertName.includes(s.name) || s.name.includes(alertName)
        );

        if (!stillInDanger) {
          await supabase.from('alerts').update({
            status: 'resolved',
            message: (alert.message || '') + ' ✅ [Auto-selesai: Stesen kembali normal]'
          }).eq('id', alert.id);
          resolvedCount++;
          logger.info(`✅ Resolved alert: ${alert.location_name} (back to normal)`);
        }
      }
    }

    const existingAlertNames = (activeAlerts || [])
      .filter(a => a.status === 'active')
      .map(a => (a.location_name || '').toLowerCase());

    for (const station of processedStations.filter(s => ['DANGER', 'ALERT'].includes(s.status))) {
      const stationNameLower = station.station_name.toLowerCase();
      const alreadyAlerted = existingAlertNames.some(name => 
        stationNameLower.includes(name) || name.includes(stationNameLower)
      );

      if (!alreadyAlerted) {
        const alertId = uid(8);
        const isDanger = station.status === 'DANGER';
        
        await supabase.from('alerts').upsert([{
          id: alertId,
          type: 'river_level',
          title: `${isDanger ? '🔴 BAHAYA' : '🟠 AMARAN'}: ${station.station_name}`,
          message: `Aras air: ${station.water_level}m | Bahaya: ${station.threshold_danger}m | Amaran: ${station.threshold_alert}m. Daerah: ${station.district}, ${station.state}.${station.rainfall > 0 ? ` Hujan: ${station.rainfall}mm.` : ''}`,
          severity: isDanger ? 'critical' : 'high',
          location_name: station.station_name,
          latitude: station.latitude,
          longitude: station.longitude,
          risk_score: station.risk_score,
          status: 'active',
          triggered_at: new Date().toISOString(),
          triggered_by: 'auto'
        }], { onConflict: 'id' });
        
        newAlertCount++;
        logger.info(`🚨 NEW ALERT: ${station.status} - ${station.station_name} (${station.state})`);
      }
    }

    if (resolvedCount > 0 || newAlertCount > 0) {
      logger.info(`📋 Alerts: ${newAlertCount} new, ${resolvedCount} resolved`);
    }
  },
};

// ============================================
// WARNING PARSER
// ============================================

const KNOWN_STATES = [
  'perlis','kedah','pulau pinang','penang','perak','selangor',
  'wp kuala lumpur','kuala lumpur','wp putrajaya','putrajaya',
  'negeri sembilan','melaka','malacca','johor','pahang','terengganu',
  'kelantan','sarawak','sabah','wp labuan','labuan'
];

function parseActiveWarnings(html) {
  const now = new Date();
  const activeDistricts = new Set();
  const activeStates = new Set();
  
  if (!html) return { districts: activeDistricts, states: activeStates };
  
  const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const rows = text.split(/(?=\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}:\d{2})/);
  
  for (const row of rows) {
    if (row.length < 20) continue;
    const dates = row.match(/(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/g) || [];
    if (dates.length >= 2) {
      const lastDate = dates[dates.length - 1];
      const m = lastDate.match(/(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
      if (m) {
        const [, d, mo, y, h, min, s] = m;
        const expiry = new Date(`${y}-${mo}-${d}T${h}:${min}:${s}+08:00`);
        if (expiry < now) continue;
      }
    }
    const lower = row.toLowerCase();
    for (const state of KNOWN_STATES) {
      if (lower.includes(state)) activeStates.add(state);
    }
    const parens = lower.match(/\(([^)]+)\)/g);
    if (parens) {
      for (const p of parens) {
        const parts = p.replace(/[()]/g, '').split(/[,;]/);
        for (const part of parts) {
          const d = part.trim();
          if (d.length > 3 && !d.match(/^\d/) && 
              !['ribut','petir','hujan','lebat','angin','kencang','dijangka','sehingga'].includes(d)) {
            activeDistricts.add(d);
          }
        }
      }
    }
  }
  return { districts: activeDistricts, states: activeStates };
}

function isInActiveWarning(district, state, activeWarnings) {
  if (!activeWarnings) return false;
  const d = (district || '').toLowerCase().trim();
  const s = (state || '').toLowerCase().trim();
  for (const ad of activeWarnings.districts) {
    if (d.includes(ad) || ad.includes(d)) return true;
  }
  for (const as of activeWarnings.states) {
    if (s.includes(as) || as.includes(s)) return true;
  }
  return false;
}

// ============================================
// SCRAPER
// ============================================

const STATES = [
  { code:'PLS', name:'Perlis' },{ code:'KDH', name:'Kedah' },
  { code:'PNG', name:'Pulau Pinang' },{ code:'PRK', name:'Perak' },
  { code:'SGR', name:'Selangor' },{ code:'WPL', name:'WP Kuala Lumpur' },
  { code:'WPJ', name:'WP Putrajaya' },{ code:'NSN', name:'Negeri Sembilan' },
  { code:'MLK', name:'Melaka' },{ code:'JHR', name:'Johor' },
  { code:'PHG', name:'Pahang' },{ code:'TRG', name:'Terengganu' },
  { code:'KTN', name:'Kelantan' },{ code:'SWK', name:'Sarawak' },
  { code:'SBH', name:'Sabah' },{ code:'LBN', name:'WP Labuan' },
];

class Scraper {
  async scrapeAll(geocoder) {
    const t0 = Date.now();
    logger.info('⚡ Scraping 16 states...');
    
    const browser = await playwright.chromium.launch({ 
      headless: true, 
      args: ['--no-sandbox','--disable-dev-shm-usage'] 
    });
    
    const allRiver = [];
    const allRain = [];
    
    try {
      for (const st of STATES) {
        try {
          const [river, rain] = await Promise.all([
            this.scrapeRiver(browser, st),
            this.scrapeRain(browser, st)
          ]);
          allRiver.push(...river);
          allRain.push(...rain);
        } catch (e) { logger.warn(`  ⚠️ ${st.name}: ${e.message}`); }
        await sleep(150);
      }
    } finally { await browser.close(); }

    const rainMap = new Map();
    for (const r of allRain) {
      if (r.station_id) rainMap.set(r.station_id, r.rainfall || 0);
    }

    const merged = new Map();
    for (const s of allRiver) {
      const ex = merged.get(s.station_id);
      if (!ex || (s.water_level !== null && ex.water_level === null)) {
        const rainfall = rainMap.get(s.station_id) || 0;
        merged.set(s.station_id, {
          ...s,
          rainfall,
          rainfall_category: rainfall > 60 ? 'Sangat Lebat' : rainfall > 30 ? 'Lebat' : rainfall > 10 ? 'Sederhana' : rainfall > 0 ? 'Renyai' : 'Tiada Hujan'
        });
      }
    }
    
    const uniq = Array.from(merged.values());
    logger.info(`📊 ${uniq.length} unique (${allRiver.length}R + ${allRain.length}🌧️)`);

    const coordMap = await geocoder.resolveAll(uniq);

    const [floodHtml, weatherHtml] = await Promise.all([
      this.fetchRaw(`${CONFIG.INFOBANJIR_BASE}/ramalan/amaran-banjir/`),
      this.fetchRaw(`${CONFIG.INFOBANJIR_BASE}/ramalan/met-alert/`)
    ]);
    
    const floodWarnings = parseActiveWarnings(floodHtml);
    const weatherAlerts = parseActiveWarnings(weatherHtml);
    
    logger.info(`⚠️ Flood: ${floodWarnings.states.size}S ${floodWarnings.districts.size}D | 🌩️ Weather: ${weatherAlerts.states.size}S ${weatherAlerts.districts.size}D`);

    const now = new Date();
    const proc = uniq.map(s => {
      const coords = coordMap.get(s.station_id) || getCoords(s.district, s.state);
      const fw = isInActiveWarning(s.district, s.state, floodWarnings) ? 'Active' : '';
      const wa = isInActiveWarning(s.district, s.state, weatherAlerts) ? 'Active' : '';
      const stationTime = parseMalaysiaTime(s.last_updated_raw);
      
      const { water_level: wl, threshold_warning: tw, threshold_alert: ta, threshold_danger: td } = s;
      let status = 'NORMAL';
      if (wl === null) status = 'NO_DATA';
      else if (td > 0 && wl >= td) status = 'DANGER';
      else if (ta > 0 && wl >= ta) status = 'ALERT';
      else if (tw > 0 && wl >= tw) status = 'WARNING';

      let risk = 5;
      if (status === 'DANGER' && wl !== null && td > 0) risk = 80 + Math.min(20, ((wl-td)/td)*100);
      else if (status === 'ALERT' && wl !== null && ta > 0) { const r = (td||ta*1.15)-ta; risk = 60+(r>0?Math.min(20,((wl-ta)/r)*20):0); }
      else if (status === 'WARNING' && wl !== null && tw > 0) { const r = (ta||tw*1.3)-tw; risk = 35+(r>0?Math.min(25,((wl-tw)/r)*25):0); }
      else if (status === 'NORMAL' && wl !== null && tw > 0) risk = Math.min(35, (wl/tw)*35);
      
      if (fw) risk = Math.min(100, risk + 10);
      risk = Math.min(100, risk + Math.min(15, (s.rainfall||0)/4));

      return {
        station_id: s.station_id, station_name: s.station_name,
        district: s.district || '', state: s.state || '', state_code: s.state_code || '',
        river_basin: s.river_basin || '',
        water_level: s.water_level,
        threshold_normal: s.threshold_normal || 0, threshold_warning: tw || 0,
        threshold_alert: ta || 0, threshold_danger: td || 0,
        latitude: coords.lat, longitude: coords.lon,
        rainfall: s.rainfall || 0, rainfall_category: s.rainfall_category || 'Tiada Hujan',
        flood_warning: fw, weather_alert: wa,
        alert_active: !!(fw || wa || status === 'DANGER' || status === 'ALERT'),
        status, risk_score: parseFloat(Math.min(100, Math.max(0, risk)).toFixed(2)),
        last_updated: s.last_updated_raw || '',
        coord_source: coords.source || 'district_table',
        timestamp: stationTime || now.toISOString(),
        created_at: now.toISOString(),
      };
    });

    const counts = {};
    proc.forEach(s => counts[s.status] = (counts[s.status] || 0) + 1);
    const activeFW = proc.filter(s => s.flood_warning === 'Active').length;
    const activeWA = proc.filter(s => s.weather_alert === 'Active').length;
    const withRain = proc.filter(s => s.rainfall > 0).length;
    
    const alertStations = proc.filter(s => ['DANGER','ALERT','WARNING'].includes(s.status));
    if (alertStations.length) {
      logger.info(`🚨 Alerts:`);
      alertStations.forEach(s => logger.info(`  ${s.status}: ${s.station_name} (${s.state}) WL:${s.water_level}m`));
    }
    
    logger.info(`📊 ${Object.entries(counts).map(([k,v])=>`${k}:${v}`).join(' | ')} | ⚠️FW:${activeFW} 🌩️WA:${activeWA} 🌧️${withRain}`);
    
    return { stations: proc, duration: ((Date.now() - t0) / 1000).toFixed(1) };
  }

  async scrapeRiver(browser, state) {
    const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0' });
    const pg = await ctx.newPage();
    try {
      await pg.goto(`${CONFIG.INFOBANJIR_BASE}/aras-air/data-paras-air/?state=${state.code}`, { 
        waitUntil: 'domcontentloaded', timeout: CONFIG.PAGE_TIMEOUT_MS 
      });
      await pg.waitForTimeout(CONFIG.PAGE_WAIT_MS);
      
      return await pg.evaluate((si) => {
        const r = [];
        document.querySelectorAll('table tr').forEach((row, idx) => {
          if (idx < 2) return;
          const c = row.querySelectorAll('td');
          if (c.length < 8) return;
          
          const id = (c[1]?.textContent||'').trim();
          const nm = (c[2]?.textContent||'').trim();
          
          if (!id || id === 'No Data' || nm.length < 3) return;
          if (/^(bilangan|id stesen|nama stesen|petunjuk|normal|waspada|amaran|bahaya)$/i.test(nm)) return;
          
          const n = (x, fb = 0) => { 
            const v = parseFloat((x?.textContent||'').replace(/[^0-9.-]/g,'')); 
            return isNaN(v) ? fb : v; 
          };
          const wl = n(c[7], null);
          
          r.push({ 
            station_id: id, station_name: nm, 
            district: (c[3]?.textContent||'').trim(), 
            state: si.name, state_code: si.code,
            river_basin: (c[4]?.textContent||'').trim(), 
            water_level: (wl === null || wl <= -9998) ? null : wl,
            threshold_normal: n(c[8]), threshold_warning: n(c[9]), 
            threshold_alert: n(c[10]), threshold_danger: n(c[11]),
            last_updated_raw: (c[6]?.textContent||'').trim() 
          });
        });
        return r;
      }, state);
    } catch { return []; } 
    finally { await ctx.close(); }
  }

  async scrapeRain(browser, state) {
    const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0' });
    const pg = await ctx.newPage();
    try {
      await pg.goto(`${CONFIG.INFOBANJIR_BASE}/hujan/data-hujan/?state=${state.code}&district=ALL&station=ALL`, { 
        waitUntil: 'domcontentloaded', timeout: CONFIG.PAGE_TIMEOUT_MS 
      });
      await pg.waitForTimeout(1500);
      
      return await pg.evaluate(() => {
        const r = [];
        document.querySelectorAll('table tr').forEach((row, idx) => {
          if (idx < 3) return;
          const c = row.querySelectorAll('td');
          if (c.length < 5) return;
          
          const id = (c[1]?.textContent||'').trim();
          if (!id || id === 'No Data') return;
          
          let rain = 0;
          for (let i = 3; i < c.length; i++) { 
            const t = (c[i]?.textContent||'').trim(); 
            const m = t.match(/^(\d+(?:\.\d+)?)\s*(?:mm)?$/); 
            if (m) { rain = parseFloat(m[1]); break; } 
          }
          r.push({ station_id: id, rainfall: rain });
        });
        return r;
      });
    } catch { return []; } 
    finally { await ctx.close(); }
  }

  async fetchRaw(url) { 
    try { const r = await axios.get(url, { timeout: 10000 }); return r.data; } 
    catch { return ''; } 
  }
}

// ============================================
// FULL NOTIFICATION SYSTEM (WhatsApp + Telegram)
// ============================================

class Notifier {
  constructor() {
    this.TELEGRAM_BOT_TOKEN = CONFIG.TELEGRAM_BOT_TOKEN;
    this.YILZI_API_KEY = CONFIG.YILZI_API_KEY;
    this.YILZI_BASE_URL = CONFIG.YILZI_BASE_URL;
  }

  async sendWhatsApp(to, message) {
    if (!this.YILZI_API_KEY) return false;
    try {
      const res = await axios.post(
        `${this.YILZI_BASE_URL}/send/message?device=1`,
        { to: to.replace(/\D/g, ''), message },
        { headers: { 'Authorization': `Bearer ${this.YILZI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 }
      );
      return res.data?.success || false;
    } catch { return false; }
  }

  async sendTelegram(chatId, message) {
    if (!this.TELEGRAM_BOT_TOKEN || !chatId) return false;
    try {
      const res = await axios.post(
        `https://api.telegram.org/bot${this.TELEGRAM_BOT_TOKEN}/sendMessage`,
        { chat_id: chatId, text: message, parse_mode: 'HTML', disable_web_page_preview: true },
        { timeout: 10000 }
      );
      return res.data?.ok || false;
    } catch { return false; }
  }

  buildAlertMessage(station) {
    const isDanger = station.status === 'DANGER';
    const emoji = isDanger ? '🔴' : '🟠';
    const level = isDanger ? 'BAHAYA' : 'AMARAN';
    
    const telegramMsg = 
      `<b>${emoji} ${level} — FloodIntel</b>\n\n` +
      `<b>Stesen:</b> ${station.station_name}\n` +
      `<b>Paras Air:</b> ${station.water_level}m\n` +
      `<b>Paras Bahaya:</b> ${station.threshold_danger}m\n` +
      `<b>Paras Amaran:</b> ${station.threshold_alert}m\n` +
      `<b>Lokasi:</b> ${station.district}, ${station.state}\n` +
      `<b>Skor Risiko:</b> ${station.risk_score}/100\n` +
      (station.rainfall > 0 ? `<b>Hujan:</b> ${station.rainfall}mm\n` : '') +
      `\n🕐 ${formatMY()}\n` +
      `<a href="https://floodintel.vercel.app/alerts">🔗 Lihat di FloodIntel</a>`;

    const waMsg = 
      `${emoji} *${level} — FLOODINTEL*\n\n` +
      `*Stesen:* ${station.station_name}\n` +
      `*Paras Air:* ${station.water_level}m\n` +
      `*Paras Bahaya:* ${station.threshold_danger}m\n` +
      `*Paras Amaran:* ${station.threshold_alert}m\n` +
      `*Lokasi:* ${station.district}, ${station.state}\n` +
      `*Skor Risiko:* ${station.risk_score}/100\n` +
      (station.rainfall > 0 ? `*Hujan:* ${station.rainfall}mm\n` : '') +
      `\n🕐 ${formatMY()}\n` +
      `🔗 https://floodintel.vercel.app/alerts`;

    return { telegramMsg, waMsg };
  }

  async sendToSubscribers(dangerStations) {
    if (!dangerStations.length) return;

    logger.info(`📢 Sending alerts for ${dangerStations.length} stations to subscribers...`);

    try {
      const { data: profiles } = await supabase.from('profiles').select('*');

      if (!profiles?.length) {
        logger.info('No profiles found');
        return;
      }

      let telegramSent = 0;
      let whatsappSent = 0;
      let usersNotified = 0;

      for (const station of dangerStations) {
        const { telegramMsg, waMsg } = this.buildAlertMessage(station);
        
        for (const profile of profiles) {
          const threshold = profile.risk_threshold || 70;
          if (station.risk_score < threshold) continue;

          let sent = false;

          // Send Telegram if: telegram=true AND telegram_chat_id has value
          if (profile.notification_prefs?.telegram === true && profile.telegram_chat_id) {
            const success = await this.sendTelegram(profile.telegram_chat_id, telegramMsg);
            if (success) { telegramSent++; sent = true; }
            await sleep(200);
          }

          // Send WhatsApp if: whatsapp=true AND phone_number has value
          if (profile.notification_prefs?.whatsapp === true && profile.phone_number) {
            const cleanPhone = profile.phone_number.replace(/\D/g, '');
            if (cleanPhone.length >= 10) {
              const success = await this.sendWhatsApp(cleanPhone, waMsg);
              if (success) { whatsappSent++; sent = true; }
              await sleep(500);
            }
          }

          if (sent) usersNotified++;
        }
        await sleep(500);
      }

      logger.info(`📊 Notifications: ${telegramSent} Telegram + ${whatsappSent} WhatsApp sent to ${usersNotified} users`);
    } catch (error) {
      logger.error('Subscriber notification error:', error.message);
    }
  }

  async sendAdminReport({ stations, duration }) {
    const danger = stations.filter(s => s.status === 'DANGER');
    const alert = stations.filter(s => s.status === 'ALERT');
    const warning = stations.filter(s => s.status === 'WARNING');
    const activeFW = stations.filter(s => s.flood_warning === 'Active').length;
    const withRain = stations.filter(s => s.rainfall > 0).length;
    
    let msg = `🌊 *FLOODINTEL v10.0*\n📅 ${formatMY()}\n\n`;
    msg += `━━━━━━━━━━━━━━━━━\n`;
    msg += `📊 *${stations.length} STATIONS* | ⚡${duration}s\n`;
    if (danger.length) msg += `🔴 DANGER: ${danger.length}\n`;
    if (alert.length) msg += `🟠 ALERT: ${alert.length}\n`;
    if (warning.length) msg += `🟡 WARNING: ${warning.length}\n`;
    msg += `⚠️ Active Warnings: ${activeFW}\n`;
    msg += `🌧️ Rain: ${withRain} stations\n`;
    msg += `\n🔗 _FloodIntel BIICC 2026_`;
    await this.sendWhatsApp(CONFIG.ADMIN_WHATSAPP, msg);
    
    const crit = [...danger, ...alert].sort((a,b)=>b.risk_score-a.risk_score);
    if (crit.length) {
      let am = `🚨 *CRITICAL*\n\n`;
      for (const s of crit.slice(0, 5)) {
        am += `${s.status==='DANGER'?'🔴':'🟠'} ${s.station_name}\n`;
        am += `  🌊${s.water_level}m (D:${s.threshold_danger})\n`;
        am += `  📍${s.district}, ${s.state}\n\n`;
      }
      await this.sendWhatsApp(CONFIG.ADMIN_WHATSAPP, am);
    }
    
    await this.sendWhatsApp(CONFIG.ADMIN_WHATSAPP, `✅ *SYSTEM OK*\n🟢 v10.0 | Auto-cleanup: ${CONFIG.DATA_RETENTION_HOURS}h`);
  }

  async sendFullReport(result) {
    await this.sendAdminReport(result);
    const dangerStations = result.stations.filter(s => s.status === 'DANGER' || s.status === 'ALERT');
    if (dangerStations.length > 0) {
      await this.sendToSubscribers(dangerStations);
    }
  }
}

// ============================================
// TELEGRAM BOT WEBHOOK
// ============================================

async function handleTelegramWebhook(req, res) {
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const update = JSON.parse(body);
        if (update.message) {
          const chatId = update.message.chat.id;
          const text = update.message.text || '';
          
          if (text === '/start') {
            const msg = 
              '🌊 *FloodIntel Bot*\n\n' +
              'Anda akan menerima amaran banjir!\n\n' +
              'Chat ID anda: `' + chatId + '`\n\n' +
              '📋 Masukkan ID ini di Profil FloodIntel\n' +
              '🔗 floodintel.vercel.app/profile\n\n' +
              'Hantar /stop untuk berhenti.';
            
            await axios.post(
              `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`,
              { chat_id: chatId, text: msg, parse_mode: 'Markdown' }
            );
            logger.info(`📝 New Telegram user: ${chatId}`);
          } else if (text === '/stop') {
            await axios.post(
              `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`,
              { chat_id: chatId, text: '✅ Anda berhenti menerima amaran. Hantar /start untuk mula semula.' }
            );
          }
        }
        res.writeHead(200); res.end('OK');
      } catch { res.writeHead(500); res.end('Error'); }
    });
  } else {
    res.writeHead(200); res.end('FloodIntel Bot');
  }
}

// ============================================
// PIPELINE
// ============================================

class Pipeline {
  constructor(geocoder) { 
    this.geocoder = geocoder; 
    this.scraper = new Scraper(); 
    this.notifier = new Notifier();
    this.running = false; 
  }
  
  async run() {
    if (this.running) { logger.warn('⚠️ Already running'); return; }
    this.running = true;
    
    try {
      const result = await this.scraper.scrapeAll(this.geocoder);
      const inserted = await db.insertBatch(result.stations);
      await db.deleteOldData();
      await db.manageAlerts(result.stations);
      
      logger.info(`💾 DB: ${inserted}/${result.stations.length} | 🧹 Cleaned | 📋 Alerts managed`);
      
      // Send full report (admin + subscribers)
      await this.notifier.sendFullReport(result);
    } catch (e) { 
      logger.error('Pipeline:', e.message); 
    } finally { 
      this.running = false; 
    }
  }
}

// ============================================
// MAIN
// ============================================

async function main() {
  console.log('\n🌊 FLOODINTEL v10.0 FINAL\n');
  console.log(`🧹 Auto-delete: ${CONFIG.DATA_RETENTION_HOURS}h | 📋 Auto-alerts: ON`);
  console.log(`📱 WhatsApp: ${CONFIG.ADMIN_WHATSAPP} | 🤖 Telegram: ${CONFIG.TELEGRAM_BOT_TOKEN ? 'ON' : 'OFF'}\n`);
  
  const cache = new GeocodeCache(CONFIG.GEOCODE_CACHE_FILE);
  cache.load();
  
  const geocoder = new Geocoder(cache);
  await db.initTables();
  
  const pipeline = new Pipeline(geocoder);
  
  // HTTP Server (Health API + Telegram Webhook)
  http.createServer((req, res) => {
    if (req.url?.startsWith('/telegram-webhook')) {
      return handleTelegramWebhook(req, res);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'ok', version: '10.0', 
      retention: `${CONFIG.DATA_RETENTION_HOURS}h`,
      running: pipeline.running,
      uptime: Math.floor(process.uptime()) + 's'
    }));
  }).listen(CONFIG.HTTP_PORT, () => logger.info(`🌐 API :${CONFIG.HTTP_PORT}`));
  
  // Cron
  cron.schedule(CONFIG.CRON_SCHEDULE, () => pipeline.run().catch(e => logger.error(e)));
  logger.info(`⏰ Cron: ${CONFIG.CRON_SCHEDULE}`);
  
  // Initial run
  await pipeline.run();
  logger.info('✅ Worker ready');
}

// Graceful shutdown
process.on('SIGINT', () => { logger.info('👋 Shutting down...'); process.exit(0); });
process.on('SIGTERM', () => { logger.info('👋 Shutting down...'); process.exit(0); });

main().catch(e => { logger.error('Fatal:', e.message); process.exit(1); });