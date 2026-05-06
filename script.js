/* DATA */
let labels = [];
let suhuData = [];
let kelembapanData = [];
let amoniaData = [];
let dataLog = [];
let monitoringActive = false;
let lastAppliedReadingKey = null;
let relayStatus = { heater: 'OFF', intake: 'OFF', exhaust: 'OFF' };

/* PAGINATION */
let currentPage = 1;
const ROWS_PER_PAGE = 10;

/* AUTO MODE ONLY */
let lastSensorData = null;

/* CHART 1: SUHU + KELEMBAPAN */
let chart1 = new Chart(document.getElementById('chartSuhuKelembapan'), {
  type: 'line',
  data: {
    labels: labels,
    datasets: [
      {
        label: 'Suhu (°C)',
        data: suhuData,
        borderWidth: 2,
        tension: 0.3,
      },
      {
        label: 'Kelembapan (%)',
        data: kelembapanData,
        borderWidth: 2,
        tension: 0.3,
      },
    ],
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        labels: { font: { size: 10 } },
      },
    },
    scales: {
      x: {
        ticks: { font: { size: 9 } },
        grid: { display: false },
      },
      y: {
        ticks: { font: { size: 9 } },
      },
    },
  },
});

/* CHART 2: AMONIA */
let chart2 = new Chart(document.getElementById('chartAmonia'), {
  type: 'line',
  data: {
    labels: labels,
    datasets: [
      {
        label: 'Amonia (ppm)',
        data: amoniaData,
        borderWidth: 2,
        tension: 0.3,
      },
    ],
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        labels: { font: { size: 10 } },
      },
    },
    scales: {
      x: {
        ticks: { font: { size: 9 } },
        grid: { display: false },
      },
      y: {
        ticks: { font: { size: 9 } },
      },
    },
  },
});

function normalizeReading(v) {
  console.log('🔍 Normalizing data:', v);

  if (v == null || v.suhu == null) {
    console.log('❌ Data null atau suhu null, returning null');
    return null;
  }

  // Ambil data dari struktur sensor Firebase
  const suhu = typeof v.suhu === 'number' ? v.suhu.toFixed(1) : String(v.suhu ?? '-');

  // Fix typo: kelembaban → kelembapan (untuk display)
  const kelembapan =
    v.kelembaban != null
      ? (typeof v.kelembaban === 'number' ? v.kelembaban.toFixed(1) : String(v.kelembaban))
      : '0';

  // gasAnalog = nilai amonia dalam ppm
  const amonia =
    v.gasAnalog != null
      ? (typeof v.gasAnalog === 'number' ? v.gasAnalog.toFixed(1) : String(v.gasAnalog))
      : '0';

  // ⚠️ TIDAK generate relay status otomatis dari sensor data
  // Relay status diambil dari /control path di Firebase
  // Jadi return hanya sensor data (suhu, kelembapan, amonia)
  const result = { suhu, kelembapan, amonia, heater: null, intake: null, exhaust: null };
  console.log('✔️ Normalized result:', result);
  return result;
}

function readingTimestamp(v) {
  const t = v.updatedAt ?? v.loggedAt;
  if (typeof t === 'number' && !Number.isNaN(t)) return t;
  return Date.now();
}

function setAwaitingSensor(waiting) {
  const el = document.getElementById('sensor-waiting');
  if (!el) return;
  el.classList.toggle('hidden', !waiting);
}

function applyReadingFromFirebase(v) {
  const n = normalizeReading(v);
  if (!n) return;

  const ts = readingTimestamp(v);
  const dedupeKey = `${n.suhu}|${n.kelembapan}|${n.amonia}|${ts}`;
  if (dedupeKey === lastAppliedReadingKey) return;
  lastAppliedReadingKey = dedupeKey;

  setAwaitingSensor(false);

  const { suhu, kelembapan, amonia } = n;

  // Save sensor data
  lastSensorData = { suhu, kelembapan, amonia };

  document.getElementById('suhu').innerText = suhu + '°C';
  document.getElementById('kelembapan').innerText = kelembapan + '%';
  document.getElementById('amonia').innerText = amonia + ' ppm';

  setColor('suhu', suhu, 32, 35);
  setColor('kelembapan', kelembapan, 60, 70);
  setAmoniaColor('amonia', amonia);

  // Use current relay status from global variable
  addTable(suhu, kelembapan, amonia, relayStatus.heater, relayStatus.intake, relayStatus.exhaust, ts);

  const chartTime = new Date(ts).toLocaleTimeString();
  labels.push(chartTime);
  suhuData.push(suhu);
  kelembapanData.push(kelembapan);
  amoniaData.push(amonia);

  if (labels.length > 15) {
    labels.shift();
    suhuData.shift();
    kelembapanData.shift();
    amoniaData.shift();
  }

  chart1.update();
  chart2.update();
}

