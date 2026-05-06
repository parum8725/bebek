import './script.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAnalytics,
  isSupported,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-analytics.js';
import {
  getAuth,
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  setPersistence,
  inMemoryPersistence,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { getDatabase, ref, onValue } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js';
import {
  getFirestore,
  collection,
  addDoc,
  query,
  where,
  orderBy,
  getDocs,
  limit,
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

const elAuth = document.getElementById('auth-screen');
const elApp = document.getElementById('dashboard-app');
const elLogout = document.getElementById('btn-logout');
const elTitle = document.getElementById('auth-title');
const elError = document.getElementById('auth-error');
const elEmail = document.getElementById('auth-email');
const elPassword = document.getElementById('auth-password');
const elSubmit = document.getElementById('auth-submit');
const elGoogle = document.getElementById('auth-google');
const elToggle = document.getElementById('auth-toggle');
const elHeaderTitle = document.querySelector('.header-title');

const googleProvider = new GoogleAuthProvider();

let mode = 'register';
let auth = null;
let firebaseApp = null;
let rtdbUnsubscribe = null;
let controlUnsubscribe = null;
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

async function saveDataToFirestore(app, userId, sensorData, relayStatus) {
  try {
    const db = getFirestore(app);
    const monitoringCollection = collection(db, 'monitoring');

    const docData = {
      userId,
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

async function loadHistoryFromFirestore(app, userId) {
  try {
    const db = getFirestore(app);
    const monitoringCollection = collection(db, 'monitoring');

    const q = query(
      monitoringCollection,
      where('userId', '==', userId),
      orderBy('timestamp', 'desc'),
      limit(100)
    );

    const querySnapshot = await getDocs(q);
    const docs = [];

    querySnapshot.forEach((doc) => {
      docs.push({
        id: doc.id,
        ...doc.data(),
      });
    });

    console.log('📥 Loaded', docs.length, 'documents from Firestore');
    if (typeof window.loadHistoryFromFirestore === 'function') {
      window.loadHistoryFromFirestore(docs);
    }
  } catch (error) {
    console.error('❌ Error loading from Firestore:', error);
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

  rtdbUnsubscribe = onValue(sensorRef, (snap) => {
    const v = snap.val();
    console.log('📨 Data dari Firebase:', v);
    console.log('📋 Detail struktur:', {
      suhu: v?.suhu,
      kelembapan: v?.kelembapan,
      amonia: v?.amonia,
      heater: v?.heater,
      intake: v?.intake,
      exhaust: v?.exhaust,
      updatedAt: v?.updatedAt
    });

    if (v && typeof window.applyReadingFromFirebase === 'function') {
      console.log('✅ Menampilkan data ke dashboard');
      window.applyReadingFromFirebase(v);

      if (currentUserId) {
        saveDataToFirestore(app, currentUserId, {
          suhu: v.suhu,
          kelembapan: v.kelembapan,
          amonia: v.gasAnalog,
        }, lastRelayStatus);
      }
    } else if (typeof window.setAwaitingSensor === 'function') {
      console.log('⏳ Menunggu data sensor...');
      window.setAwaitingSensor(true);
    }
  }, (error) => {
    console.error('❌ Error membaca Firebase:', error);
  });
}

function showError(msg) {
  elError.textContent = msg;
  elError.classList.remove('hidden');
}

function clearError() {
  elError.textContent = '';
  elError.classList.add('hidden');
}

function mapAuthError(code) {
  const map = {
    'auth/email-already-in-use': 'Email sudah terdaftar.',
    'auth/invalid-email': 'Format email tidak valid.',
    'auth/weak-password': 'Password minimal 6 karakter.',
    'auth/user-disabled': 'Akun dinonaktifkan.',
    'auth/user-not-found': 'Email atau password salah.',
    'auth/wrong-password': 'Email atau password salah.',
    'auth/invalid-credential': 'Email atau password salah.',
    'auth/too-many-requests': 'Terlalu banyak percobaan. Coba lagi nanti.',
    'auth/network-request-failed': 'Koneksi bermasalah. Periksa internet.',
    'auth/popup-blocked':
      'Popup diblokir browser. Izinkan popup untuk situs ini lalu coba lagi.',
    'auth/account-exists-with-different-credential':
      'Email ini sudah terdaftar dengan cara lain (misalnya password).',
    'auth/operation-not-allowed':
      'Masuk Google belum diaktifkan di Firebase Console (Authentication → Sign-in method).',
  };
  return map[code] || 'Terjadi kesalahan. Coba lagi.';
}

function setMode(next) {
  mode = next;
  clearError();
  if (mode === 'login') {
    elTitle.textContent = 'Masuk';
    elSubmit.textContent = 'Masuk';
    elToggle.textContent = 'Belum punya akun? Daftar';
    elPassword.autocomplete = 'current-password';
  } else {
    elTitle.textContent = 'Daftar';
    elSubmit.textContent = 'Daftar';
    elToggle.textContent = 'Sudah punya akun? Masuk';
    elPassword.autocomplete = 'new-password';
  }
}

function showAuthView() {
  elAuth.classList.remove('hidden');
  elApp.classList.add('hidden');
  elLogout.classList.add('hidden');
  if (elHeaderTitle) {
    elHeaderTitle.textContent = 'Mikroklimat DOD — Masuk atau Daftar 🐤';
  }
}

function showDashboardView() {
  elAuth.classList.add('hidden');
  elApp.classList.remove('hidden');
  elLogout.classList.remove('hidden');
  if (elHeaderTitle) {
    elHeaderTitle.textContent = 'Dashboard Monitoring Mikroklimat DOD 🐤';
  }
}

elToggle.addEventListener('click', () => {
  setMode(mode === 'login' ? 'register' : 'login');
});

elSubmit.addEventListener('click', async () => {
  clearError();
  const email = elEmail.value.trim();
  const password = elPassword.value;

  if (!email || !password) {
    showError('Isi email dan password.');
    return;
  }

  if (isPlaceholder) {
    showError('Isi firebase-config.js dengan data proyek Firebase Anda.');
    return;
  }

  elSubmit.disabled = true;
  try {
    if (mode === 'register') {
      await createUserWithEmailAndPassword(auth, email, password);
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }
  } catch (e) {
    showError(mapAuthError(e.code));
  } finally {
    elSubmit.disabled = false;
  }
});

elGoogle.addEventListener('click', async () => {
  clearError();

  if (isPlaceholder) {
    showError('Isi firebase-config.js dengan data proyek Firebase Anda.');
    return;
  }

  if (!auth) return;

  elGoogle.disabled = true;
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (e) {
    if (
      e.code === 'auth/popup-closed-by-user' ||
      e.code === 'auth/cancelled-popup-request'
    ) {
      clearError();
    } else {
      showError(mapAuthError(e.code));
    }
  } finally {
    elGoogle.disabled = false;
  }
});

elLogout.addEventListener('click', async () => {
  if (!auth) return;
  try {
    await signOut(auth);
  } catch (e) {
    showError(mapAuthError(e.code));
  }
});


[elEmail, elPassword].forEach((el) => {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') elSubmit.click();
  });
});

async function boot() {
  if (isPlaceholder) {
    showAuthView();
    setMode('register');
    showError('Isi firebase-config.js dengan konfigurasi web app Firebase.');
    elSubmit.disabled = true;
    elGoogle.disabled = true;
    return;
  }

  firebaseApp = initializeApp(cfg);

  if (cfg.measurementId) {
    isSupported().then((yes) => {
      if (yes) getAnalytics(firebaseApp);
    });
  }

  auth = getAuth(firebaseApp);
  await setPersistence(auth, inMemoryPersistence);
  await signOut(auth);

  setMode('register');

  let lastUid = null;

  onAuthStateChanged(auth, (user) => {
    if (user) {
      console.log('👤 User login:', user.email);
      const uid = user.uid;
      if (uid !== lastUid) {
        lastUid = uid;
        currentUserId = uid;
        showDashboardView();
        if (typeof window.resetDashboard === 'function') window.resetDashboard();
        attachRtdb(firebaseApp);
        attachControl(firebaseApp);
        loadHistoryFromFirestore(firebaseApp, uid);
        if (typeof window.startMonitoring === 'function') window.startMonitoring();
      }
    } else {
      console.log('👤 User logout');
      lastUid = null;
      currentUserId = null;
      detachRtdb();
      detachControl();
      if (typeof window.stopMonitoring === 'function') window.stopMonitoring();
      if (typeof window.resetDashboard === 'function') window.resetDashboard();
      showAuthView();
    }
  });
}

boot().catch(console.error);
