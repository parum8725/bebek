import './script.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAnalytics,
  isSupported,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-analytics.js';
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { getDatabase, ref, onValue, set } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js';
import { createClient } from '@supabase/supabase-js';

// ── Firebase config ──────────────────────────────────────────────────────────
const cfg = window.__firebaseConfig || {
  apiKey: 'AIzaSyAiUdBLlfaemZ_aTytRiuHbvUurAGHnOgk',
  authDomain: 'mikroklimat-dod.firebaseapp.com',
  databaseURL: 'https://mikroklimat-dod-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'mikroklimat-dod',
  storageBucket: 'mikroklimat-dod.firebasestorage.app',
  messagingSenderId: '1020423643943',
  appId: '1:1020423643943:web:9fe4e849643821c5c87f02',
  measurementId: 'G-F55GHD73DH',
};

const isPlaceholder =
  !cfg || !cfg.apiKey || cfg.apiKey === 'GANTI_API_KEY' || String(cfg.apiKey).includes('GANTI');

// ── Supabase client ──────────────────────────────────────────────────────────
const SUPABASE_URL = 'https://meyseyyemqhgianummbb.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1leXNleXllbXFoZ2lhbnVtbWJiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxOTI4MDMsImV4cCI6MjA5NDc2ODgwM30._gwBfPX8aVv6vX0lllyt_dyi2Hi10LnrZdunFcAqOBA';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Globals ──────────────────────────────────────────────────────────────────
const elApp         = document.getElementById('dashboard-app');
const elHeaderTitle = document.querySelector('.header-title');

let auth          = null;
let firebaseApp   = null;
let rtdbUnsubscribe    = null;
let controlUnsubscribe = null;
let modeUnsubscribe    = null;
let lastRelayStatus    = { heater: 'OFF', intake: 'OFF', exhaust: 'OFF' };
let currentUserId      = null;

// ── RTDB helpers ─────────────────────────────────────────────────────────────
function detachRtdb()    { if (rtdbUnsubscribe)    { rtdbUnsubscribe();    rtdbUnsubscribe = null; } }
function detachControl() { if (controlUnsubscribe) { controlUnsubscribe(); controlUnsubscribe = null; } }
function detachMode()    { if (modeUnsubscribe)    { modeUnsubscribe();    modeUnsubscribe = null; } }

function attachMode(app) {
  detachMode();
  const db = getDatabase(app);
  modeUnsubscribe = onValue(ref(db, 'control/mode'), (snap) => {
    const mode = (snap.val() || 'auto').toLowerCase();
    if (typeof window.applyModeUI === 'function') window.applyModeUI(mode);
    if (mode === 'manual') detachControl();
    else attachControl(app);
  });
}

async function writeMode(mode) {
  if (!firebaseApp) return;
  const db = getDatabase(firebaseApp);
  await set(ref(db, 'control/mode'), mode);
}

async function writeRelayControl(relayId, value) {
  if (!firebaseApp) return;
  const db = getDatabase(firebaseApp);
  await set(ref(db, `control/${relayId}`), value);
  if (typeof window.setStatus === 'function') window.setStatus(relayId, value);
}

window.writeMode         = writeMode;
window.writeRelayControl = writeRelayControl;

function attachControl(app) {
  detachControl();
  const db        = getDatabase(app);
  const statusRef = ref(db, 'status');
  controlUnsubscribe = onValue(statusRef, (snap) => {
    const v = snap.val();
    if (!v) return;
    lastRelayStatus = {
      heater: v.heater  || 'OFF',
      intake: v.intake  || 'OFF',
      exhaust: v.exhaust || 'OFF',
    };
    if (typeof window.setStatus === 'function') {
      window.setStatus('heater',  lastRelayStatus.heater);
      window.setStatus('intake',  lastRelayStatus.intake);
      window.setStatus('exhaust', lastRelayStatus.exhaust);
    }
  }, console.error);
}