/* WARNA CARD */
function setColor(id, value, min, max) {
  let card = document.getElementById(id).parentElement;
  value = parseFloat(value);

  card.classList.remove('normal', 'danger');

  if (value >= min && value <= max) {
    card.classList.add('normal');
  } else {
    card.classList.add('danger');
  }
}

function setAmoniaColor(id, value) {
  let card = document.getElementById(id).parentElement;
  value = parseFloat(value);

  card.classList.remove('normal', 'danger');

  if (value < 25) {
    card.classList.add('normal');
  } else {
    card.classList.add('danger');
  }
}

/* STATUS */
function setStatus(id, status) {
  let el = document.getElementById(id);
  el.innerText = status;
  el.className = 'status ' + (status === 'ON' ? 'on' : 'off');

  // Track relay status globally
  if (id === 'heater') relayStatus.heater = status;
  if (id === 'intake') relayStatus.intake = status;
  if (id === 'exhaust') relayStatus.exhaust = status;

  // Update card background color
  let card = el.closest('.relay-card');
  if (card) {
    card.classList.remove('relay-on', 'relay-off');
    card.classList.add(status === 'ON' ? 'relay-on' : 'relay-off');
  }
}

/* TABEL HISTORI (🔥 FIX: DATA TERBARU DI ATAS) */
function addTable(suhu, kelembapan, amonia, heater, intake, exhaust, rowTs) {
  let table = document.getElementById('dataTable');

  let row = table.insertRow(1); // ✅ MASUK KE ATAS

  let t = rowTs != null ? new Date(rowTs) : new Date();

  row.insertCell(0);
  row.insertCell(1).innerText = t.toLocaleDateString();
  row.insertCell(2).innerText = t.toLocaleTimeString();
  row.insertCell(3).innerText = suhu;
  row.insertCell(4).innerText = kelembapan;
  row.insertCell(5).innerText = amonia;

  // ===== RELAY CELLS DENGAN STYLING =====
  let cellHeater = row.insertCell(6);
  cellHeater.innerText = heater;
  cellHeater.className = 'relay-cell ' + (heater === 'ON' ? 'relay-on' : 'relay-off');

  let cellIntake = row.insertCell(7);
  cellIntake.innerText = intake;
  cellIntake.className = 'relay-cell ' + (intake === 'ON' ? 'relay-on' : 'relay-off');

  let cellExhaust = row.insertCell(8);
  cellExhaust.innerText = exhaust;
  cellExhaust.className = 'relay-cell ' + (exhaust === 'ON' ? 'relay-on' : 'relay-off');

  dataLog.unshift([suhu, kelembapan, amonia, heater, intake, exhaust]); // 🔥 juga dibalik

  updateNumbering();
  updateTablePagination();
}

/* NOMOR OTOMATIS */
function updateNumbering() {
  let table = document.getElementById('dataTable');

  for (let i = 1; i < table.rows.length; i++) {
    table.rows[i].cells[0].innerText = i;
  }
}

