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
  apiKey: 'AIzaSyD9bwhgAF5zocWLcxtEaHlVNthUmsM8cpg',
  authDomain: 'mikroklimat-dod-id.firebaseapp.com',
  databaseURL: 'https://mikroklimat-dod-id-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'mikroklimat-dod-id',
  storageBucket: 'mikroklimat-dod-id.firebasestorage.app',
  messagingSenderId: '794594833967',
  appId: '1:794594833967:web:f58153993f51ad1447f8da',
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

async function loadChartFallback() {
  // Ambil range tanggal dari data
  const [{ data: minRow }, { data: maxRow }] = await Promise.all([
    supabase.from('monitoring').select('timestamp').order('timestamp', { ascending: true }).limit(1),
    supabase.from('monitoring').select('timestamp').order('timestamp', { ascending: false }).limit(1),
  ]);
  if (!minRow?.length || !maxRow?.length) return;

  // Buat array 7 hari terakhir yang ada datanya
  const maxDate = new Date(maxRow[0].timestamp);
  const days = [];
  const cur = new Date(maxDate);
  cur.setUTCHours(0, 0, 0, 0);
  for (let i = 6; i >= 0; i--) {
    const start = new Date(cur);
    start.setUTCDate(cur.getUTCDate() - i);
    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 1);
    days.push({ start: start.toISOString(), end: end.toISOString() });
  }

  // Fetch 1000 baris per hari sebagai sample, hitung rata-rata
  const avg = arr => arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : null;

  const results = await Promise.all(days.map(async ({ start, end }) => {
    const { data } = await supabase
      .from('monitoring')
      .select('timestamp,suhu,kelembapan,amonia')
      .gte('timestamp', start)
      .lt('timestamp', end)
      .limit(1000);
    if (!data?.length) return null;
    return {
      hari: start.slice(0, 10),
      avg_suhu:       avg(data.map(r => r.suhu)),
      avg_kelembapan: avg(data.map(r => r.kelembapan)),
      avg_amonia:     avg(data.map(r => r.amonia)),
    };
  }));

  const valid = results.filter(Boolean);
  console.log('📊 Fallback chart loaded:', valid.length, 'hari');
  if (typeof window.loadChartData === 'function') window.loadChartData(valid);
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
