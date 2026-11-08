// js/saw.js — AHP + SAW + rencana perjalanan untuk WebGIS Wisata Kulon Progo
// Script biasa (bukan module): dimuat sebelum app.js, dipakai lewat objek global `SAW`.
(function (root) {
  'use strict';

  /* ========== 1. KRITERIA & AHP ========== */

  const CRITERIA = [
    { code: 'C1', name: 'Waktu tempuh',    type: 'cost',    key: 'waktu_tempuh' }, // menit (OSRM)
    { code: 'C2', name: 'Biaya kunjungan', type: 'cost',    key: 'biaya' },        // Rp/orang
    { code: 'C3', name: 'Rating',          type: 'benefit', key: 'rating' },       // skala 1-5
    { code: 'C4', name: 'Jumlah ulasan',   type: 'benefit', key: 'ulasan' },       // ulasan
  ];

  // Matriks perbandingan berpasangan (geomean 5 responden)
  const AHP_MATRIX = [
    [1,    2,    2, 4],
    [1/2,  1,    4, 4],
    [1/2,  1/4,  1, 1],
    [1/4,  1/4,  1, 1],
  ];
  const RI = { 1: 0, 2: 0, 3: 0.58, 4: 0.90, 5: 1.12, 6: 1.24, 7: 1.32, 8: 1.41 };

  function ahpWeights(matrix = AHP_MATRIX) {
    const n = matrix.length;
    const gm = matrix.map(row => Math.pow(row.reduce((a, b) => a * b, 1), 1 / n));
    const sum = gm.reduce((a, b) => a + b, 0);
    return gm.map(g => g / sum);
  }

  function ahpConsistency(matrix = AHP_MATRIX, w = ahpWeights(matrix)) {
    const n = matrix.length;
    const ratios = matrix.map((row, i) => row.reduce((s, v, j) => s + v * w[j], 0) / w[i]);
    const lambdaMax = ratios.reduce((a, b) => a + b, 0) / n;
    const CI = (lambdaMax - n) / (n - 1);
    const CR = RI[n] ? CI / RI[n] : 0;
    return { lambdaMax, CI, CR, consistent: CR <= 0.1 };
  }

  const WEIGHTS = ahpWeights(); // [C1..C4] ≈ [0.4187, 0.3521, 0.1245, 0.1047]

  /* ========== 2. KONFIGURASI ========== */

  // Nilai pilihan di UI -> teks kolom `kategori` di data (null = Bebas)
  const KATEGORI = {
    alam:               'Wisata Alam',
    alam_buatan:        'Wisata Alam-Buatan',
    budaya_religi:      'Religi dan Budaya',
    agrowisata:         'Agrowisata',
    akomodasi_rekreasi: 'Akomodasi dan Rekreasi',
    bebas:              null,
  };

  const CONFIG = {
    durasiKunjungan: 60,      // menit per tempat ("satu tempat satu jam")
    pakaiDurasiData: false,   // true = pakai kolom durasi_jam per wisata (0,75 / 1 / 1,5 jam)
    roundTrip: true,          // waktu user sudah termasuk perjalanan pulang ke titik awal
    tambahMakan: true,        // biaya = biaya_rp + estimasi makan
    makan: 'mid',             // estimasi makan dari makan_min..makan_max: 'min' | 'mid' | 'max'
    jumlahStop: 3,            // jumlah tempat dalam 1 rencana
    kandidatPool: 10,         // top-N hasil SAW yang dicoba disusun jadi rute
    osrmUrl: 'https://router.project-osrm.org',
    osrmChunk: 90,            // batas koordinat per request OSRM demo (100)
    fallbackSpeedKmh: 40,     // dipakai kalau OSRM tidak bisa dihubungi
  };

  /* ========== 3. DATA (window.WISATA / data_final_geojson) ========== */

  // Nilai di GeoJSON banyak yang berupa teks ("4.3"), jadi dikonversi dulu
  const num = v => {
    if (v === null || v === undefined || v === '') return null;
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  };

  const HARI_KOLOM = ['senin', 'selasa', 'rabu', 'kamis', 'jumat', 'sabtu', 'minggu'];
  const HARI_NAMA  = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'];
  const HARI_GETDAY = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

  /** Biaya per orang = biaya_rp (tiket / paket) + estimasi makan dari rentang makan_min..makan_max */
  function hitungBiaya(p, cfg = CONFIG) {
    const dasar = num(p.biaya_rp) ?? num(p.harga_masuk_asli_rp) ?? 0;
    if (!cfg.tambahMakan) return dasar;
    const lo = num(p.makan_min_rp), hi = num(p.makan_max_rp);
    let makan = 0;
    if (lo != null && hi != null) makan = cfg.makan === 'min' ? lo : cfg.makan === 'max' ? hi : (lo + hi) / 2;
    else if (lo != null || hi != null) makan = lo ?? hi;
    return dasar + makan;
  }

  /** Feature GeoJSON -> alternatif SAW. idx = urutan di FeatureCollection (= urutan di matriks OSRM) */
  function featureToAlt(f, idx, cfg = CONFIG) {
    const p = f.properties;
    const [lng, lat] = f.geometry.coordinates;
    return {
      idx, id: p.id_wisata, nama: p.nama_wisata, kategori: p.kategori, lat, lng,
      biaya: hitungBiaya(p, cfg),
      rating: num(p.rating),               // bisa null (belum ada rating)
      ulasan: num(p.jumlah_ulasan) ?? 0,
      durasi: cfg.pakaiDurasiData ? Math.round((num(p.durasi_jam) ?? 1) * 60) : cfg.durasiKunjungan,
      info: {
        kapanewon: p.kapanewon, kalurahan: p.kalurahan, url_maps: p.url_google_maps,
        jam_buka: p.jam_buka, jam_tutup: p.jam_tutup,
        buka_24jam: num(p.buka_24jam) === 1,
        hari_buka: HARI_KOLOM.map((k, i) => (num(p[k]) === 1 ? HARI_NAMA[i] : null)).filter(Boolean),
      },
    };
  }

  /* ========== 4. MATRIKS OSRM (matriks_osrm.json) ========== */

  function haversineKm(a, b) {
    const R = 6371, rad = d => (d * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /**
   * Siapkan matriks dari JSON hasil OSRM /table (durations detik, distances meter).
   * Baris ke-i harus sama dengan feature ke-i; dicek lewat koordinat `sources`.
   * @returns {{waktu:number[][], jarak:number[][], n:number}}  waktu menit, jarak km
   */
  function siapkanMatriks(json, features) {
    if (!json || !json.durations || !json.distances) throw new Error('Format matriks OSRM tidak dikenali (butuh durations & distances).');
    const n = features.length;
    if (json.durations.length !== n || json.durations[0].length !== n)
      throw new Error(`Ukuran matriks (${json.durations.length}) tidak sama dengan jumlah wisata (${n}).`);
    if (json.sources) {
      json.sources.forEach((s, i) => {
        const [lng, lat] = features[i].geometry.coordinates;
        if (haversineKm({ lat, lng }, { lat: s.location[1], lng: s.location[0] }) > 1)
          throw new Error(`Urutan matriks tidak cocok dengan data wisata (baris ${i}).`);
      });
    }
    return {
      n,
      waktu: json.durations.map(r => r.map(s => (s == null ? Infinity : s / 60))),
      jarak: json.distances.map(r => r.map(m => (m == null ? Infinity : m / 1000))),
    };
  }

  /* ========== 5. OSRM LIVE (hanya untuk titik awal user & gambar rute) ========== */

  async function osrmChunk(origin, dests, cfg) {
    const coords = [origin, ...dests].map(p => `${p.lng},${p.lat}`).join(';');
    const res = await fetch(`${cfg.osrmUrl}/table/v1/driving/${coords}?sources=0&annotations=duration,distance`);
    const json = await res.json();
    if (json.code !== 'Ok') throw new Error(json.code);
    return {
      menit: json.durations[0].slice(1).map(s => (s == null ? Infinity : s / 60)),
      km: json.distances[0].slice(1).map(m => (m == null ? Infinity : m / 1000)),
    };
  }

  /** Waktu (menit) & jarak (km) dari titik awal ke tiap tujuan. Dianggap simetris untuk perjalanan pulang. */
  async function getFromStart(origin, dests, cfg = CONFIG) {
    try {
      const menit = [], km = [];
      for (let i = 0; i < dests.length; i += cfg.osrmChunk) {
        const r = await osrmChunk(origin, dests.slice(i, i + cfg.osrmChunk), cfg);
        menit.push(...r.menit); km.push(...r.km);
      }
      return { menit, km, estimasi: false };
    } catch (err) {
      console.warn('OSRM gagal, pakai estimasi jarak lurus:', err.message);
      const km = dests.map(d => haversineKm(origin, d) * 1.3);
      return { menit: km.map(k => (k / cfg.fallbackSpeedKmh) * 60), km, estimasi: true };
    }
  }

  /** Geometri rute jalan melewati titik-titik berurutan (hanya untuk digambar di peta). */
  async function getRoute(points, cfg = CONFIG) {
    try {
      const coords = points.map(p => `${p.lng},${p.lat}`).join(';');
      const res = await fetch(`${cfg.osrmUrl}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`);
      const json = await res.json();
      if (json.code !== 'Ok') throw new Error(json.code);
      return { geometry: json.routes[0].geometry, estimasi: false };
    } catch (err) {
      console.warn('OSRM route gagal, pakai garis lurus:', err.message);
      return { geometry: { type: 'LineString', coordinates: points.map(p => [p.lng, p.lat]) }, estimasi: true };
    }
  }

  /* ========== 6. FILTER (jawaban user) — null = "Tidak dibatasi" / "Bebas" ========== */

  function filterKategori(alts, kategori) {
    const target = KATEGORI[kategori] ?? null;
    return target ? alts.filter(a => a.kategori === target) : alts;
  }
  function filterRating(alts, ratingMin) {
    return ratingMin == null ? alts : alts.filter(a => a.rating != null && a.rating >= ratingMin);
  }
  function filterAnggaran(alts, anggaran) {
    return anggaran == null ? alts : alts.filter(a => a.biaya <= anggaran);
  }
  function filterWaktu(alts, waktuJam, cfg = CONFIG) {
    if (waktuJam == null) return alts;
    return alts.filter(a => a.waktu_tempuh * (cfg.roundTrip ? 2 : 1) + a.durasi <= waktuJam * 60);
  }

  /* ========== 7. SAW ========== */

  /** Benefit = x/max, cost = min/x */
  function normalize(alts, criteria = CRITERIA) {
    const val = (a, c) => a[c.key] ?? 0; // rating kosong dianggap 0
    const stat = {};
    criteria.forEach(c => {
      const v = alts.map(a => val(a, c));
      stat[c.key] = { min: Math.min(...v), max: Math.max(...v) };
    });
    return alts.map(a => {
      const r = {};
      criteria.forEach(c => {
        const x = val(a, c), { min, max } = stat[c.key];
        if (c.type === 'benefit') r[c.key] = max === 0 ? 0 : x / max;
        else r[c.key] = x === 0 ? 1 : min / x; // cost; gratis (0) = nilai terbaik
      });
      return r;
    });
  }

  /** Skor = Σ (bobot AHP × nilai normalisasi), urut dari terbesar */
  function sawRank(alts, weights = WEIGHTS, criteria = CRITERIA) {
    const R = normalize(alts, criteria);
    return alts
      .map((a, i) => ({ ...a, normalisasi: R[i], skor: criteria.reduce((s, c, j) => s + weights[j] * R[i][c.key], 0) }))
      .sort((x, y) => y.skor - x.skor)
      .map((a, i) => ({ ...a, peringkat: i + 1 }));
  }

  /* ========== 8. PEMILIHAN & URUTAN TEMPAT ========== */

  function* kombinasi(arr, k, start = 0, cur = []) {
    if (cur.length === k) { yield cur.slice(); return; }
    for (let i = start; i < arr.length; i++) {
      cur.push(arr[i]);
      yield* kombinasi(arr, k, i + 1, cur);
      cur.pop();
    }
  }
  function* permutasi(arr) {
    if (arr.length <= 1) { yield arr.slice(); return; }
    for (let i = 0; i < arr.length; i++) {
      const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
      for (const p of permutasi(rest)) yield [arr[i], ...p];
    }
  }

  // matrix: indeks 0 = titik awal, i+1 = kandidat[i]
  function totalMenit(perm, matrix, kandidat, cfg) {
    let t = matrix[0][perm[0] + 1];
    for (let k = 0; k < perm.length - 1; k++) t += matrix[perm[k] + 1][perm[k + 1] + 1];
    t += perm.reduce((s, i) => s + kandidat[i].durasi, 0);
    if (cfg.roundTrip) t += matrix[perm[perm.length - 1] + 1][0];
    return t;
  }

  /**
   * Pilih kombinasi (utamakan jumlahStop tempat) dengan total skor SAW terbesar yang muat di
   * waktu & anggaran total, lalu urutkan agar total waktu paling singkat.
   * @returns {{urutan:number[], skor:number, total:number}|null}  urutan = indeks ke `kandidat`
   */
  function pilihItinerary(kandidat, matrix, input, cfg = CONFIG) {
    const batas = input.waktuJam == null ? Infinity : input.waktuJam * 60;
    const idx = kandidat.map((_, i) => i);
    for (let n = Math.min(cfg.jumlahStop, kandidat.length); n >= 1; n--) {
      let best = null;
      for (const kombo of kombinasi(idx, n)) {
        if (input.anggaran != null && kombo.reduce((s, i) => s + kandidat[i].biaya, 0) > input.anggaran) continue;
        const skor = kombo.reduce((s, i) => s + kandidat[i].skor, 0);
        for (const perm of permutasi(kombo)) {
          const total = totalMenit(perm, matrix, kandidat, cfg);
          if (total > batas) continue;
          if (!best || skor > best.skor + 1e-12 || (Math.abs(skor - best.skor) <= 1e-12 && total < best.total))
            best = { urutan: perm, skor, total };
        }
      }
      if (best) return best;
    }
    return null;
  }

  /** true/false = buka/tutup saat tiba; null = data jam buka tidak tersedia */
  function statusBuka(info, tiba, durasi, hari) {
    const toMenit = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(s ?? ''); return m ? +m[1] * 60 + +m[2] : null; };
    if (info.hari_buka?.length && !info.hari_buka.includes(hari)) return false;
    if (info.buka_24jam) return true;
    const b = toMenit(info.jam_buka);
    let c = toMenit(info.jam_tutup);
    if (b == null || c == null) return null;
    if (c === 1439) c = 1440;   // "23:59" = tutup tengah malam
    if (c <= b) c += 1440;      // buka lewat tengah malam
    const t = tiba % 1440;
    return [t, t + 1440].some(x => x >= b && x + durasi <= c);
  }

  /* ========== 9. RENCANA PERJALANAN ========== */

  /**
   * @param {Object} geojson   window.WISATA (FeatureCollection)
   * @param {Object} matriks   hasil siapkanMatriks()
   * @param {Object} input     {
   *   lokasi:{lat,lng}, kategori:'alam'|'alam_buatan'|'budaya_religi'|'agrowisata'|'akomodasi_rekreasi'|'bebas',
   *   waktuJam:number|null, anggaran:number|null (total per orang), ratingMin:number|null, jamBerangkat?:Date }
   */
  async function rencanaPerjalanan(geojson, matriks, input, cfg = CONFIG) {
    const kosong = pesan => ({ stops: [], pesan });

    // 1. Filter yang tidak butuh OSRM
    let alts = geojson.features.map((f, i) => featureToAlt(f, i, cfg));
    alts = filterKategori(alts, input.kategori);
    alts = filterRating(alts, input.ratingMin);
    alts = filterAnggaran(alts, input.anggaran);
    if (!alts.length) return kosong('Tidak ada wisata yang sesuai jenis, rating, dan anggaran Anda. Coba longgarkan pilihan.');

    // 2. Waktu tempuh dari titik awal (OSRM live), lalu filter waktu
    const awal = await getFromStart(input.lokasi, alts, cfg);
    alts = alts
      .map((a, i) => ({ ...a, waktu_tempuh: awal.menit[i], jarak_awal: awal.km[i] }))
      .filter(a => Number.isFinite(a.waktu_tempuh));
    alts = filterWaktu(alts, input.waktuJam, cfg);
    if (!alts.length) return kosong('Tidak ada wisata yang terjangkau dalam waktu Anda dari lokasi awal. Coba tambah waktu atau pilih titik awal yang lebih dekat.');

    // 3. SAW -> kandidat teratas
    const kandidat = sawRank(alts).slice(0, cfg.kandidatPool);
    const n = kandidat.length;

    // 4. Matriks lokal: 0 = titik awal, i+1 = kandidat[i]. Antar-wisata dari matriks OSRM.
    const W = Array.from({ length: n + 1 }, () => new Array(n + 1).fill(0));
    const K = Array.from({ length: n + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i < n; i++) {
      W[0][i + 1] = W[i + 1][0] = kandidat[i].waktu_tempuh;
      K[0][i + 1] = K[i + 1][0] = kandidat[i].jarak_awal;
      for (let j = 0; j < n; j++) {
        W[i + 1][j + 1] = matriks.waktu[kandidat[i].idx][kandidat[j].idx];
        K[i + 1][j + 1] = matriks.jarak[kandidat[i].idx][kandidat[j].idx];
      }
    }

    // 5. Pilih & urutkan
    const pilih = pilihItinerary(kandidat, W, input, cfg);
    if (!pilih) return kosong('Waktu atau anggaran tidak cukup untuk satu tempat pun. Coba tambah waktu atau anggaran.');

    const seq = [0, ...pilih.urutan.map(i => i + 1), ...(cfg.roundTrip ? [0] : [])];
    const titik = seq.map(k => (k === 0 ? input.lokasi : kandidat[k - 1]));
    const rute = await getRoute(titik, cfg);

    // 6. Jadwal
    const base = input.jamBerangkat instanceof Date ? input.jamBerangkat : new Date();
    const mulai = base.getHours() * 60 + base.getMinutes();
    const hari = HARI_GETDAY[base.getDay()];
    let cursor = mulai, totalKm = 0;
    const stops = [];
    for (let s = 1; s < seq.length; s++) {
      const dari = seq[s - 1], ke = seq[s];
      const menit = W[dari][ke], km = K[dari][ke];
      totalKm += km;
      if (ke === 0) { cursor += menit; continue; } // ruas pulang dicatat di bawah
      const a = kandidat[ke - 1];
      const tiba = cursor + menit, selesai = tiba + a.durasi;
      cursor = selesai;
      stops.push({ ...a, urutan: stops.length + 1, perjalananMenit: menit, perjalananKm: km, tiba, selesai,
        buka: statusBuka(a.info, tiba, a.durasi, hari) });
    }
    let pulang = null;
    if (cfg.roundTrip) {
      const last = seq[seq.length - 2];
      pulang = { menit: W[last][0], km: K[last][0], tiba: cursor };
    }

    return {
      stops, pulang, mulai,
      totalMenit: cursor - mulai,
      totalKm,
      totalBiaya: stops.reduce((s, a) => s + a.biaya, 0),
      rute: rute.geometry,
      estimasiWaktuAwal: awal.estimasi,
      estimasiRute: rute.estimasi,
      pesan: stops.length < cfg.jumlahStop
        ? `Hanya ${stops.length} tempat yang muat dengan waktu/anggaran Anda (diminta ${cfg.jumlahStop}).` : null,
    };
  }

  const api = {
    CRITERIA, AHP_MATRIX, WEIGHTS, KATEGORI, CONFIG,
    ahpWeights, ahpConsistency, hitungBiaya, featureToAlt, siapkanMatriks,
    getFromStart, getRoute, filterKategori, filterRating, filterAnggaran, filterWaktu,
    normalize, sawRank, pilihItinerary, statusBuka, rencanaPerjalanan,
  };
  root.SAW = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
