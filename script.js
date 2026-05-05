/* DATA */
let labels = [];
let suhuData = [];
let kelembapanData = [];
let amoniaData = [];
let dataLog = [];
let monitoringActive = false;
let lastAppliedReadingKey = null;

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
  if (v == null || v.suhu == null) return null;

  const suhu =
    typeof v.suhu === 'number' ? v.suhu.toFixed(1) : String(v.suhu);
  const kelembapan =
    v.kelembapan != null
      ? typeof v.kelembapan === 'number'
        ? v.kelembapan.toFixed(1)
        : String(v.kelembapan)
      : '0';
  const amonia =
    v.amonia != null
      ? typeof v.amonia === 'number'
        ? v.amonia.toFixed(1)
        : String(v.amonia)
      : '0';

  const s = parseFloat(suhu);
  const k = parseFloat(kelembapan);
  const a = parseFloat(amonia);

  let heater = v.heater;
  let intake = v.intake;
  let exhaust = v.exhaust;

  if (heater !== 'ON' && heater !== 'OFF') {
    heater = s < 32 ? 'ON' : 'OFF';
  }
  if (intake !== 'ON' && intake !== 'OFF') {
    intake = s > 35 || k > 70 || a >= 25 ? 'ON' : 'OFF';
  }
  if (exhaust !== 'ON' && exhaust !== 'OFF') {
    exhaust = intake;
  }

  return { suhu, kelembapan, amonia, heater, intake, exhaust };
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

  const { suhu, kelembapan, amonia, heater, intake, exhaust } = n;

  document.getElementById('suhu').innerText = suhu + '°C';
  document.getElementById('kelembapan').innerText = kelembapan + '%';
  document.getElementById('amonia').innerText = amonia + ' ppm';

  setColor('suhu', suhu, 32, 35);
  setColor('kelembapan', kelembapan, 60, 70);
  setAmoniaColor('amonia', amonia);

  setStatus('heater', heater);
  setStatus('intake', intake);
  setStatus('exhaust', exhaust);

  addTable(suhu, kelembapan, amonia, heater, intake, exhaust, ts);

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
  el.innerText = id.toUpperCase() + ': ' + status;
  el.className = 'status ' + (status === 'ON' ? 'on' : 'off');
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
  row.insertCell(6).innerText = heater;
  row.insertCell(7).innerText = intake;
  row.insertCell(8).innerText = exhaust;

  dataLog.unshift([suhu, kelembapan, amonia, heater, intake, exhaust]); // 🔥 juga dibalik

  updateNumbering();
}

/* NOMOR OTOMATIS */
function updateNumbering() {
  let table = document.getElementById('dataTable');

  for (let i = 1; i < table.rows.length; i++) {
    table.rows[i].cells[0].innerText = i;
  }
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

  setStatus('heater', 'OFF');
  setStatus('intake', 'OFF');
  setStatus('exhaust', 'OFF');

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

window.resetDashboard = resetDashboard;
window.startMonitoring = startMonitoring;
window.stopMonitoring = stopMonitoring;
window.applyReadingFromFirebase = applyReadingFromFirebase;
window.setAwaitingSensor = setAwaitingSensor;
