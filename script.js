/* DATA */
let labels = [];
let suhuData = [];
let kelembapanData = [];
let amoniaData = [];
let dataLog = [];
let monitoringActive = false;
let lastAppliedReadingKey = null;
let relayStatus = { heater: 'OFF', intake: 'OFF', exhaust: 'OFF' };
let currentMode = 'auto';
let historyLoading = false;

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

  // gas_ppm = nilai PPM NH3 dari MQ135; fallback ke gas ADC jika firmware lama
  const gasPpm = v.gas_ppm ?? v.gas;
  const amonia =
    gasPpm != null
      ? (typeof gasPpm === 'number' ? gasPpm.toFixed(1) : String(gasPpm))
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
  if (historyLoading) return;
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

  // Threshold NH3: > 25 ppm = bahaya (sesuai logika ESP autoControl)
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

  if (id === 'heater') relayStatus.heater = status;
  if (id === 'intake') relayStatus.intake = status;
  if (id === 'exhaust') relayStatus.exhaust = status;

  let card = el.closest('.relay-card');
  if (card) {
    card.classList.remove('relay-on', 'relay-off');
    card.classList.add(status === 'ON' ? 'relay-on' : 'relay-off');
  }

  const btn = document.getElementById('btn-' + id);
  if (btn) btn.textContent = status === 'ON' ? 'Matikan' : 'Nyalakan';
}

/* MODE OTOMATIS / MANUAL */
function applyModeUI(mode) {
  currentMode = mode;
  const label = document.getElementById('modeLabel');
  const btnToggle = document.getElementById('btn-mode-toggle');
  const relayBtns = document.querySelectorAll('.btn-toggle');

  if (mode === 'manual') {
    if (label) label.innerHTML = 'Mode: <strong style="color:#e67e22">MANUAL</strong>';
    if (btnToggle) btnToggle.textContent = 'Ganti ke Otomatis';
    relayBtns.forEach(btn => btn.classList.remove('hidden'));
  } else {
    if (label) label.innerHTML = 'Mode: <strong>OTOMATIS</strong>';
    if (btnToggle) btnToggle.textContent = 'Ganti ke Manual';
    relayBtns.forEach(btn => btn.classList.add('hidden'));
  }
}

function toggleMode() {
  const next = currentMode === 'auto' ? 'manual' : 'auto';
  if (typeof window.writeMode === 'function') {
    window.writeMode(next).catch(console.error);
  }
}

function toggleRelay(relayId) {
  const statusEl = document.getElementById(relayId);
  const current = statusEl ? statusEl.innerText.trim() : 'OFF';
  const next = current === 'ON' ? 'OFF' : 'ON';

  const btn = document.getElementById('btn-' + relayId);
  if (btn) btn.disabled = true;

  if (typeof window.writeRelayControl === 'function') {
    window.writeRelayControl(relayId, next)
      .catch(console.error)
      .finally(() => { if (btn) btn.disabled = false; });
  }
}

/* TABEL HISTORI — data terbaru di atas */
function addTable(suhu, kelembapan, amonia, heater, intake, exhaust, rowTs, skipUpdate = false) {
  const t = rowTs != null ? new Date(rowTs) : new Date();
  const tanggal = t.toLocaleDateString('id-ID');
  const jam = t.toLocaleTimeString('id-ID');

  const tbody = document.getElementById('tableBody');
  const row = tbody.insertRow(0); // explicit ke tbody, posisi 0 = teratas

  row.insertCell(0); // nomor — diisi updateNumbering()
  row.insertCell(1).innerText = tanggal;
  row.insertCell(2).innerText = jam;
  row.insertCell(3).innerText = suhu ?? '-';
  row.insertCell(4).innerText = kelembapan ?? '-';
  row.insertCell(5).innerText = amonia ?? '-';

  const heaterVal = heater ?? '-';
  const intakeVal  = intake  ?? '-';
  const exhaustVal = exhaust ?? '-';

  const cellHeater = row.insertCell(6);
  cellHeater.innerText = heaterVal;
  cellHeater.className = 'relay-cell ' + (heaterVal === 'ON' ? 'relay-on' : 'relay-off');

  const cellIntake = row.insertCell(7);
  cellIntake.innerText = intakeVal;
  cellIntake.className = 'relay-cell ' + (intakeVal === 'ON' ? 'relay-on' : 'relay-off');

  const cellExhaust = row.insertCell(8);
  cellExhaust.innerText = exhaustVal;
  cellExhaust.className = 'relay-cell ' + (exhaustVal === 'ON' ? 'relay-on' : 'relay-off');

  dataLog.unshift({ tanggal, jam, suhu: suhu ?? '-', kelembapan: kelembapan ?? '-', amonia: amonia ?? '-', heater: heaterVal, intake: intakeVal, exhaust: exhaustVal });

  if (!skipUpdate) {
    updateNumbering();
    updateTablePagination();
  }
}