// ── Supabase: save sensor snapshot ───────────────────────────────────────────
async function saveDataToSupabase(sensorData, relayStatus) {
  const { error } = await supabase.from('monitoring').insert({
    timestamp:  new Date().toISOString(),
    suhu:       parseFloat(sensorData.suhu)      || 0,
    kelembapan: parseFloat(sensorData.kelembapan) || 0,
    amonia:     parseFloat(sensorData.amonia)    || 0,
    heater:     relayStatus.heater  || 'OFF',
    intake:     relayStatus.intake  || 'OFF',
    exhaust:    relayStatus.exhaust || 'OFF',
  });
  if (error) console.error('❌ Supabase insert:', error);
  else console.log('✅ Data saved to Supabase');
}

// ── Supabase: load chart ──────────────────────────────────────────────────────
async function loadChartFromSupabase() {
  // Coba RPC dulu (jika sudah dibuat di Supabase)
  const { data: rpcData, error: rpcErr } = await supabase.rpc('get_chart_harian');
  if (!rpcErr && rpcData) {
    if (typeof window.loadChartData === 'function') window.loadChartData(rpcData);
    return;
  }

  // Fallback: sampling per hari (tidak butuh SQL function)
  console.warn('⚠️ RPC tidak tersedia, pakai fallback sampling...');
  await loadChartFallback();
}

// YYYY-MM-DD dari komponen tanggal LOKAL (konsisten dgn tabel & label chart)
function ymdLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function loadChartFallback() {
  // 1) Anchor pada timestamp PALING AKHIR yang ada di Supabase
  const { data: maxRow } = await supabase
    .from('monitoring')
    .select('timestamp')
    .order('timestamp', { ascending: false })
    .limit(1);
  if (!maxRow?.length) {
    console.warn('⚠️ Tidak ada data di Supabase untuk chart.');
    return;
  }

  // 2) Mundur dari hari terakhir, kumpulkan 7 hari yang BENAR-BENAR punya data.
  //    Data bisa berlubang (ada gap antar tanggal), jadi jangan pakai 7 hari
  //    kalender mentah — itu bikin chart kosong.
  const DAYS_TARGET = 7;
  const MAX_SCAN    = 45;            // batas mundur maksimal (hari)
  const activeDays  = [];

  const anchor = new Date(maxRow[0].timestamp);
  anchor.setHours(0, 0, 0, 0);      // awal hari (lokal) dari tanggal terakhir

  for (let i = 0; i < MAX_SCAN && activeDays.length < DAYS_TARGET; i++) {
    const start = new Date(anchor);
    start.setDate(anchor.getDate() - i);
    const end = new Date(start);
    end.setDate(start.getDate() + 1);

    const { count } = await supabase
      .from('monitoring')
      .select('timestamp', { count: 'exact', head: true })
      .gte('timestamp', start.toISOString())
      .lt('timestamp', end.toISOString());

    if (count && count > 0) activeDays.push({ start, end, count });
  }

  // 3) Urutkan dari tanggal PALING AWAL → PALING AKHIR
  activeDays.reverse();

  // 4) Rata-rata representatif per hari: ambil sample di TENGAH hari
  //    (range offset di tengah) supaya tidak bias ke jam-jam awal saja.
  const avg = arr => arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : null;
  const SAMPLE = 1000;

  const results = [];
  for (const day of activeDays) {
    const offset = Math.max(0, Math.floor((day.count - SAMPLE) / 2));
    const { data } = await supabase
      .from('monitoring')
      .select('timestamp,suhu,kelembapan,amonia')
      .gte('timestamp', day.start.toISOString())
      .lt('timestamp', day.end.toISOString())
      .order('timestamp', { ascending: true })
      .range(offset, offset + SAMPLE - 1);
    if (!data?.length) continue;
    results.push({
      hari:           ymdLocal(day.start),
      avg_suhu:       avg(data.map(r => r.suhu)),
      avg_kelembapan: avg(data.map(r => r.kelembapan)),
      avg_amonia:     avg(data.map(r => r.amonia)),
    });
  }

  console.log('📊 Fallback chart loaded:', results.length, 'hari (urut awal→akhir):',
    results.map(r => r.hari).join(', '));
  if (typeof window.loadChartData === 'function') window.loadChartData(results);
}

// ── Supabase: load tabel halaman tertentu ────────────────────────────────────
const PAGE_SIZE = 10;

