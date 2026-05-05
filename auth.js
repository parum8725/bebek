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

const cfg = window.__firebaseConfig;
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

function detachRtdb() {
  if (rtdbUnsubscribe) {
    rtdbUnsubscribe();
    rtdbUnsubscribe = null;
  }
}

function attachRtdb(app) {
  detachRtdb();
  const db = getDatabase(app);
  const latestRef = ref(db, 'readings/latest');

  rtdbUnsubscribe = onValue(latestRef, (snap) => {
    const v = snap.val();
    if (v && typeof window.applyReadingFromFirebase === 'function') {
      window.applyReadingFromFirebase(v);
    } else if (typeof window.setAwaitingSensor === 'function') {
      window.setAwaitingSensor(true);
    }
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
      const uid = user.uid;
      if (uid !== lastUid) {
        lastUid = uid;
        showDashboardView();
        if (typeof window.resetDashboard === 'function') window.resetDashboard();
        attachRtdb(firebaseApp);
        if (typeof window.startMonitoring === 'function') window.startMonitoring();
      }
    } else {
      lastUid = null;
      detachRtdb();
      if (typeof window.stopMonitoring === 'function') window.stopMonitoring();
      if (typeof window.resetDashboard === 'function') window.resetDashboard();
      showAuthView();
    }
  });
}

boot().catch(console.error);
