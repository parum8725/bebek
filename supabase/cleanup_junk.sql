-- ════════════════════════════════════════════════════════════════════════════
-- Hapus baris uji/junk bertanggal sebelum data asli (mis. 1999-01-01).
-- Baris ini muncul saat pengujian insert dan tidak bisa dihapus lewat anon key
-- karena RLS hanya mengizinkan INSERT/SELECT.
--
-- Jalankan di Supabase → SQL Editor (memakai hak service_role). Cukup 1x.
-- ════════════════════════════════════════════════════════════════════════════

delete from public.monitoring
where timestamp < '2020-01-01';
