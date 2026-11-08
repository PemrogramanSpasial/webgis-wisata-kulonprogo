// js/app.js — WebGIS Wisata Kulon Progo
// Memakai objek global `SAW` (js/saw.js) dan `window.WISATA` (data/data.js).

// ===============================
// PETA
// ===============================
const map = L.map('map').setView([-7.70, 110.15], 11);

L.tileLayer('https://tile.openstreetmap.de/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19
}).addTo(map);

console.log('Data wisata:', window.WISATA);

// Semua titik wisata (titik kecil, supaya tidak menumpuk dengan penanda rute)
const wisataLayer = L.geoJSON(window.WISATA, {
    pointToLayer: (feature, latlng) => L.circleMarker(latlng, {
        radius: 5, color: '#4b5563', weight: 1, fillColor: '#7aa6d6', fillOpacity: 0.85
    }),
    onEachFeature: (feature, layer) => {
        const p = feature.properties;
        layer.bindPopup(
            `<b>${esc(p.nama_wisata)}</b>` +
            (p.kategori ? `<br>${esc(p.kategori)}` : '') +
            (p.rating ? `<br>Rating: ${esc(p.rating)}` : '')
        );
    }
}).addTo(map);

map.fitBounds(wisataLayer.getBounds());

// Lapisan hasil rekomendasi (rute, penanda nomor, titik awal)
const hasilLayer = L.layerGroup().addTo(map);
let markerAwal = null;

// ===============================
// UTILITAS
// ===============================
function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

const pad = n => String(n).padStart(2, '0');

