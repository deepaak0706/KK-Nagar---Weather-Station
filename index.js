const express = require("express"); 
const fetch = require("node-fetch");
const { Pool } = require('pg');
const path = require("path");
const app = express();

const pool = new Pool({
    connectionString: process.env.POSTGRES_URL + "?sslmode=require",
    ssl: { rejectUnauthorized: false }
});

const APPLICATION_KEY = process.env.APPLICATION_KEY;
const API_KEY = process.env.API_KEY;
const MAC = process.env.MAC;

/**
 * GLOBAL STATE ENGINE
 */
let state = { 
    cachedData: null, 
    lastFetchTime: 0, 
    lastDbWrite: 0,
    lastRainRaw: null, 
    lastCalculatedRate: 0, 
    lastRainTime: 0, 
    bufW: 0, 
    bufG: 0, 
    bufMaxT: -999, 
    bufMinT: 999, 
    bufRR: 0,
    tW: null, 
    tG: null, 
    tMaxT: null, 
    tMinT: null, 
    tRR: null,
    lastArchivedDate: null,
    dataChangedSinceLastRead: false,
    summaryCache: null,
    lastSummaryFetchDate: null,
};

function resetStateBuffers() {
    state.bufW = 0; state.bufG = 0; state.bufMaxT = -999; state.bufMinT = 999; state.bufRR = 0;
    state.tW = null; state.tG = null; state.tMaxT = null; state.tMinT = null; state.tRR = null;
}

const getCard = (a) => {
    const directions = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
    return directions[Math.round(a / 22.5) % 16];
};

function calculateRealFeel(tempC, humidity) {
    const T = (tempC * 9/5) + 32;
    const R = humidity;
    let hi = 0.5 * (T + 61.0 + ((T - 68.0) * 1.2) + (R * 0.094));
    if (hi > 79) {
        hi = -42.379 + 2.04901523*T + 10.14333127*R - 0.22475541*T*R - 0.00683783*T*T - 0.05481717*R*R + 0.00122874*T*T*R + 0.00085282*T*R*R - 0.00000199*T*T*R*R;
    }
    return parseFloat(((hi - 32) * 5 / 9).toFixed(1));
}

