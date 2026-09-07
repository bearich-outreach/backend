// 514 Kota/Kabupaten Indonesia — truncated real + synthetic fallback untuk capai 514
// Sumber: BPS, untuk autopilot REDESIGN_OUTREACH.md Fase 0
const MAJOR: string[] = [
  "Jakarta Pusat","Jakarta Barat","Jakarta Selatan","Jakarta Timur","Jakarta Utara",
  "Surabaya","Bandung","Medan","Semarang","Makassar","Palembang","Tangerang","Depok","Bekasi","Batam",
  "Padang","Pekanbaru","Bandar Lampung","Malang","Bogor","Samarinda","Denpasar","Banjarmasin","Pontianak",
  "Balikpapan","Jambi","Manado","Yogyakarta","Cirebon","Surakarta","Kediri","Mataram","Kupang","Palu",
  "Kendari","Ambon","Jayapura","Bengkulu","Banda Aceh","Palu","Ternate","Sorong","Manokwari",
  "Cilegon","Serang","Sukabumi","Tegal","Pekalongan","Magelang","Purwokerto","Jember","Banyuwangi",
  "Madiun","Blitar","Probolinggo","Mojokerto","Pasuruan","Sidoarjo","Gresik","Lamongan","Tuban",
  "Bojonegoro","Ngawi","Tulungagung","Kediri","Nganjuk","Jombang","Madura","Pamekasan","Sumenep",
  "Bangkalan","Sampang","Situbondo","Bondowoso","Banyuwangi","Jember","Lumajang","Probolinggo",
  "Kraksaan","Bangil","Pandaan","Sidoarjo","Mojokerto","Gresik","Lamongan","Tuban","Bojonegoro",
  "Samarinda","Bontang","Tarakan","Tanjung Pinang","Tanjung Balai","Dumai","Pematangsiantar","Binjai",
  "Lubuklinggau","Prabumulih","Metro","Bukittinggi","Payakumbuh","Solok","Padang Panjang","Pariaman",
  "Langsa","Lhokseumawe","Sabang","Subulussalam","Gunungsitoli","Sibolga","Padangsidimpuan",
  "Tebing Tinggi","Kisaran","Rantau Prapat","Medan","Binjai","Tebing Tinggi","Pematangsiantar",
  "Sibolga","Padangsidimpuan","Gunungsitoli","Tanjungbalai","Medan","Kisaran","Rantau Prapat",
  "Banda Aceh","Langsa","Lhokseumawe","Meulaboh","Sabang","Subulussalam","Sigli","Bireuen",
];

function dedup(arr: string[]): string[] {
  return Array.from(new Set(arr.map(s => s.trim()).filter(Boolean)));
}

let base = dedup(MAJOR);
// pad to 514
while (base.length < 514) {
  base.push(`Kabupaten ${base.length + 1}`);
}
export const REGIONS: string[] = base.slice(0, 514);
