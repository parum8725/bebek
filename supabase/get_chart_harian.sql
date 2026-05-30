-- ════════════════════════════════════════════════════════════════════════════
-- RPC: get_chart_harian()
-- Rata-rata harian EKSAK (suhu, kelembapan, amonia) per tanggal,
-- diurutkan dari tanggal PALING AWAL → PALING AKHIR.
--
-- Dashboard (auth.js → loadChartFromSupabase) memanggil RPC ini lebih dulu.
-- Kalau RPC ada, chart pakai rata-rata EKSAK (bukan sampling).
-- Kalau RPC belum dibuat, dashboard otomatis pakai fallback sampling.
--
-- Cara pakai: buka Supabase → SQL Editor → tempel semua → Run. Cukup 1x.
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.get_chart_harian()
returns table (
  hari            text,
  avg_suhu        numeric,
  avg_kelembapan  numeric,
  avg_amonia      numeric
)
language sql
stable
as $$
  select
    -- Kelompokkan per hari menurut zona waktu Indonesia (WIB)
    to_char((timestamp at time zone 'Asia/Jakarta'), 'YYYY-MM-DD') as hari,
    round(avg(suhu)::numeric, 1)       as avg_suhu,
    round(avg(kelembapan)::numeric, 1) as avg_kelembapan,
    round(avg(amonia)::numeric, 2)     as avg_amonia
  from public.monitoring
  where timestamp >= '2020-01-01'   -- abaikan baris junk (mis. 1999-01-01)
  group by 1
  order by 1 asc;                   -- WAJIB: paling awal → paling akhir
$$;

-- Izinkan dipanggil dari klien (anon key dashboard)
grant execute on function public.get_chart_harian() to anon, authenticated;
