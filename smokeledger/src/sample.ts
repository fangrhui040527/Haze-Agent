// Generates a FICTIONAL haze episode (3-9 Oct 2026) in the exact formats real downloads
// use (FIRMS CSV, Open-Meteo JSON, GeoJSON, CSV). Company names are invented.
// Also writes pm25_forecast_update.json: a later forecast used by the heartbeat scenario.
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_TOWNS } from "./config.ts";

export function generateSample(OUT: string): string[] {
  fs.mkdirSync(OUT, { recursive: true });
  const H = 3_600_000;
  const start = Date.UTC(2026, 9, 3, 0); // 3 Oct 2026 00Z
  const end = Date.UTC(2026, 9, 9, 0);
  const hours = (end - start) / H;
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const omTime = (ms: number) => new Date(ms).toISOString().slice(0, 16); // Open-Meteo GMT format

  // ---- wind: south-westerly monsoon until 7 Oct 12Z, then south-easterly ----
  const shift = Date.UTC(2026, 9, 7, 12);
  const windAt = (t: number, level: "850hPa" | "10m") => {
    const sw = t < shift;
    const dir = (sw ? 225 : 135) + (level === "10m" ? 15 : 0) + (rnd() - 0.5) * 10;
    const spd = (level === "10m" ? 4 : 7) + (rnd() - 0.5) * 1.5;
    return { dir, spd };
  };
  const pts: [number, number][] = [];
  for (let la = -6; la <= 8; la++) for (let lo = 95; lo <= 120; lo++) pts.push([la, lo]);
  for (let i = 0; i < pts.length; i += 100) {
    const chunk = pts.slice(i, i + 100).map(([la, lo]) => {
      const time: string[] = [];
      const s850: number[] = [], d850: number[] = [], s10: number[] = [], d10: number[] = [];
      for (let h = 0; h <= hours; h++) {
        const t = start + h * H;
        time.push(omTime(t));
        const a = windAt(t, "850hPa");
        const b = windAt(t, "10m");
        s850.push(+a.spd.toFixed(2)); d850.push(Math.round(a.dir));
        s10.push(+b.spd.toFixed(2)); d10.push(Math.round(b.dir));
      }
      return {
        latitude: la + 0.03, // Open-Meteo returns grid-snapped coordinates, not exactly what you asked
        longitude: lo - 0.02,
        utc_offset_seconds: 0,
        timezone: "GMT",
        hourly_units: { time: "iso8601", wind_speed_850hPa: "m/s", wind_direction_850hPa: "°", wind_speed_10m: "m/s", wind_direction_10m: "°" },
        hourly: { time, wind_speed_850hPa: s850, wind_direction_850hPa: d850, wind_speed_10m: s10, wind_direction_10m: d10 },
      };
    });
    fs.writeFileSync(path.join(OUT, `wind_${i / 100 + 1}.json`), JSON.stringify(chunk));
  }

  // ---- fires (FIRMS VIIRS CSV columns) ----
  const clusters = [
    { name: "A: in concession, half on peat (Riau-like)", lat: 0.6, lon: 101.6, spread: 0.12, n: 9, frp: 40 },
    { name: "B: unmapped land on peat", lat: 0.25, lon: 101.95, spread: 0.1, n: 6, frp: 30 },
    { name: "C: Kalimantan concession (not upwind of Johor)", lat: -1.5, lon: 113.5, spread: 0.12, n: 8, frp: 45 },
  ];
  const rows = ["latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight"];
  for (let d = Date.UTC(2026, 9, 3); d <= Date.UTC(2026, 9, 8); d += 24 * H)
    for (const [hhmm, dn] of [["0536", "D"], ["1742", "N"]] as const)
      for (const c of clusters)
        for (let k = 0; k < c.n; k++) {
          const lat = (c.lat + (rnd() - 0.5) * 2 * c.spread).toFixed(5);
          const lon = (c.lon + (rnd() - 0.5) * 2 * c.spread).toFixed(5);
          const date = new Date(d).toISOString().slice(0, 10);
          const conf = rnd() < 0.1 ? "l" : rnd() < 0.5 ? "n" : "h";
          rows.push(`${lat},${lon},340.1,0.4,0.4,${date},${hhmm},N,VIIRS,${conf},2.0NRT,295.2,${(c.frp * (0.4 + rnd())).toFixed(2)},${dn}`);
        }
  fs.writeFileSync(path.join(OUT, "firms_viirs_snpp.csv"), rows.join("\n") + "\n");

  // ---- concessions (GFW-like property names) and peat ----
  const box = (lat: number, lon: number, r: number) => ({
    type: "Polygon",
    coordinates: [[[lon - r, lat - r], [lon + r, lat - r], [lon + r, lat + r], [lon - r, lat + r], [lon - r, lat - r]]],
  });
  fs.writeFileSync(
    path.join(OUT, "concessions.geojson"),
    JSON.stringify({
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: { objectid: 101, name: "PT Contoh Sawit Lestari", company: "PT Contoh Sawit Lestari", group_comp: "Contoh Agri Group", type: "Oil palm", country: "Indonesia" }, geometry: box(0.6, 101.6, 0.15) },
        { type: "Feature", properties: { objectid: 102, name: "PT Hutan Contoh Jaya", company: "PT Hutan Contoh Jaya", group_comp: "Rimba Contoh Holdings", type: "Wood fiber", country: "Indonesia" }, geometry: box(-1.5, 113.5, 0.15) },
        { type: "Feature", properties: { objectid: 103, name: "PT Tenang Contoh", company: "PT Tenang Contoh", group_comp: "Contoh Agri Group", type: "Oil palm", country: "Indonesia" }, geometry: box(1.0, 100.8, 0.1) },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(OUT, "peat.geojson"),
    JSON.stringify({
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[101.45, 0.1], [102.1, 0.1], [102.1, 0.6], [101.45, 0.6], [101.45, 0.1]]] } },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(OUT, "companies.csv"),
    [
      "group_name,parent_country,rspo_member,grievance_contact,known_buyers,notes",
      "Contoh Agri Group,Malaysia,yes,grievance@contoh-agri.example,Example Buyer A; Example Buyer B,FICTIONAL test record",
      "Rimba Contoh Holdings,Indonesia,no,info@rimba-contoh.example,,FICTIONAL test record",
    ].join("\n") + "\n",
  );

  // ---- PM2.5: CAMS-like model for all towns (hindsight) + ground observations for Batu Pahat ----
  const episode = (town: string, t: number) => {
    const peakT = Date.UTC(2026, 9, 6, 18);
    const amp =
      town === "Batu Pahat" ? 200 : town === "Muar" || town === "Melaka" ? 150 : ["Klang", "Shah Alam", "Kuala Lumpur"].includes(town) ? 110 : town === "Johor Bahru" ? 90 : 25;
    const rise = Math.exp(-(((t - peakT) / (30 * H)) ** 2));
    const after = t > shift ? Math.exp(-(t - shift) / (10 * H)) : 1;
    return 18 + amp * rise * after + 4 * Math.sin(t / (6 * H));
  };
  const model = DEFAULT_TOWNS.map((t) => {
    const time: string[] = [];
    const pm: number[] = [];
    for (let h = 0; h <= hours; h++) {
      const ms = start + h * H;
      time.push(omTime(ms));
      pm.push(+(episode(t.town, ms) * 0.85).toFixed(1)); // models usually under-read haze peaks
    }
    return { latitude: t.lat, longitude: t.lon, utc_offset_seconds: 0, hourly_units: { pm2_5: "μg/m³" }, hourly: { time, pm2_5: pm } };
  });
  fs.writeFileSync(path.join(OUT, "pm25_model_hindsight.json"), JSON.stringify(model));
  const obs = ["town,valid_utc,pm25"];
  for (let h = 0; h <= hours; h++) {
    const ms = start + h * H;
    obs.push(`Batu Pahat,${new Date(ms).toISOString()},${(episode("Batu Pahat", ms) * (0.95 + rnd() * 0.1)).toFixed(1)}`);
  }
  fs.writeFileSync(path.join(OUT, "pm25_observed_batu_pahat.csv"), obs.join("\n") + "\n");


  // A newer forecast, issued 6 Oct 14:00 UTC, that raises Klang-area PM2.5 on 7 Oct (heartbeat scenario).
  const upd = DEFAULT_TOWNS.filter((t) => ["Klang", "Shah Alam", "Kuala Lumpur"].includes(t.town)).map((t) => {
    const time: string[] = [];
    const pm: number[] = [];
    for (let ms = Date.UTC(2026, 9, 6, 14); ms <= Date.UTC(2026, 9, 8, 0); ms += H) {
      time.push(omTime(ms));
      const bump = ms >= Date.UTC(2026, 9, 6, 20) && ms <= Date.UTC(2026, 9, 7, 6) ? 70 : 0;
      pm.push(+(episode(t.town, ms) * 0.85 + bump).toFixed(1));
    }
    return { latitude: t.lat, longitude: t.lon, utc_offset_seconds: 0, hourly_units: { pm2_5: "μg/m³" }, hourly: { time, pm2_5: pm } };
  });
  fs.writeFileSync(path.join(OUT, "pm25_forecast_update.json"), JSON.stringify(upd));
  fs.writeFileSync(
    path.join(OUT, "MANIFEST.md"),
    "# Sample inputs (FICTIONAL)\n\nGenerated by src/sample.ts. Every value and company name is invented for testing.\n" +
      "Formats match NASA FIRMS (CSV), Open-Meteo forecast/air-quality (JSON), GeoJSON maps and companies.csv.\n" +
      "pm25_forecast_update.json is a newer forecast (issued 2026-10-06T14:00Z) for Klang, Shah Alam and Kuala Lumpur used by the heartbeat scenario.\n",
  );
  return fs.readdirSync(OUT);
}

export const UPDATE_TOWNS = ["Klang", "Shah Alam", "Kuala Lumpur"];
export const UPDATE_ISSUED = "2026-10-06T14:00:00.000Z";