async function bufferOnlyUpdate() {
    const now = Date.now();
    const currentTimeStamp = new Date().toISOString();
    try {
        const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}`;
        const response = await fetch(url);
        const json = await response.json();
        if (!json.data) throw new Error("Invalid API Response");
        const d = json.data;
        const apiW = parseFloat(d.wind.wind_speed.value);
        const apiG = parseFloat(d.wind.wind_gust.value);
        const apiT = parseFloat(d.outdoor.temperature.value);
        if (state.tW === null || apiW > state.bufW) { state.bufW = apiW; state.tW = currentTimeStamp; }
        if (state.tG === null || apiG > state.bufG) { state.bufG = apiG; state.tG = currentTimeStamp; }
        if (state.tMaxT === null || apiT > state.bufMaxT) { state.bufMaxT = apiT; state.tMaxT = currentTimeStamp; }
        if (state.tMinT === null || apiT < state.bufMinT) { state.bufMinT = apiT; state.tMinT = currentTimeStamp; }
        const rawDailyInches = d.rainfall.daily.value;
        const timeElapsedSec = state.lastFetchTime ? (now - state.lastFetchTime) / 1000 : 0;
        let customRateIn = 0;
        if (state.lastRainRaw !== null && timeElapsedSec > 0) {
            const deltaRain = rawDailyInches - state.lastRainRaw;
            if (deltaRain < 0) { state.lastRainTime = now; state.lastCalculatedRate = 0; state.lastRainRaw = rawDailyInches; }
            else if (deltaRain > 0 && timeElapsedSec >= 30) { customRateIn = deltaRain * (3600 / timeElapsedSec); state.lastCalculatedRate = customRateIn; state.lastRainTime = now; }
            else if (state.lastCalculatedRate > 0) {
                const timeSinceLastRain = (now - state.lastRainTime) / 1000;
                const decayRate = 0.01 * (3600 / timeSinceLastRain);
                if (timeSinceLastRain > 900) { state.lastCalculatedRate = 0; }
                else if (decayRate < state.lastCalculatedRate) { state.lastCalculatedRate = decayRate; }
                customRateIn = state.lastCalculatedRate;
            }
        } else { state.lastRainRaw = rawDailyInches; state.lastRainTime = now; state.lastCalculatedRate = 0; }
        state.lastRainRaw = rawDailyInches;
        if (state.tRR === null || customRateIn > state.bufRR) { state.bufRR = customRateIn; state.tRR = currentTimeStamp; }
        state.lastFetchTime = now;
        return { ok: true, buffered: true };
    } catch (e) { return { error: e.message }; }
}

async function syncWithEcowitt(forceWrite = false) {
    const now = Date.now();
    const nowIST = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const todayISTStr = nowIST.toLocaleDateString('en-CA'); 
    const hour = nowIST.getHours();
    const minute = nowIST.getMinutes();

    if (state.lastArchivedDate && state.lastArchivedDate !== todayISTStr) { state.cachedData = null; }

    if (!forceWrite && state.cachedData && (now - state.lastFetchTime < 540000)) {
        try {
            const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}`;
            const response = await fetch(url);
            const json = await response.json();
            const d = json.data;
            const liveTemp = parseFloat(((d.outdoor.temperature.value - 32) * 5 / 9).toFixed(1));
            const liveWind = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));
            const liveGust = parseFloat((d.wind.wind_gust.value * 1.60934).toFixed(1));
            const liveHum = d.outdoor.humidity.value || 0;
            const livePress = parseFloat((d.pressure.relative.value * 33.8639).toFixed(1));
            state.cachedData.atmo.press = livePress;
            state.cachedData.atmo.hum = liveHum;
            state.cachedData.temp.realFeel = calculateRealFeel(liveTemp, liveHum);
            const fmtL = () => new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
            if (liveTemp > state.cachedData.temp.max) { state.cachedData.temp.max = liveTemp; state.cachedData.temp.maxTime = fmtL(); }
            if (liveTemp < state.cachedData.temp.min) { state.cachedData.temp.min = liveTemp; state.cachedData.temp.minTime = fmtL(); }
            if (liveWind > state.cachedData.wind.maxS) { state.cachedData.wind.maxS = liveWind; state.cachedData.wind.maxSTime = fmtL(); }
            if (liveGust > state.cachedData.wind.maxG) { state.cachedData.wind.maxG = liveGust; state.cachedData.wind.maxGTime = fmtL(); }
            const liveRR = parseFloat((state.lastCalculatedRate * 25.4).toFixed(1));
            if (liveRR > state.cachedData.rain.maxR) { state.cachedData.rain.maxR = liveRR; state.cachedData.rain.maxRTime = fmtL(); }
            state.cachedData.temp.current = liveTemp;
            state.cachedData.wind.speed = liveWind;
            state.cachedData.wind.gust = liveGust;
            state.cachedData.lastSync = new Date().toISOString();
            state.lastFetchTime = now;
            return state.cachedData;
        } catch (e) { return state.cachedData; }
    }

    try {
        const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}`;
        const response = await fetch(url);
        const json = await response.json();
        const d = json.data;
        const liveTemp = parseFloat(((d.outdoor.temperature.value - 32) * 5 / 9).toFixed(1));
        const liveHum = d.outdoor.humidity.value || 0;
        const livePress = parseFloat((d.pressure.relative.value * 33.8639).toFixed(1));

        if (forceWrite) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                let timeSql = 'NOW()';
                if (hour === 0 && minute < 5) { timeSql = "(date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata') - INTERVAL '1 second'"; }
                const dbMaxT = state.bufMaxT === -999 ? d.outdoor.temperature.value : state.bufMaxT;
                const dbMinT = state.bufMinT === 999 ? d.outdoor.temperature.value : state.bufMinT;
                const dbW = state.tW === null ? d.wind.wind_speed.value : state.bufW;
                const dbG = state.tG === null ? d.wind.wind_gust.value : state.bufG;
                const dbRR = state.tRR === null ? (state.lastCalculatedRate || 0) : state.bufRR;
                await client.query(`
                    INSERT INTO weather_history 
                    (time, temp_f, temp_min_f, humidity, wind_speed_mph, wind_gust_mph, rain_rate_in, daily_rain_in, 
                     max_w_time, max_t_time, min_t_time, max_r_time, max_g_time, solar_radiation, press_rel)
                    VALUES (${timeSql}, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                `, [dbMaxT, dbMinT, liveHum, dbW, dbG, dbRR, d.rainfall.daily.value, state.tW || new Date().toISOString(), state.tMaxT || new Date().toISOString(), state.tMinT || new Date().toISOString(), state.tRR || new Date().toISOString(), state.tG || new Date().toISOString(), d.solar_and_uvi?.solar?.value || 0, d.pressure.relative.value || 0]);
                if (hour === 0 && minute < 30 && state.lastArchivedDate !== todayISTStr) {
                    await client.query(`
                        INSERT INTO daily_max_records (record_date, max_temp_c, min_temp_c, max_wind_kmh, max_gust_kmh, total_rain_mm)
                        SELECT (time AT TIME ZONE 'Asia/Kolkata')::date, MAX((temp_f - 32) * 5/9), MIN((temp_min_f - 32) * 5/9), MAX(wind_speed_mph * 1.60934), MAX(wind_gust_mph * 1.60934), MAX(daily_rain_in * 25.4)
                        FROM weather_history WHERE (time AT TIME ZONE 'Asia/Kolkata')::date < $1::date GROUP BY 1 ON CONFLICT (record_date) DO UPDATE SET max_temp_c=EXCLUDED.max_temp_c, min_temp_c=EXCLUDED.min_temp_c, max_wind_kmh=EXCLUDED.max_wind_kmh, max_gust_kmh=EXCLUDED.max_gust_kmh, total_rain_mm=EXCLUDED.total_rain_mm;
                    `, [todayISTStr]);
                    await client.query(`DELETE FROM weather_history WHERE (time AT TIME ZONE 'Asia/Kolkata')::date < $1::date`, [todayISTStr]);
                    state.lastArchivedDate = todayISTStr; state.cachedData = null; resetStateBuffers(); 
                }
                await client.query('COMMIT');
                state.dataChangedSinceLastRead = true; resetStateBuffers(); 
            } catch (err) { await client.query('ROLLBACK'); } finally { client.release(); }
        }

        let mx_t = state.cachedData?.temp?.max || liveTemp, mn_t = state.cachedData?.temp?.min || liveTemp;
        let mx_w = state.cachedData?.wind?.maxS || 0, mx_g = state.cachedData?.wind?.maxG || 0, mx_r = state.cachedData?.rain?.maxR || 0;
        const fmtL = () => new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
        let mx_t_time = state.cachedData?.temp?.maxTime || fmtL(), mn_t_time = state.cachedData?.temp?.minTime || fmtL(), mx_w_t = mx_t_time, mx_g_t = mx_t_time, mx_r_t = mx_t_time;

        const liveWind = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));
        const liveGust = parseFloat((d.wind.wind_gust.value * 1.60934).toFixed(1));
        const liveRR = parseFloat((state.lastCalculatedRate * 25.4).toFixed(1));

        if (liveTemp > mx_t) { mx_t = liveTemp; mx_t_time = fmtL(); }
        if (liveTemp < mn_t) { mn_t = liveTemp; mn_t_time = fmtL(); }
        if (liveWind > mx_w) { mx_w = liveWind; mx_w_t = fmtL(); }
        if (liveGust > mx_g) { mx_g = liveGust; mx_g_t = fmtL(); }
        if (liveRR > mx_r) { mx_r = liveRR; mx_r_t = fmtL(); }

        state.cachedData = {
            temp: { current: liveTemp, max: mx_t, maxTime: mx_t_time, min: mn_t, minTime: mn_t_time, realFeel: calculateRealFeel(liveTemp, liveHum), rate: state.cachedData?.temp?.rate || 0, dew: parseFloat((liveTemp - ((100 - liveHum) / 5)).toFixed(1)) },
            atmo: { hum: liveHum, hTrend: state.cachedData?.atmo?.hTrend || 0, press: livePress, pTrend: state.cachedData?.atmo?.pTrend || 0, sol: d.solar_and_uvi?.solar?.value || 0, uv: d.solar_and_uvi?.uvi?.value || 0 },
            wind: { speed: liveWind, gust: liveGust, maxS: mx_w, maxSTime: mx_w_t, maxG: mx_g, maxGTime: mx_g_t, deg: d.wind.wind_direction.value, card: getCard(d.wind.wind_direction.value) },
            rain: { total: parseFloat((d.rainfall.daily.value * 25.4).toFixed(1)), rate: liveRR, maxR: mx_r, maxRTime: mx_r_t, weekly: parseFloat((d.rainfall.weekly.value * 25.4).toFixed(1)), monthly: parseFloat((d.rainfall.monthly.value * 25.4).toFixed(1)), yearly: parseFloat((d.rainfall.yearly.value * 25.4).toFixed(1)) },
            lastSync: new Date().toISOString()
        };
        state.lastFetchTime = now;
        return state.cachedData;
    } catch (e) { return state.cachedData; }
}

async function getWeatherSummary() {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    if (state.summaryCache && state.lastSummaryFetchDate === today) return state.summaryCache;
    try {
        const res = await pool.query(`SELECT * FROM daily_max_records ORDER BY record_date DESC`);
        const formatted = res.rows.reduce((acc, row) => {
            const mY = new Date(row.record_date).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
            if (!acc[mY]) acc[mY] = [];
            acc[mY].push(row);
            return acc;
        }, {});
        state.summaryCache = formatted; state.lastSummaryFetchDate = today;
        return formatted;
    } catch (err) { return { error: err.message }; }
}

// Routes
app.get("/weather", async (req, res) => res.json(await syncWithEcowitt(false)));
app.get("/api/summary", async (req, res) => res.json(await getWeatherSummary()));
app.get("/api/history", async (req, res) => {
    const todayISTStr = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })).toLocaleDateString('en-CA');
    try {
        const historyRes = await pool.query(`SELECT * FROM weather_history WHERE (time AT TIME ZONE 'Asia/Kolkata')::date = $1::date ORDER BY time ASC`, [todayISTStr]);
        const history = historyRes.rows.map(r => ({
            time: r.time, temp: parseFloat(((r.temp_f - 32) * 5 / 9).toFixed(1)), hum: r.humidity, wind: parseFloat((r.wind_speed_mph * 1.60934).toFixed(1)), 
            rain: parseFloat((r.daily_rain_in * 25.4).toFixed(1))
        }));
        res.json(history);
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/sync", async (req, res) => {
    if (req.query.buffer === 'true') return res.json(await bufferOnlyUpdate());
    res.json(await syncWithEcowitt(req.query.write === 'true'));
});

app.get("/", (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <title>KK Nagar Weather Hub</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;700;900&display=swap" rel="stylesheet">
    <style>
        :root { --bg: #e0f2fe; --card: rgba(255, 255, 255, 0.85); --border: rgba(2, 132, 199, 0.1); --text: #0f172a; --muted: #64748b; --accent: #0284c7; --glow: 0 10px 40px -10px rgba(2, 132, 199, 0.15); --badge: rgba(2, 132, 199, 0.05); }
        body.is-night { --bg: #0f172a; --card: rgba(30, 41, 59, 0.7); --border: rgba(255, 255, 255, 0.08); --text: #f1f5f9; --muted: #94a3b8; --accent: #38bdf8; --glow: 0 15px 50px -12px rgba(0,0,0,0.6); --badge: rgba(255, 255, 255, 0.04); }
        body { margin: 0; font-family: 'Outfit', sans-serif; background: var(--bg); color: var(--text); padding: 20px 16px 120px 16px; transition: 0.5s; min-height: 100vh; overflow-x: hidden; }
        .container { width: 100%; max-width: 1200px; margin: 0 auto; }
        .header { margin-bottom: 32px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px; }
        .header h1 { font-size: 28px; font-weight: 900; margin: 0; letter-spacing: -1px; }
        .status-bar { display: flex; align-items: center; gap: 8px; background: var(--card); padding: 6px 16px; border-radius: 100px; border: 1px solid var(--border); box-shadow: var(--glow); font-size: 13px; }
        .live-dot { width: 6px; height: 6px; background: #10b981; border-radius: 50%; animation: blink 2s infinite; }
        @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        
        /* TABS */
        .nav-tabs { display: flex; gap: 8px; margin-bottom: 25px; }
        .tab-btn { background: var(--card); border: 1px solid var(--border); padding: 12px 24px; border-radius: 16px; color: var(--text); font-weight: 700; cursor: pointer; transition: 0.3s; }
        .tab-btn.active { background: var(--accent); color: white; border-color: var(--accent); box-shadow: var(--glow); }

        .grid-system { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
        .card { background: var(--card); padding: 28px; border-radius: 32px; border: 1px solid var(--border); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); box-shadow: var(--glow); position: relative; overflow: hidden; }
        .label { color: var(--accent); font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 6px; }
        .main-val { font-size: 56px; font-weight: 900; margin: 0; letter-spacing: -2px; display: flex; align-items: baseline; line-height: 1.1; }
        .unit { font-size: 20px; font-weight: 600; color: var(--muted); margin-left: 4px; }
        .sub-pill { font-size: 12px; font-weight: 800; padding: 6px 12px; border-radius: 10px; background: var(--badge); display: inline-flex; align-items: center; gap: 4px; margin: 12px 0 20px 0; }
        .sub-box-4 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding-top: 20px; border-top: 1px solid var(--border); }
        .badge { padding: 12px; border-radius: 18px; background: var(--badge); display: flex; flex-direction: column; gap: 2px; }
        .badge-label { font-size: 9px; color: var(--muted); text-transform: uppercase; font-weight: 800; }
        .badge-val { font-size: 16px; font-weight: 800; }
        
        /* INLINE 24H SECTION */
        .history-panel { margin-top: 40px; }
        .history-controls { display: flex; gap: 10px; margin-bottom: 20px; justify-content: center; }
        .hist-btn { background: var(--card); border: 1px solid var(--border); padding: 10px 24px; border-radius: 14px; color: var(--text); font-weight: 700; cursor: pointer; transition: 0.3s; }
        .hist-btn.active { background: var(--accent); color: white; border-color: var(--accent); }
        .graph-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
        .graph-card { background: var(--card); padding: 20px; border-radius: 24px; border: 1px solid var(--border); height: 260px; }
        
        /* MONTHLY SUMMARY STYLES */
        .month-header { font-size: 20px; font-weight: 800; margin: 25px 0 15px 0; color: var(--accent); }
        .summary-table-wrapper { overflow-x: auto; background: var(--card); border-radius: 24px; border: 1px solid var(--border); }
        .summary-table { width: 100%; border-collapse: collapse; min-width: 600px; }
        .summary-table th { padding: 16px; background: var(--badge); text-align: left; font-size: 11px; text-transform: uppercase; color: var(--muted); }
        .summary-table td { padding: 16px; border-top: 1px solid var(--border); font-size: 14px; }
        
        canvas#windCanvas { position: absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; }
        #needle { width: 3px; height: 32px; background: linear-gradient(to bottom, #ef4444 50%, var(--muted) 50%); clip-path: polygon(50% 0%, 100% 100%, 50% 85%, 0% 100%); transition: 2s; }
        .compass-ui { position: absolute; top: 28px; right: 28px; width: 50px; height: 50px; border: 2px solid var(--border); border-radius: 50%; display: flex; align-items: center; justify-content: center; }
        @keyframes magicFade { 0% { opacity: 0; filter: blur(8px); transform: translateY(5px); } 100% { opacity: 1; filter: blur(0); transform: translateY(0); } }
        .fade-update { animation: magicFade 0.8s ease; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>KK Nagar Weather Hub</h1>
            <div class="status-bar"><div class="live-dot"></div><div id="ts">--:--:--</div></div>
        </div>

        <div class="nav-tabs">
            <button onclick="showPage('dashboard')" id="tab-dash" class="tab-btn active">Live Dashboard</button>
            <button onclick="showPage('summary')" id="tab-sum" class="tab-btn">Monthly Summary</button>
        </div>

        <div id="page-dashboard">
            <div class="grid-system">
                <div class="card">
                    <div class="label">Temperature</div>
                    <div class="main-val"><span id="t">0.0</span><span class="unit">°C</span></div>
                    <div id="tTrend" class="sub-pill">--</div>
                    <div class="sub-box-4">
                        <div class="badge"><span class="badge-label">Today High</span><span id="mx" class="badge-val" style="color:#ef4444">--</span></div>
                        <div class="badge"><span class="badge-label">Today Low</span><span id="mn" class="badge-val" style="color:#0ea5e9">--</span></div>
                        <div class="badge"><span class="badge-label">Humidity</span><span id="h_val" class="badge-val">--</span></div>
                        <div class="badge"><span class="badge-label">Feels Like</span><span id="rf" class="badge-val">--</span></div>
                    </div>
                </div>
                <div class="card">
                    <canvas id="windCanvas"></canvas>
                    <div class="label">Wind Dynamics</div>
                    <div class="compass-ui"><div id="needle"></div></div>
                    <div class="main-val"><span id="w">0.0</span><span class="unit">km/h</span></div>
                    <div class="sub-pill">● Gust: <span id="wg">--</span></div>
                    <div class="sub-box-4">
                        <div class="badge"><span class="badge-label">Max Speed</span><span id="mw" class="badge-val">--</span></div>
                        <div class="badge"><span class="badge-label">Max Gust</span><span id="mg" class="badge-val">--</span></div>
                    </div>
                </div>
                <div class="card">
                    <div class="label">Rain Realm</div>
                    <div class="main-val"><span id="r_tot">0.0</span><span class="unit">mm</span></div>
                    <div class="sub-pill">● Rate: <span id="r_rate">0.0</span> mm/h</div>
                    <div class="sub-box-4">
                        <div class="badge" style="grid-column: span 2;"><span class="badge-label">Peak Rate Today</span><span id="mr" class="badge-val">--</span></div>
                        <div class="badge"><span class="badge-label">Weekly</span><span id="r_week" class="badge-val">--</span></div>
                        <div class="badge"><span class="badge-label">Monthly</span><span id="r_month" class="badge-val">--</span></div>
                    </div>
                </div>
                <div class="card">
                    <div class="label">Atmospheric</div>
                    <div class="main-val"><span id="pr">--</span><span class="unit">hPa</span></div>
                    <div class="sub-box-4">
                        <div class="badge"><span class="badge-label">Solar Rad</span><span id="sol" class="badge-val">--</span></div>
                        <div class="badge"><span class="badge-label">UV Index</span><span id="uv" class="badge-val">--</span></div>
                    </div>
                </div>
            </div>

            <div class="history-panel">
                <div class="history-controls">
                    <button onclick="toggleHist('summary')" id="btn-sum-24" class="hist-btn active">24H Summary</button>
                    <button onclick="toggleHist('graphs')" id="btn-graph-24" class="hist-btn">24H Graphs</button>
                </div>
                <div id="panel-summary" class="card" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; text-align:center;">
                    <div class="badge"><span class="badge-label">Peak Temp</span><span id="sum-mx" class="badge-val" style="color:#ef4444">--</span></div>
                    <div class="badge"><span class="badge-label">Low Temp</span><span id="sum-mn" class="badge-val" style="color:#0ea5e9">--</span></div>
                    <div class="badge"><span class="badge-label">Max Wind</span><span id="sum-mw" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Max Rate</span><span id="sum-mr" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Total Rain</span><span id="sum-rt" class="badge-val">--</span></div>
                </div>
                <div id="panel-graphs" class="graph-grid" style="display: none;">
                    <div class="graph-card"><canvas id="cT"></canvas></div>
                    <div class="graph-card"><canvas id="cH"></canvas></div>
                    <div class="graph-card"><canvas id="cW"></canvas></div>
                    <div class="graph-card"><canvas id="cR"></canvas></div>
                </div>
            </div>
        </div>

        <div id="page-summary" style="display: none;">
            <div id="summary-content"></div>
        </div>
    </div>

    <script>
        let charts = {};
        function applyTheme() { const h = new Date().getHours(); if(h>=18 || h<6) document.body.classList.add('is-night'); }
        
        function showPage(p) {
            document.getElementById('page-dashboard').style.display = p === 'dashboard' ? 'block' : 'none';
            document.getElementById('page-summary').style.display = p === 'summary' ? 'block' : 'none';
            document.getElementById('tab-dash').classList.toggle('active', p === 'dashboard');
            document.getElementById('tab-sum').classList.toggle('active', p === 'summary');
            if(p === 'summary') fetchMonthlySummary();
        }

        async function fetchMonthlySummary() {
            const content = document.getElementById('summary-content');
            content.innerHTML = '<div class="card" style="text-align:center; padding:40px;">Generating Report...</div>';
            try {
                const res = await fetch('/api/summary');
                const groups = await res.json();
                let html = '';
                for (const [month, days] of Object.entries(groups)) {
                    html += \`<div class="month-header">\${month}</div><div class="summary-table-wrapper"><table class="summary-table"><thead><tr><th>Date</th><th>Max Temp</th><th>Min Temp</th><th>Wind/Gust</th><th>Rain</th></tr></thead><tbody>\${days.map(d => \`<tr><td><b>\${new Date(d.record_date).getDate()}</b></td><td style="color:#ef4444;">\${d.max_temp_c}°C</td><td style="color:#0ea5e9;">\${d.min_temp_c}°C</td><td>\${d.max_wind_kmh}/\${d.max_gust_kmh}</td><td>\${d.total_rain_mm}mm</td></tr>\`).join('')}</tbody></table></div>\`;
                }
                content.innerHTML = html || 'No records found.';
            } catch (e) { content.innerHTML = 'Error loading summary.'; }
        }

        function setupChart(id, label, color) {
            return new Chart(document.getElementById(id).getContext('2d'), {
                type: 'line', data: { labels: [], datasets: [{ label, data: [], borderColor: color, tension: 0.4, pointRadius: 0, borderWidth: 2 }] },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { maxTicksLimit: 6 } } } }
            });
        }

        async function toggleHist(type) {
            document.getElementById('panel-summary').style.display = type === 'summary' ? 'grid' : 'none';
            document.getElementById('panel-graphs').style.display = type === 'graphs' ? 'grid' : 'none';
            document.getElementById('btn-sum-24').classList.toggle('active', type === 'summary');
            document.getElementById('btn-graph-24').classList.toggle('active', type === 'graphs');
            if(type === 'graphs') {
                const res = await fetch('/api/history');
                const data = await res.json();
                const labels = data.map(h => new Date(h.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }));
                if(!charts.cT) { charts.cT = setupChart('cT', 'Temp', '#ef4444'); charts.cH = setupChart('cH', 'Hum', '#10b981'); charts.cW = setupChart('cW', 'Wind', '#f59e0b'); charts.cR = setupChart('cR', 'Rain', '#3b82f6'); }
                charts.cT.data.labels = labels; charts.cT.data.datasets[0].data = data.map(h => h.temp); charts.cT.update();
                charts.cH.data.labels = labels; charts.cH.data.datasets[0].data = data.map(h => h.hum); charts.cH.update();
                charts.cW.data.labels = labels; charts.cW.data.datasets[0].data = data.map(h => h.wind); charts.cW.update();
                charts.cR.data.labels = labels; charts.cR.data.datasets[0].data = data.map(h => h.rain); charts.cR.update();
            }
        }

        function updateUI(id, val) { 
            const el = document.getElementById(id); 
            if(el.innerText != val) { el.classList.remove('fade-update'); void el.offsetWidth; el.innerText = val; el.classList.add('fade-update'); }
        }

        async function update() {
            const res = await fetch('/weather'); const d = await res.json();
            updateUI('t', d.temp.current.toFixed(1)); updateUI('w', d.wind.speed.toFixed(1));
            updateUI('mx', d.temp.max + '°C'); updateUI('mn', d.temp.min + '°C');
            updateUI('h_val', d.atmo.hum + '%'); updateUI('rf', d.temp.realFeel + '°C');
            updateUI('wg', d.wind.gust + ' km/h'); updateUI('mw', d.wind.maxS + ' km/h');
            updateUI('mg', d.wind.maxG + ' km/h'); updateUI('r_tot', d.rain.total.toFixed(1));
            updateUI('r_rate', d.rain.rate.toFixed(1)); updateUI('mr', d.rain.maxR + ' mm/h');
            updateUI('r_week', d.rain.weekly + ' mm'); updateUI('r_month', d.rain.monthly + ' mm');
            updateUI('pr', d.atmo.press); updateUI('sol', d.atmo.sol); updateUI('uv', d.atmo.uv);
            document.getElementById('ts').innerText = new Date(d.lastSync).toLocaleTimeString();
            document.getElementById('needle').style.transform = \`rotate(\${d.wind.deg}deg)\`;
            // Sync RAM Summary
            document.getElementById('sum-mx').innerText = d.temp.max + '°C';
            document.getElementById('sum-mn').innerText = d.temp.min + '°C';
            document.getElementById('sum-mw').innerText = d.wind.maxS + ' km/h';
            document.getElementById('sum-mr').innerText = d.rain.maxR + ' mm/h';
            document.getElementById('sum-rt').innerText = d.rain.total + ' mm';
        }

        applyTheme(); setInterval(update, 30000); update();
    </script>
</body>
</html>
    `);
});

if (process.env.NODE_ENV !== 'production') { app.listen(3000); }
module.exports = app;