function fmtJam(menit) {
    const m = Math.round(menit) % 1440;
    return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

function fmtDurasi(menit) {
    const m = Math.round(menit);
    if (m < 60) return `${m} mnt`;
    const j = Math.floor(m / 60), s = m % 60;
    return s ? `${j} jam ${s} mnt` : `${j} jam`;
}

const fmtRp = n => 'Rp' + Math.round(n).toLocaleString('id-ID');

// ===============================
// MATRIKS OSRM (antar-wisata)
// ===============================
// Dimuat dari data/matriks_osrm.json. Jika gagal (mis. file dibuka lewat file://),
// dipakai estimasi dari jarak lurus supaya aplikasi tetap jalan.
async function muatMatriks() {
    const features = window.WISATA.features;
    try {
        const res = await fetch('data/matriks_osrm.json');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        return { matriks: SAW.siapkanMatriks(json, features), estimasi: false };
    } catch (err) {
        console.warn('Matriks OSRM tidak bisa dimuat, pakai estimasi jarak lurus:', err.message);
        const titik = features.map(f => ({ lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }));
        const km = (a, b) => {
            const R = 6371, rad = d => d * Math.PI / 180;
            const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
                Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
            return 2 * R * Math.asin(Math.sqrt(h)) * 1.3;
        };
        const kecepatan = SAW.CONFIG.fallbackSpeedKmh;
        const distances = titik.map(a => titik.map(b => km(a, b) * 1000));
        const durations = distances.map(r => r.map(m => (m / 1000 / kecepatan) * 3600));
        return { matriks: SAW.siapkanMatriks({ durations, distances }, features), estimasi: true };
    }
}

const matriksPromise = muatMatriks();

// ===============================
// PANDUAN 5 PERTANYAAN
// ===============================
const jawabanPengguna = {
    lokasi: "",
    jenisWisata: "",
    waktu: "",
    anggaran: "",
    rating: ""
};

// Koordinat hasil dari jawaban "lokasi" (teks / GPS / klik peta)
let lokasiKoordinat = null;
let lokasiTeksTerakhir = "";

let nomorPertanyaan = 0;

const daftarPertanyaan = [
    {
        judul: "Di mana lokasi awal perjalananmu?",
        jenis: "input",
        key: "lokasi",
        placeholder: "Nama tempat, atau koordinat (-7.70, 110.15)"
    },
    {
        judul: "Jenis wisata apa yang kamu sukai?",
        jenis: "pilihan",
        key: "jenisWisata",
        pilihan: [
            "Wisata Alam",
            "Wisata Alam-Buatan",
            "Religi dan Budaya",
            "Agrowisata",
            "Akomodasi dan Rekreasi",
            "Bebas (semua jenis)"
        ]
    },
    {
        judul: "Berapa lama waktu yang kamu sediakan?",
        jenis: "pilihan",
        key: "waktu",
        pilihan: ["Kurang dari 2 jam", "2–4 jam", "4–6 jam", "Lebih dari 6 jam"]
    },
    {
        judul: "Berapa anggaran wisata yang kamu siapkan?",
        jenis: "pilihan",
        key: "anggaran",
        pilihan: ["Di bawah Rp25.000", "Rp25.000–Rp50.000", "Rp50.000–Rp100.000", "Di atas Rp100.000"]
    },
    {
        judul: "Berapa rating minimum tempat wisata yang kamu inginkan?",
        jenis: "pilihan",
        key: "rating",
        pilihan: ["Minimal 3,0", "Minimal 3,5", "Minimal 4,0", "Minimal 4,5"]
    }
];

// Jawaban UI -> parameter SAW (null = tidak dibatasi)
const PETA_KATEGORI = {
    "Wisata Alam": "alam",
    "Wisata Alam-Buatan": "alam_buatan",
    "Religi dan Budaya": "budaya_religi",
    "Agrowisata": "agrowisata",
    "Akomodasi dan Rekreasi": "akomodasi_rekreasi",
    "Bebas (semua jenis)": "bebas"
};
const PETA_WAKTU_JAM = {            // batas atas waktu total (jam)
    "Kurang dari 2 jam": 2,
    "2–4 jam": 4,
    "4–6 jam": 6,
    "Lebih dari 6 jam": null
};
const PETA_ANGGARAN = {             // batas atas biaya per orang (Rp)
    "Di bawah Rp25.000": 25000,
    "Rp25.000–Rp50.000": 50000,
    "Rp50.000–Rp100.000": 100000,
    "Di atas Rp100.000": null
};
const PETA_RATING = {
    "Minimal 3,0": 3.0,
    "Minimal 3,5": 3.5,
    "Minimal 4,0": 4.0,
    "Minimal 4,5": 4.5
};

const elPanduan = document.getElementById("panduan");
const elLanjut = document.getElementById("btnLanjut");

function tampilkanPertanyaan() {
    const pertanyaan = daftarPertanyaan[nomorPertanyaan];
    const wadah = document.getElementById("isiPertanyaan");

    document.getElementById("progress").textContent =
        `Pertanyaan ${nomorPertanyaan + 1} dari 5`;

    let isi = `<h3>${esc(pertanyaan.judul)}</h3>`;

    if (pertanyaan.jenis === "input") {
        isi += `
            <input
                type="text"
                id="jawabanInput"
                placeholder="${esc(pertanyaan.placeholder)}"
                value="${esc(jawabanPengguna[pertanyaan.key])}"
                style="width:100%; padding:12px; margin-top:15px;"
            >
            <div class="lokasi-aksi">
                <button type="button" id="btnGps">Gunakan lokasi saya</button>
                <button type="button" id="btnPilihPeta">Pilih di peta</button>
            </div>
            <div id="infoLokasi" class="info-lokasi"></div>
        `;
    } else {
        isi += `
            <select id="jawabanSelect" class="form-select">
                <option value="">-- Pilih jawaban --</option>
                ${pertanyaan.pilihan.map(pilihan => `
                    <option value="${esc(pilihan)}"
                        ${jawabanPengguna[pertanyaan.key] === pilihan ? "selected" : ""}>
                        ${esc(pilihan)}
                    </option>
                `).join("")}
            </select>
        `;
    }

    wadah.innerHTML = isi;

    const select = document.getElementById("jawabanSelect");
    if (select) {
        select.addEventListener("change", function () {
            jawabanPengguna[pertanyaan.key] = this.value;
        });
    }

    if (pertanyaan.jenis === "input") {
        document.getElementById("btnGps").addEventListener("click", gunakanGps);
        document.getElementById("btnPilihPeta").addEventListener("click", pilihDiPeta);
        if (lokasiKoordinat && jawabanPengguna.lokasi === lokasiTeksTerakhir) {
            setInfoLokasi(`Lokasi terpilih: ${lokasiKoordinat.lat.toFixed(5)}, ${lokasiKoordinat.lng.toFixed(5)}`);
        }
    }

    document.getElementById("btnKembali").disabled = nomorPertanyaan === 0;
    elLanjut.textContent = nomorPertanyaan === 4 ? "Tampilkan Rekomendasi" : "Lanjut";
}

// ===============================
// LOKASI AWAL: teks / GPS / klik peta
// ===============================
function setInfoLokasi(teks, galat = false) {
    const el = document.getElementById("infoLokasi");
    if (!el) return;
    el.textContent = teks;
    el.classList.toggle("galat", galat);
}

function tandaiLokasiAwal(lat, lng) {
    lokasiKoordinat = { lat, lng };
    if (markerAwal) map.removeLayer(markerAwal);
    markerAwal = L.marker([lat, lng], { title: "Lokasi awal" })
        .bindPopup("<b>Lokasi awal</b>")
        .addTo(map);
}

function simpanLokasi(lat, lng, teks) {
    tandaiLokasiAwal(lat, lng);
    jawabanPengguna.lokasi = teks;
    lokasiTeksTerakhir = teks;
    const input = document.getElementById("jawabanInput");
    if (input) input.value = teks;
    setInfoLokasi(`Lokasi terpilih: ${lat.toFixed(5)}, ${lng.toFixed(5)}`);
}

function gunakanGps() {
    if (!navigator.geolocation) {
        setInfoLokasi("Peramban ini tidak mendukung GPS. Ketik nama tempat atau pilih di peta.", true);
        return;
    }
    setInfoLokasi("Mencari lokasimu...");
    navigator.geolocation.getCurrentPosition(
        pos => {
            const { latitude: lat, longitude: lng } = pos.coords;
            simpanLokasi(lat, lng, `${lat.toFixed(5)}, ${lng.toFixed(5)}`);
        },
        () => setInfoLokasi("Lokasi tidak bisa diakses. Izinkan akses lokasi, ketik nama tempat, atau pilih di peta.", true),
        { enableHighAccuracy: true, timeout: 10000 }
    );
}

function pilihDiPeta() {
    elPanduan.style.display = "none";
    const banner = document.getElementById("bannerPeta");
    banner.style.display = "block";
    map.getContainer().style.cursor = "crosshair";

    map.once("click", e => {
        const { lat, lng } = e.latlng;
        banner.style.display = "none";
        map.getContainer().style.cursor = "";
        const teks = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
        tandaiLokasiAwal(lat, lng);
        jawabanPengguna.lokasi = teks;
        lokasiTeksTerakhir = teks;
        elPanduan.style.display = "flex";
        tampilkanPertanyaan();
    });
}

// Teks -> koordinat. Menerima "lat, lng" atau nama tempat (Nominatim).
async function cariKoordinat(teks) {
    const m = teks.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) {
        const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
        if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
    }
    // viewbox = barat,utara,timur,selatan (sekitar Kulon Progo, hanya sebagai prioritas)
    const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=id" +
        "&viewbox=109.9,-7.5,110.3,-7.95&q=" + encodeURIComponent(teks);
    const res = await fetch(url, { headers: { "Accept-Language": "id" } });
    if (!res.ok) throw new Error("Pencarian lokasi gagal (HTTP " + res.status + ")");
    const data = await res.json();
    if (!data.length) return null;
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
}