async function loadTablePage(page = 1) {
  if (typeof window.setHistoryLoading === 'function') window.setHistoryLoading(true, 0);

  const from = (page - 1) * PAGE_SIZE;
  const to   = from + PAGE_SIZE - 1;

  const { data, error, count } = await supabase
    .from('monitoring')
    .select('*', { count: 'exact' })
    .order('timestamp', { ascending: false })
    .range(from, to);

  if (error) {
    console.error('❌ Table load error:', error);
    if (typeof window.setHistoryLoading === 'function') window.setHistoryLoading(false, 0);
    return;
  }

  if (typeof window.renderTablePage === 'function') window.renderTablePage(data, count, page, PAGE_SIZE);
  if (typeof window.setHistoryLoading === 'function') window.setHistoryLoading(false, count);
}

// ── Supabase: fetch semua baris untuk export Excel ───────────────────────────
async function fetchAllRowsForExport() {
  const BATCH = 1000;
  let all  = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from('monitoring')
      .select('timestamp,suhu,kelembapan,amonia,heater,intake,exhaust')
      .order('timestamp', { ascending: true })
      .range(from, from + BATCH - 1);

    if (error || !data || data.length === 0) break;
    all  = all.concat(data);
    if (data.length < BATCH) break;
    from += BATCH;
  }
  return all;
}

window.loadTablePage          = loadTablePage;
window.fetchAllRowsForExport  = fetchAllRowsForExport;

// ── RTDB: sensor listener ─────────────────────────────────────────────────────
function attachRtdb(app) {
  detachRtdb();
  const db        = getDatabase(app);
  const sensorRef = ref(db, 'sensor');

  let lastSupabaseSave    = 0;
  const SUPABASE_INTERVAL = 30_000;

  rtdbUnsubscribe = onValue(sensorRef, (snap) => {
    const v = snap.val();
    if (v && typeof window.applyReadingFromFirebase === 'function') {
      window.applyReadingFromFirebase(v);

      const now = Date.now();
      if (now - lastSupabaseSave >= SUPABASE_INTERVAL) {
        lastSupabaseSave = now;
        saveDataToSupabase(
          { suhu: v.suhu, kelembapan: v.kelembaban, amonia: v.gas_ppm ?? v.gas },
          { ...lastRelayStatus }
        );
      }
    } else if (typeof window.setAwaitingSensor === 'function') {
      window.setAwaitingSensor(true);
    }
  }, (error) => {
    console.error('❌ RTDB listener error, reconnect 3s:', error);
    setTimeout(() => attachRtdb(app), 3_000);
  });
}

window.forceRtdbReconnect = () => {
  if (!firebaseApp) return;
  console.warn('🔄 Watchdog: reconnect RTDB');
  attachRtdb(firebaseApp);
};

// ── View helpers ──────────────────────────────────────────────────────────────
function showDashboardView() {
  elApp.classList.remove('hidden');
  if (elHeaderTitle) elHeaderTitle.textContent = 'Dashboard Monitoring Mikroklimat DOD 🐤';
  setTimeout(() => {
    if (typeof window.resizeCharts === 'function') window.resizeCharts();
  }, 0);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  if (isPlaceholder) {
    console.error('Isi firebase-config.js dengan konfigurasi Firebase.');
    return;
  }

  firebaseApp = initializeApp(cfg);

  isSupported().then((yes) => { if (yes) getAnalytics(firebaseApp); });

  auth = getAuth(firebaseApp);

  let lastUid = null;

  onAuthStateChanged(auth, async (user) => {
    if (user) {
      const uid = user.uid;
      if (uid !== lastUid) {
        lastUid       = uid;
        currentUserId = uid;
        showDashboardView();
        if (typeof window.resetDashboard === 'function') window.resetDashboard();
        attachRtdb(firebaseApp);
        attachMode(firebaseApp);
        if (typeof window.startMonitoring === 'function') window.startMonitoring();
        // Load chart dari Supabase (daily averages) lalu tabel halaman 1
        await loadChartFromSupabase();
        await loadTablePage(1);
      }
    } else {
      detachMode();
      signInAnonymously(auth).catch(console.error);
    }
  });

  await signInAnonymously(auth);
}

boot().catch(console.error);