/* PAGINATION */
function updateTablePagination() {
  let table = document.getElementById('dataTable');
  let tbody = document.getElementById('tableBody');

  const totalRows = tbody.rows.length;
  const totalPages = Math.ceil(totalRows / ROWS_PER_PAGE);

  // Validasi halaman
  if (currentPage > totalPages && totalPages > 0) {
    currentPage = totalPages;
  } else if (currentPage < 1) {
    currentPage = 1;
  }

  // Hitung range data yang ditampilkan
  const startIdx = (currentPage - 1) * ROWS_PER_PAGE;
  const endIdx = startIdx + ROWS_PER_PAGE;

  // Sembunyikan semua baris, tampilkan hanya yang di page ini
  const allRows = tbody.querySelectorAll('tr');
  allRows.forEach((row, idx) => {
    row.style.display = idx >= startIdx && idx < endIdx ? '' : 'none';
  });

  // Update info
  const startNo = totalRows > 0 ? startIdx + 1 : 0;
  const endNo = Math.min(endIdx, totalRows);
  document.getElementById('infoData').innerText =
    totalRows === 0 ? '0–0 dari 0 baris' : `${startNo}–${endNo} dari ${totalRows} baris`;

  // Update page info
  document.getElementById('pageInfo').innerText =
    totalPages === 0 ? '0 / 0' : `${currentPage} / ${totalPages}`;

  // Disable/enable buttons
  document.querySelectorAll('.pagination button').forEach(btn => {
    if (btn.textContent === 'Prev') {
      btn.disabled = currentPage <= 1;
    } else if (btn.textContent === 'Next') {
      btn.disabled = currentPage >= totalPages;
    }
  });
}

function nextPage() {
  currentPage++;
  updateTablePagination();
}

function prevPage() {
  if (currentPage > 1) {
    currentPage--;
  }
  updateTablePagination();
}

/* DOWNLOAD CSV */
function downloadCSV() {
  let csv = 'Suhu,Kelembapan,Amonia,Heater,Intake,Exhaust\n';

  dataLog.forEach((row) => {
    csv += row.join(',') + '\n';
  });

  let blob = new Blob([csv]);
  let link = document.createElement('a');

  link.href = URL.createObjectURL(blob);
  link.download = 'data_monitoring.csv';
  link.click();
}

function resetDashboard() {
  stopMonitoring();
  lastAppliedReadingKey = null;
  setAwaitingSensor(true);

  let table = document.getElementById('dataTable');
  while (table.rows.length > 1) {
    table.deleteRow(1);
  }

  dataLog.length = 0;
  labels.length = 0;
  suhuData.length = 0;
  kelembapanData.length = 0;
  amoniaData.length = 0;

  document.getElementById('suhu').innerText = '-';
  document.getElementById('kelembapan').innerText = '-';
  document.getElementById('amonia').innerText = '-';

  ['suhu', 'kelembapan', 'amonia'].forEach((id) => {
    let card = document.getElementById(id).parentElement;
    card.classList.remove('normal', 'danger');
  });

  // Reset pagination
  currentPage = 1;
  updateTablePagination();

  chart1.update();
  chart2.update();
}

function startMonitoring() {
  if (monitoringActive) return;
  /* Data hanya dari Realtime Database (listener di auth.js); tidak ada data dummy dari web. */
  monitoringActive = true;
}

function stopMonitoring() {
  monitoringActive = false;
}

function loadHistoryFromFirestore(docs) {
  console.log('📥 Loading', docs.length, 'documents dari Firestore');

  let table = document.getElementById('dataTable');
  while (table.rows.length > 1) {
    table.deleteRow(1);
  }

  dataLog.length = 0;
  labels.length = 0;
  suhuData.length = 0;
  kelembapanData.length = 0;
  amoniaData.length = 0;

  docs.forEach((doc) => {
    const data = doc.data ? doc : doc;
    const ts = data.timestamp?.toMillis ? data.timestamp.toMillis() : new Date(data.timestamp).getTime();

    addTable(data.suhu, data.kelembapan, data.amonia, data.heater, data.intake, data.exhaust, ts);
  });

  updateTablePagination();
  chart1.update();
  chart2.update();

  console.log('✅ History loaded dan ditampilkan');
}




window.resetDashboard = resetDashboard;
window.startMonitoring = startMonitoring;
window.stopMonitoring = stopMonitoring;
window.applyReadingFromFirebase = applyReadingFromFirebase;
window.setAwaitingSensor = setAwaitingSensor;
window.setStatus = setStatus;
window.nextPage = nextPage;
window.prevPage = prevPage;
window.downloadCSV = downloadCSV;
window.loadHistoryFromFirestore = loadHistoryFromFirestore;