// ===============================
// NAVIGASI PERTANYAAN
// ===============================
elLanjut.addEventListener("click", async function () {
    const pertanyaan = daftarPertanyaan[nomorPertanyaan];

    if (pertanyaan.jenis === "input") {
        const nilai = document.getElementById("jawabanInput").value.trim();

        if (!nilai) {
            alert("Silakan masukkan lokasi awal terlebih dahulu.");
            return;
        }

        // Cari koordinat jika teks baru / berubah
        if (!lokasiKoordinat || nilai !== lokasiTeksTerakhir) {
            elLanjut.disabled = true;
            setInfoLokasi("Mencari lokasi...");
            try {
                const hasil = await cariKoordinat(nilai);
                if (!hasil) {
                    setInfoLokasi("Lokasi tidak ditemukan. Coba nama lain, koordinat, atau pilih di peta.", true);
                    return;
                }
                simpanLokasi(hasil.lat, hasil.lng, nilai);
            } catch (err) {
                setInfoLokasi("Gagal mencari lokasi: " + err.message + ". Coba koordinat atau pilih di peta.", true);
                return;
            } finally {
                elLanjut.disabled = false;
            }
        }
        jawabanPengguna[pertanyaan.key] = nilai;
    } else if (!jawabanPengguna[pertanyaan.key]) {
        alert("Silakan pilih salah satu jawaban terlebih dahulu.");
        return;
    }

    if (nomorPertanyaan < 4) {
        nomorPertanyaan++;
        tampilkanPertanyaan();
    } else {
        console.log("Jawaban pengguna:", jawabanPengguna);
        await jalankanRekomendasi();
    }
});

