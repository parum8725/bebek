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
import {
  getFirestore,
  collection,
  addDoc,
  query,
  orderBy,
  getDocs,
  Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

// Firebase config
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
  !cfg ||
  !cfg.apiKey ||
  cfg.apiKey === 'GANTI_API_KEY' ||
  String(cfg.apiKey).includes('GANTI');

const elApp = document.getElementById('dashboard-app');
const elHeaderTitle = document.querySelector('.header-title');

let auth = null;
let firebaseApp = null;
let rtdbUnsubscribe = null;
let controlUnsubscribe = null;
let modeUnsubscribe = null;
let lastRelayStatus = { heater: 'OFF', intake: 'OFF', exhaust: 'OFF' };
let currentUserId = null;

function detachRtdb() {
  if (rtdbUnsubscribe) {
    rtdbUnsubscribe();
    rtdbUnsubscribe = null;
  }
}

function detachControl() {
  if (controlUnsubscribe) {
    controlUnsubscribe();
    controlUnsubscribe = null;
  }
}

function detachMode() {
  if (modeUnsubscribe) {
    modeUnsubscribe();
    modeUnsubscribe = null;
  }
}

function attachMode(app) {
  detachMode();
  const db = getDatabase(app);
  // ESP membaca mode dari /control/mode — samakan path-nya
  modeUnsubscribe = onValue(ref(db, 'control/mode'), (snap) => {
    const mode = (snap.val() || 'auto').toLowerCase();
    if (typeof window.applyModeUI === 'function') window.applyModeUI(mode);

    if (mode === 'manual') {
      // Lepas listener status/ agar hardware tidak override tampilan relay
      detachControl();
    } else {
      // Sambungkan kembali agar tampilan relay ikut hardware
      attachControl(app);
    }
  });
}

async function writeMode(mode) {
  if (!firebaseApp) return;
  const db = getDatabase(firebaseApp);
  // ESP baca dari /control/mode — tulis ke path yang sama
  await set(ref(db, 'control/mode'), mode);
}

async function writeRelayControl(relayId, value) {
  if (!firebaseApp) return;
  const db = getDatabase(firebaseApp);
  // Hanya tulis ke control/ (dibaca hardware di mode manual)
  // Tampilan diupdate langsung via setStatus tanpa bergantung status/ di Firebase
  await set(ref(db, `control/${relayId}`), value);
  if (typeof window.setStatus === 'function') window.setStatus(relayId, value);
}

window.writeMode = writeMode;
window.writeRelayControl = writeRelayControl;

async function saveDataToFirestore(app, sensorData, relayStatus) {
  try {
    const db = getFirestore(app);
    const monitoringCollection = collection(db, 'monitoring');

    const docData = {
      timestamp: Timestamp.now(),
      suhu: parseFloat(sensorData.suhu) || 0,
      kelembapan: parseFloat(sensorData.kelembapan) || 0,
      amonia: parseFloat(sensorData.amonia) || 0,
      heater: relayStatus.heater || 'OFF',
      intake: relayStatus.intake || 'OFF',
      exhaust: relayStatus.exhaust || 'OFF',
    };

    await addDoc(monitoringCollection, docData);
    console.log('✅ Data saved to Firestore');
  } catch (error) {
    console.error('❌ Error saving to Firestore:', error);
  }
}

async function loadHistoryFromFirestore(app, retryCount = 0) {
  try {
    const db = getFirestore(app);
    const q = query(
      collection(db, 'monitoring'),
      orderBy('timestamp', 'desc')
    );

    const querySnapshot = await getDocs(q);
    const docs = [];
    querySnapshot.forEach((doc) => docs.push({ id: doc.id, ...doc.data() }));

    console.log('📥 Loaded', docs.length, 'dokumen dari Firestore');
    if (typeof window.loadHistoryFromFirestore === 'function') {
      window.loadHistoryFromFirestore(docs);
    }
  } catch (error) {
    const isIndexBuilding = error.message?.includes('index') || error.code === 'failed-precondition';
    if (isIndexBuilding && retryCount < 10) {
      const delayMs = 30_000; // coba lagi tiap 30 detik
      console.warn(`⏳ Firestore index masih building, retry ke-${retryCount + 1} dalam 30 detik...`);
      setTimeout(() => loadHistoryFromFirestore(app, retryCount + 1), delayMs);
    } else {
      console.error('❌ Error loading Firestore:', error);
    }
  }
}

function attachControl(app) {
  detachControl();
  const db = getDatabase(app);
  const statusRef = ref(db, 'status');

  console.log('🔗 Mendengarkan relay status dari:', 'status');

  controlUnsubscribe = onValue(statusRef, (snap) => {
    const v = snap.val();
    console.log('📡 Relay status dari Firebase:', v);

    if (v) {
      const heaterStatus = v.heater || 'OFF';
      const intakeStatus = v.intake || 'OFF';
      const exhaustStatus = v.exhaust || 'OFF';

      lastRelayStatus = { heater: heaterStatus, intake: intakeStatus, exhaust: exhaustStatus };

      if (typeof window.setStatus === 'function') {
        console.log('🔥 Update Heater:', heaterStatus);
        window.setStatus('heater', heaterStatus);

        console.log('💨 Update Intake:', intakeStatus);
        window.setStatus('intake', intakeStatus);

        console.log('💨 Update Exhaust:', exhaustStatus);
        window.setStatus('exhaust', exhaustStatus);
      }
    }
  }, (error) => {
    console.error('❌ Error membaca status:', error);
  });
}

function attachRtdb(app) {
  detachRtdb();
  const db = getDatabase(app);
  const sensorRef = ref(db, 'sensor');

  console.log('🔗 Menghubung ke Firebase Realtime DB:', 'sensor');

  // Throttle Firestore writes: simpan maks 1x per 30 detik (2.880 write/hari — aman di free tier)
  let lastFirestoreSave = 0;
  const FIRESTORE_INTERVAL_MS = 30_000;

  rtdbUnsubscribe = onValue(sensorRef, (snap) => {
    const v = snap.val();
    console.log('📨 Data sensor:', { suhu: v?.suhu, kelembaban: v?.kelembaban, gasAnalog: v?.gasAnalog });

    if (v && typeof window.applyReadingFromFirebase === 'function') {
      window.applyReadingFromFirebase(v);

      const now = Date.now();
      if (now - lastFirestoreSave >= FIRESTORE_INTERVAL_MS) {
        lastFirestoreSave = now;
        const relaySnapshot = { ...lastRelayStatus };
        saveDataToFirestore(app, {
          suhu: v.suhu,
          kelembapan: v.kelembaban,
          amonia: v.gas_ppm ?? v.gas,
        }, relaySnapshot);
      }
    } else if (typeof window.setAwaitingSensor === 'function') {
      window.setAwaitingSensor(true);
    }
  }, (error) => {
    console.error('❌ Error membaca Firebase:', error);
  });
}

function showDashboardView() {
  elApp.classList.remove('hidden');
  if (elHeaderTitle) {
    elHeaderTitle.textContent = 'Dashboard Monitoring Mikroklimat DOD 🐤';
  }
}

async function boot() {
  if (isPlaceholder) {
    console.error('Isi firebase-config.js dengan konfigurasi web app Firebase.');
    return;
  }

  firebaseApp = initializeApp(cfg);

  if (cfg.measurementId) {
    isSupported().then((yes) => {
      if (yes) getAnalytics(firebaseApp);
    });
  }

  auth = getAuth(firebaseApp);

  let lastUid = null;

  onAuthStateChanged(auth, (user) => {
    if (user) {
      console.log('👤 Anonymous user uid:', user.uid);
      const uid = user.uid;
      if (uid !== lastUid) {
        lastUid = uid;
        currentUserId = uid;
        showDashboardView();
        if (typeof window.resetDashboard === 'function') window.resetDashboard();
        attachRtdb(firebaseApp);
        // attachControl dipanggil oleh attachMode sesuai mode saat ini
        attachMode(firebaseApp);
        loadHistoryFromFirestore(firebaseApp);
        if (typeof window.startMonitoring === 'function') window.startMonitoring();
      }
    } else {
      detachMode();
      signInAnonymously(auth).catch(console.error);
    }
  });

  await signInAnonymously(auth);
}

boot().catch(console.error);