/* NOMOR OTOMATIS */
function updateNumbering() {
  const tbody = document.getElementById('tableBody');
  for (let i = 0; i < tbody.rows.length; i++) {
    tbody.rows[i].cells[0].innerText = i + 1;
  }
}

/* PAGINATION */
function updateTablePagination() {
  const tbody = document.getElementById('tableBody');
  const totalRows  = tbody.rows.length;
  const totalPages = totalRows === 0 ? 1 : Math.ceil(totalRows / ROWS_PER_PAGE);

  // Clamp halaman
  if (currentPage < 1) currentPage = 1;
  if (currentPage > totalPages) currentPage = totalPages;

  const startIdx = (currentPage - 1) * ROWS_PER_PAGE;
  const endIdx   = startIdx + ROWS_PER_PAGE;

  // Tampilkan hanya baris di halaman ini
  Array.from(tbody.rows).forEach((row, idx) => {
    row.style.display = (idx >= startIdx && idx < endIdx) ? '' : 'none';
  });

  // Info baris
  const startNo = totalRows > 0 ? startIdx + 1 : 0;
  const endNo   = Math.min(endIdx, totalRows);
  document.getElementById('infoData').innerText =
    totalRows === 0 ? 'Belum ada data' : `${startNo}–${endNo} dari ${totalRows} baris`;

  // Info halaman
  document.getElementById('pageInfo').innerText = `${currentPage} / ${totalPages}`;

  // Tombol Prev / Next
  const prevBtn = document.querySelector('.pagination button:first-child');
  const nextBtn = document.querySelector('.pagination button:last-child');
  if (prevBtn) prevBtn.disabled = currentPage <= 1;
  if (nextBtn) nextBtn.disabled = currentPage >= totalPages;
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

/* DOWNLOAD EXCEL */
async function downloadCSV() {
  if (dataLog.length === 0) {
    alert('Belum ada data untuk diexport.');
    return;
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Mikroklimat DOD';
  wb.created = new Date();

  const ws = wb.addWorksheet('Data Monitoring', {
    views: [{ state: 'frozen', ySplit: 1 }], // freeze baris header
  });

  // ── Kolom ────────────────────────────────────────────────
  ws.columns = [
    { key: 'no',        header: 'No',             width: 6  },
    { key: 'tanggal',   header: 'Tanggal',         width: 14 },
    { key: 'jam',       header: 'Jam',             width: 12 },
    { key: 'suhu',      header: 'Suhu (°C)',       width: 12 },
    { key: 'kelembapan',header: 'Kelembapan (%)',  width: 16 },
    { key: 'amonia',    header: 'Amonia (ppm)',    width: 14 },
    { key: 'heater',    header: 'Heater',          width: 10 },
    { key: 'intake',    header: 'Intake',          width: 10 },
    { key: 'exhaust',   header: 'Exhaust',         width: 10 },
  ];

  // ── Style helper ─────────────────────────────────────────
  const borderThin = (color = 'FFB0B0B0') => ({
    top:    { style: 'thin', color: { argb: color } },
    left:   { style: 'thin', color: { argb: color } },
    bottom: { style: 'thin', color: { argb: color } },
    right:  { style: 'thin', color: { argb: color } },
  });
  const center = { horizontal: 'center', vertical: 'middle' };

  // ── Header row ───────────────────────────────────────────
  const headerRow = ws.getRow(1);
  headerRow.height = 24;
  headerRow.eachCell((cell) => {
    cell.font      = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11, name: 'Calibri' };
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A3C5E' } };
    cell.alignment = center;
    cell.border    = borderThin('FF1A3C5E');
  });

  // ── Data rows ────────────────────────────────────────────
  const rows = [...dataLog].reverse(); // terlama → terbaru (chronological)
  rows.forEach((d, i) => {
    const row = ws.addRow({
      no:         i + 1,
      tanggal:    d.tanggal,
      jam:        d.jam,
      suhu:       parseFloat(d.suhu)      || d.suhu,
      kelembapan: parseFloat(d.kelembapan)|| d.kelembapan,
      amonia:     parseFloat(d.amonia)    || d.amonia,
      heater:     d.heater,
      intake:     d.intake,
      exhaust:    d.exhaust,
    });
    row.height = 18;

    // Warna baris selang-seling
    const rowBg = i % 2 === 0 ? 'FFFFFFFF' : 'FFF0F4F8';

    row.eachCell((cell) => {
      cell.alignment = center;
      cell.border    = borderThin();
      cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: rowBg } };
      cell.font      = { name: 'Calibri', size: 10 };
    });

    // Warna kolom relay: ON = hijau, OFF = merah
    ['heater', 'intake', 'exhaust'].forEach((key, idx) => {
      const cell  = row.getCell(7 + idx);
      const isOn  = cell.value === 'ON';
      cell.font   = { bold: true, size: 10, name: 'Calibri',
                      color: { argb: isOn ? 'FF1E8449' : 'FFC0392B' } };
      cell.fill   = { type: 'pattern', pattern: 'solid',
                      fgColor: { argb: isOn ? 'FFD5F5E3' : 'FFFDEDEC' } };
    });
  });

  // ── Judul di atas tabel (baris 0 sudah header, sisipkan di atas) ─────
  // Tambahkan baris judul sebelum data dengan insertRow
  ws.spliceRows(1, 0, []); // sisipkan baris kosong di posisi 1
  const titleRow = ws.getRow(1);
  titleRow.height = 28;
  ws.mergeCells('A1:I1');
  const titleCell = ws.getCell('A1');
  titleCell.value     = 'Data Monitoring Mikroklimat DOD 🐤';
  titleCell.font      = { bold: true, size: 14, color: { argb: 'FF1A3C5E' }, name: 'Calibri' };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  titleCell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F1F8' } };
  titleCell.border    = borderThin('FFAAC4D8');

  // Timestamp export di baris 2
  ws.spliceRows(2, 0, []);
  const tsRow = ws.getRow(2);
  tsRow.height = 16;
  ws.mergeCells('A2:I2');
  const tsCell = ws.getCell('A2');
  tsCell.value     = `Diekspor pada: ${new Date().toLocaleString('id-ID')}`;
  tsCell.font      = { italic: true, size: 9, color: { argb: 'FF888888' }, name: 'Calibri' };
  tsCell.alignment = { horizontal: 'center', vertical: 'middle' };

  // Spasi satu baris kosong sebelum header
  ws.spliceRows(3, 0, []);
  ws.getRow(3).height = 8;

  // ── Generate & download ──────────────────────────────────
  const buffer = await wb.xlsx.writeBuffer();
  const blob   = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const link = document.createElement('a');
  const now  = new Date();
  const ts   = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
  link.download = `monitoring_mikroklimat_${ts}.xlsx`;
  link.href     = URL.createObjectURL(blob);
  link.click();
  URL.revokeObjectURL(link.href);
}