document.getElementById("btnKembali").addEventListener("click", function () {
    if (nomorPertanyaan > 0) {
        nomorPertanyaan--;
        tampilkanPertanyaan();
    }
});

document.getElementById("btnUbahPreferensi").addEventListener("click", function () {
    nomorPertanyaan = 0;
    tampilkanPertanyaan();
    elPanduan.style.display = "flex";
});

// ===============================
// REKOMENDASI (SAW)
// ===============================
async function jalankanRekomendasi() {
    const input = {
        lokasi: lokasiKoordinat,
        kategori: PETA_KATEGORI[jawabanPengguna.jenisWisata] ?? "bebas",
        waktuJam: PETA_WAKTU_JAM[jawabanPengguna.waktu] ?? null,
        anggaran: PETA_ANGGARAN[jawabanPengguna.anggaran] ?? null,
        ratingMin: PETA_RATING[jawabanPengguna.rating] ?? null,
        jamBerangkat: new Date()
    };
    console.log("Input SAW:", input);

    elPanduan.style.display = "none";
    document.getElementById("loading").style.display = "flex";

    try {
        const { matriks, estimasi } = await matriksPromise;
        const hasil = await SAW.rencanaPerjalanan(window.WISATA, matriks, input);
        console.log("Hasil SAW:", hasil);
        gambarHasil(hasil, input, estimasi);
    } catch (err) {
        console.error(err);
        alert("Rekomendasi gagal dibuat: " + err.message);
        elPanduan.style.display = "flex";
    } finally {
        document.getElementById("loading").style.display = "none";
    }
}

function ikonNomor(n) {
    return L.divIcon({
        className: "marker-nomor",
        html: `<span>${n}</span>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15],
        popupAnchor: [0, -15]
    });
}

function labelBuka(buka) {
    if (buka === true) return '<span class="badge buka">Buka saat tiba</span>';
    if (buka === false) return '<span class="badge tutup">Tutup saat tiba</span>';
    return '<span class="badge tak-ada">Jam buka belum ada datanya</span>';
}

function gambarHasil(hasil, input, matriksEstimasi) {
    hasilLayer.clearLayers();
    const panel = document.getElementById("hasil");
    const isi = document.getElementById("hasilIsi");

    if (!hasil.stops.length) {
        isi.innerHTML = `<p class="hasil-kosong">${esc(hasil.pesan || "Tidak ada rekomendasi.")}</p>
            <p>Klik <b>Ubah Preferensi</b> untuk mencoba pilihan lain.</p>`;
        panel.style.display = "block";
        return;
    }

    // Rute jalan
    const garis = L.geoJSON(hasil.rute, {
        style: { color: "#c2410c", weight: 5, opacity: 0.8 }
    }).addTo(hasilLayer);

    // Penanda bernomor
    const markerStop = [];
    hasil.stops.forEach(s => {
        const m = L.marker([s.lat, s.lng], { icon: ikonNomor(s.urutan) })
            .bindPopup(`<b>${s.urutan}. ${esc(s.nama)}</b><br>${esc(s.kategori || "")}`)
            .addTo(hasilLayer);
        markerStop.push(m);
    });

    map.fitBounds(garis.getBounds().pad(0.15));

    // Panel hasil
    const hari = new Date(input.jamBerangkat).toLocaleDateString("id-ID", { weekday: "long" });
    const catatan = [];
    if (hasil.pesan) catatan.push(hasil.pesan);
    if (hasil.estimasiWaktuAwal || hasil.estimasiRute)
        catatan.push("Server rute (OSRM) tidak terjangkau; waktu dari titik awal dan garis rute diperkirakan dari jarak lurus.");
    if (matriksEstimasi)
        catatan.push("Matriks waktu antar-wisata (data/matriks_osrm.json) tidak termuat; waktu antar-wisata diperkirakan.");

    const stopHtml = hasil.stops.map((s, i) => `
        <li class="stop" data-i="${i}">
            <div class="stop-no">${s.urutan}</div>
            <div class="stop-isi">
                <div class="stop-nama">${esc(s.nama)}</div>
                <div class="stop-kat">${esc(s.kategori || "")}${s.info.kapanewon ? " · Kapanewon " + esc(s.info.kapanewon) : ""}</div>
                <div class="stop-baris">Perjalanan ${fmtDurasi(s.perjalananMenit)} (${s.perjalananKm.toFixed(1)} km)</div>
                <div class="stop-baris">Tiba ${fmtJam(s.tiba)}, selesai ${fmtJam(s.selesai)}</div>
                <div class="stop-baris">
                    ${s.rating != null ? "Rating " + s.rating.toString().replace(".", ",") : "Belum ada rating"}
                    (${s.ulasan.toLocaleString("id-ID")} ulasan) · ${s.biaya > 0 ? fmtRp(s.biaya) : "Gratis"}
                </div>
                <div class="stop-baris">${labelBuka(s.buka)}
                    ${s.info.url_maps ? `<a href="${esc(s.info.url_maps)}" target="_blank" rel="noopener">Buka di Google Maps</a>` : ""}
                </div>
                <div class="stop-skor">Skor SAW ${s.skor.toFixed(4)} · peringkat ${s.peringkat}</div>
            </div>
        </li>`).join("");

    const w = SAW.WEIGHTS, k = SAW.CRITERIA;
    const bobot = k.map((c, i) => `${c.name} ${(w[i] * 100).toFixed(1)}%`).join(", ");

    isi.innerHTML = `
        <div class="ringkas">
            <div><span>Berangkat</span><b>${fmtJam(hasil.mulai)} (${esc(hari)})</b></div>
            <div><span>Total waktu</span><b>${fmtDurasi(hasil.totalMenit)}</b></div>
            <div><span>Total jarak</span><b>${hasil.totalKm.toFixed(1)} km</b></div>
            <div><span>Biaya per orang</span><b>${hasil.totalBiaya > 0 ? fmtRp(hasil.totalBiaya) : "Gratis"}</b></div>
        </div>
        ${catatan.map(c => `<p class="catatan">${esc(c)}</p>`).join("")}
        <ol class="daftar-stop">${stopHtml}</ol>
        ${hasil.pulang ? `<p class="pulang">Pulang ke titik awal: ${fmtDurasi(hasil.pulang.menit)} (${hasil.pulang.km.toFixed(1)} km), tiba ${fmtJam(hasil.pulang.tiba)}.</p>` : ""}
        <p class="bobot">Bobot AHP: ${esc(bobot)}. Biaya sudah termasuk perkiraan makan.</p>
    `;

    isi.querySelectorAll(".stop").forEach(li => {
        li.addEventListener("click", () => {
            const m = markerStop[+li.dataset.i];
            map.setView(m.getLatLng(), 15);
            m.openPopup();
        });
    });

    panel.style.display = "block";
}

document.getElementById("btnTutupHasil").addEventListener("click", () => {
    document.getElementById("hasil").style.display = "none";
});

tampilkanPertanyaan();