function resetDashboard() {
  stopMonitoring();
  lastAppliedReadingKey = null;
  historyLoading = false;
  setAwaitingSensor(true);

  const tbody = document.getElementById('tableBody');
  while (tbody.rows.length > 0) tbody.deleteRow(0);

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
  historyLoading = true;

  const tbody = document.getElementById('tableBody');
  while (tbody.rows.length > 0) tbody.deleteRow(0);

  dataLog.length = 0;
  labels.length = 0;
  suhuData.length = 0;
  kelembapanData.length = 0;
  amoniaData.length = 0;
  lastAppliedReadingKey = null;

  // Firestore mengembalikan DESC (terbaru dulu).
  // insertRow(1) selalu masukkan ke posisi 1, mendorong yang lama ke bawah.
  // Agar terbaru ada di atas: iterasi dari yang terlama (index terakhir) dulu.
  for (let i = docs.length - 1; i >= 0; i--) {
    const doc = docs[i];
    const ts = doc.timestamp?.toMillis ? doc.timestamp.toMillis() : Date.parse(doc.timestamp) || Date.now();
    addTable(doc.suhu, doc.kelembapan, doc.amonia, doc.heater, doc.intake, doc.exhaust, ts, true);
  }

  // Panggil satu kali setelah semua baris masuk — hindari O(n²)
  updateNumbering();
  updateTablePagination();
  chart1.update();
  chart2.update();

  historyLoading = false;
  console.log('📥 History loaded:', docs.length, 'baris');
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
window.applyModeUI = applyModeUI;
window.toggleMode = toggleMode;
window.toggleRelay = toggleRelay;
