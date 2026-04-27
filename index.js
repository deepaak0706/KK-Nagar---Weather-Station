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

/**
 * 1-MIN CRON: Memory Buffer Only (No DB)
 */
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

        if (state.tW === null || apiW > state.bufW)       { state.bufW = apiW; state.tW = currentTimeStamp; }
        if (state.tG === null || apiG > state.bufG)       { state.bufG = apiG; state.tG = currentTimeStamp; }
        if (state.tMaxT === null || apiT > state.bufMaxT) { state.bufMaxT = apiT; state.tMaxT = currentTimeStamp; }
        if (state.tMinT === null || apiT < state.bufMinT) { state.bufMinT = apiT; state.tMinT = currentTimeStamp; }

        const rawDailyInches = d.rainfall.daily.value;
        const timeElapsedSec = state.lastFetchTime ? (now - state.lastFetchTime) / 1000 : 0;
        let customRateIn = 0;

        if (state.lastRainRaw !== null && timeElapsedSec > 0) {
            const deltaRain = rawDailyInches - state.lastRainRaw;
            if (deltaRain < 0) {
                state.lastRainTime = now; state.lastCalculatedRate = 0; state.lastRainRaw = rawDailyInches;
            } else if (deltaRain > 0 && timeElapsedSec >= 30) {
                customRateIn = deltaRain * (3600 / timeElapsedSec);
                state.lastCalculatedRate = customRateIn; state.lastRainTime = now;
            } else if (state.lastCalculatedRate > 0) {
                const timeSinceLastRain = (now - state.lastRainTime) / 1000;
                const decayRate = 0.01 * (3600 / timeSinceLastRain);
                if (timeSinceLastRain > 900) { state.lastCalculatedRate = 0; }
                else if (decayRate < state.lastCalculatedRate) { state.lastCalculatedRate = decayRate; }
                customRateIn = state.lastCalculatedRate;
            }
        } else {
            state.lastRainRaw = rawDailyInches; state.lastRainTime = now; state.lastCalculatedRate = 0;
        }
        state.lastRainRaw = rawDailyInches;
        if (state.tRR === null || customRateIn > state.bufRR) { state.bufRR = customRateIn; state.tRR = currentTimeStamp; }

        state.lastFetchTime = now;
        return { ok: true, buffered: true };
    } catch (e) { return { error: e.message }; }
}

/**
 * MAIN SYNC
 */
async function syncWithEcowitt(forceWrite = false) {
    const now = Date.now();
    const nowIST = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const todayISTStr = nowIST.toLocaleDateString('en-CA'); 
    const hour = nowIST.getHours();
    const minute = nowIST.getMinutes();

    if (state.lastArchivedDate && state.lastArchivedDate !== todayISTStr) {
        state.cachedData = null;
    }

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
            const fmtIso = (isoStr) => isoStr ? new Date(isoStr).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }) : fmtL();

            if (liveTemp > state.cachedData.temp.max) { state.cachedData.temp.max = liveTemp; state.cachedData.temp.maxTime = fmtL(); }
            if (liveTemp < state.cachedData.temp.min) { state.cachedData.temp.min = liveTemp; state.cachedData.temp.minTime = fmtL(); }
            if (liveWind > state.cachedData.wind.maxS) { state.cachedData.wind.maxS = liveWind; state.cachedData.wind.maxSTime = fmtL(); }
            if (liveGust > state.cachedData.wind.maxG) { state.cachedData.wind.maxG = liveGust; state.cachedData.wind.maxGTime = fmtL(); }
            
            const liveRR = parseFloat((state.lastCalculatedRate * 25.4).toFixed(1));
            if (liveRR > state.cachedData.rain.maxR) { state.cachedData.rain.maxR = liveRR; state.cachedData.rain.maxRTime = fmtL(); }

            if (state.bufMaxT !== -999) {
                const bMx = parseFloat(((state.bufMaxT - 32) * 5/9).toFixed(1));
                if (bMx > state.cachedData.temp.max) { state.cachedData.temp.max = bMx; state.cachedData.temp.maxTime = fmtIso(state.tMaxT); }
            }
            if (state.bufMinT !== 999) {
                const bMn = parseFloat(((state.bufMinT - 32) * 5/9).toFixed(1));
                if (bMn < state.cachedData.temp.min) { state.cachedData.temp.min = bMn; state.cachedData.temp.minTime = fmtIso(state.tMinT); }
            }
            if (state.bufW > 0) {
                const bW = parseFloat((state.bufW * 1.60934).toFixed(1));
                if (bW > state.cachedData.wind.maxS) { state.cachedData.wind.maxS = bW; state.cachedData.wind.maxSTime = fmtIso(state.tW); }
            }
            if (state.bufG > 0) {
                const bG = parseFloat((state.bufG * 1.60934).toFixed(1));
                if (bG > state.cachedData.wind.maxG) { state.cachedData.wind.maxG = bG; state.cachedData.wind.maxGTime = fmtIso(state.tG); }
            }
            if (state.bufRR > 0) {
                const bRR = parseFloat((state.bufRR * 25.4).toFixed(1));
                if (bRR > state.cachedData.rain.maxR) { state.cachedData.rain.maxR = bRR; state.cachedData.rain.maxRTime = fmtIso(state.tRR); }
            }

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
                if (hour === 0 && minute < 5) {
                    timeSql = "(date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata') - INTERVAL '1 second'";
                }
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
                `, [
                    dbMaxT, dbMinT, liveHum, dbW, dbG, dbRR, d.rainfall.daily.value,
                    state.tW || new Date().toISOString(), 
                    state.tMaxT || new Date().toISOString(), 
                    state.tMinT || new Date().toISOString(), 
                    state.tRR || (state.lastRainTime ? new Date(state.lastRainTime).toISOString() : new Date().toISOString()),
                    state.tG || new Date().toISOString(), 
                    d.solar_and_uvi?.solar?.value || 0, 
                    d.pressure.relative.value || 0
                ]);

                if (hour === 0 && minute < 30 && state.lastArchivedDate !== todayISTStr) {
                    await client.query(`
                        INSERT INTO daily_max_records (record_date, max_temp_c, min_temp_c, max_wind_kmh, max_gust_kmh, total_rain_mm)
                        SELECT 
                            (time AT TIME ZONE 'Asia/Kolkata')::date, 
                            MAX((temp_f - 32) * 5/9), MIN((temp_min_f - 32) * 5/9), 
                            MAX(wind_speed_mph * 1.60934), MAX(wind_gust_mph * 1.60934), 
                            MAX(daily_rain_in * 25.4)
                        FROM weather_history 
                        WHERE (time AT TIME ZONE 'Asia/Kolkata')::date < $1::date
                        GROUP BY 1 
                        ON CONFLICT (record_date) DO UPDATE SET 
                            max_temp_c=EXCLUDED.max_temp_c, min_temp_c=EXCLUDED.min_temp_c, 
                            max_wind_kmh=EXCLUDED.max_wind_kmh, max_gust_kmh=EXCLUDED.max_gust_kmh, 
                            total_rain_mm=EXCLUDED.total_rain_mm;
                    `, [todayISTStr]);

                    await client.query(`DELETE FROM weather_history WHERE (time AT TIME ZONE 'Asia/Kolkata')::date < $1::date`, [todayISTStr]);
                    state.lastArchivedDate = todayISTStr;
                    state.cachedData = null; 
                    resetStateBuffers(); 
                }
                await client.query('COMMIT');
                state.dataChangedSinceLastRead = true;
                resetStateBuffers(); 
            } catch (err) { 
                await client.query('ROLLBACK'); 
                console.error("CRITICAL: DB Write Failed.", err); 
            } finally { client.release(); }
        }

        let tempRate = state.cachedData?.temp?.rate || 0, humRate = state.cachedData?.atmo?.hTrend || 0, pressRate = state.cachedData?.atmo?.pTrend || 0;
        let mx_t = state.cachedData?.temp?.max || liveTemp, mn_t = state.cachedData?.temp?.min || liveTemp;
        let mx_w = state.cachedData?.wind?.maxS || 0, mx_g = state.cachedData?.wind?.maxG || 0, mx_r = state.cachedData?.rain?.maxR || 0;

        const fmtL = () => new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });

        let mx_t_time = state.cachedData?.temp?.maxTime || fmtL();
        let mn_t_time = state.cachedData?.temp?.minTime || fmtL();
        let mx_w_t = state.cachedData?.wind?.maxSTime || fmtL();
        let mx_g_t = state.cachedData?.wind?.maxGTime || fmtL();
        let mx_r_t = state.cachedData?.rain?.maxRTime || fmtL();

        if (state.dataChangedSinceLastRead || !state.cachedData) {
            try {
                const historyRes = await pool.query(`
                    SELECT * FROM weather_history 
                    WHERE (time AT TIME ZONE 'Asia/Kolkata')::date = $1::date 
                    ORDER BY time ASC
                `, [todayISTStr]);
                
                let pastRecord = null;
                const oneHourAgo = Date.now() - 3600000;

                historyRes.rows.forEach(r => {
                    const fmt = (iso) => new Date(iso || r.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
                    const r_max_t = parseFloat(((r.temp_f - 32) * 5 / 9).toFixed(1));
                    const r_min_t = parseFloat(((r.temp_min_f - 32) * 5 / 9).toFixed(1));
                    const r_w = parseFloat((r.wind_speed_mph * 1.60934).toFixed(1));
                    const r_g = parseFloat((r.wind_gust_mph * 1.60934).toFixed(1));
                    const r_rr = parseFloat((r.rain_rate_in * 25.4).toFixed(1));

                    if (r_max_t > mx_t) { mx_t = r_max_t; mx_t_time = fmt(r.max_t_time); }
                    if (r_min_t < mn_t) { mn_t = r_min_t; mn_t_time = fmt(r.min_t_time); }
                    if (r_w > mx_w) { mx_w = r_w; mx_w_t = fmt(r.max_w_time); }
                    if (r_g > mx_g) { mx_g = r_g; mx_g_t = fmt(r.max_g_time); }
                    if (r_rr > mx_r) { mx_r = r_rr; mx_r_t = fmt(r.max_r_time); }
                    
                    if (!pastRecord && new Date(r.time).getTime() >= oneHourAgo) {
                        pastRecord = r;
                    }
                });

                if (!pastRecord && historyRes.rows.length > 0) pastRecord = historyRes.rows[0];

                if (pastRecord) {
                    const pastTemp = parseFloat(((pastRecord.temp_f - 32) * 5 / 9).toFixed(1));
                    tempRate = parseFloat((liveTemp - pastTemp).toFixed(1));
                    humRate = parseFloat((liveHum - pastRecord.humidity).toFixed(1));
                    if (pastRecord.press_rel) {
                        pressRate = parseFloat((livePress - parseFloat((pastRecord.press_rel * 33.8639).toFixed(1))).toFixed(1));
                    }
                }
                state.dataChangedSinceLastRead = false;
            } catch (dbError) { console.error("DB Prep Error:", dbError); }
        }

        const liveWind = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));
        const liveGust = parseFloat((d.wind.wind_gust.value * 1.60934).toFixed(1));
        const liveRR = parseFloat((state.lastCalculatedRate * 25.4).toFixed(1));

        const fmtIso = (isoStr) => isoStr ? new Date(isoStr).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }) : fmtL();

        if (liveTemp > mx_t) { mx_t = liveTemp; mx_t_time = fmtL(); }
        if (liveTemp < mn_t) { mn_t = liveTemp; mn_t_time = fmtL(); }
        if (liveWind > mx_w) { mx_w = liveWind; mx_w_t = fmtL(); }
        if (liveGust > mx_g) { mx_g = liveGust; mx_g_t = fmtL(); }
        if (liveRR > mx_r)   { mx_r = liveRR; mx_r_t = fmtL(); }

        state.cachedData = {
            temp: { current: liveTemp, max: mx_t, maxTime: mx_t_time, min: mn_t, minTime: mn_t_time, realFeel: calculateRealFeel(liveTemp, liveHum), rate: tempRate, dew: parseFloat((liveTemp - ((100 - liveHum) / 5)).toFixed(1)) },
            atmo: { hum: liveHum, hTrend: humRate, press: livePress, pTrend: pressRate, sol: d.solar_and_uvi?.solar?.value || 0, uv: d.solar_and_uvi?.uvi?.value || 0 },
            wind: { speed: liveWind, gust: liveGust, maxS: mx_w, maxSTime: mx_w_t, maxG: mx_g, maxGTime: mx_g_t, deg: d.wind.wind_direction.value, card: getCard(d.wind.wind_direction.value) },
            rain: { total: parseFloat((d.rainfall.daily.value * 25.4).toFixed(1)), rate: liveRR, maxR: mx_r, maxRTime: mx_r_t, weekly: parseFloat((d.rainfall.weekly.value * 25.4).toFixed(1)), monthly: parseFloat((d.rainfall.monthly.value * 25.4).toFixed(1)), yearly: parseFloat((d.rainfall.yearly.value * 25.4).toFixed(1)) },
            lastSync: new Date().toISOString()
        };

        state.lastFetchTime = now;
        return state.cachedData;
    } catch (e) { console.error("Sync Error:", e); return state.cachedData; }
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

/**
 * ROUTES
 */
app.get("/weather", async (req, res) => res.json(await syncWithEcowitt(false)));
app.get("/api/summary", async (req, res) => res.json(await getWeatherSummary()));
app.get("/api/sync", async (req, res) => {
    if (req.query.buffer === 'true') return res.json(await bufferOnlyUpdate());
    res.json(await syncWithEcowitt(req.query.write === 'true'));
});
app.get("/api/history_graphs", async (req, res) => {
    const todayISTStr = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })).toLocaleDateString('en-CA');
    try {
        const historyRes = await pool.query(`SELECT * FROM weather_history WHERE (time AT TIME ZONE 'Asia/Kolkata')::date = $1::date ORDER BY time ASC`, [todayISTStr]);
        const history = historyRes.rows.map(r => ({
            time: r.time, temp: parseFloat(((r.temp_f - 32) * 5 / 9).toFixed(1)), hum: r.humidity, wind: parseFloat((r.wind_speed_mph * 1.60934).toFixed(1)), rain: parseFloat((r.daily_rain_in * 25.4).toFixed(1))
        }));
        res.json(history);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/historical-rain', async (req, res) => {
    const { year } = req.query;
    if (!year) return res.status(400).json({ error: "Year is required" });
    try {
        const result = await pool.query('SELECT month_val, rainfall_mm FROM historical_rainfall WHERE year_val = $1 ORDER BY id ASC', [parseInt(year)]);
        res.json({ year: year, data: result.rows });
    } catch (err) { res.status(500).json({ error: "Database query failed" }); }
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
        :root { 
            --bg: #f0f9ff; --card: #ffffff; --border: rgba(2, 132, 199, 0.08); --text: #0f172a; --muted: #64748b; --accent: #0284c7; --glow: 0 8px 30px rgba(2, 132, 199, 0.04); --tile: #f8fafc;
        }
        body.is-night {
            --bg: #0f172a; --card: #1e293b; --border: rgba(255, 255, 255, 0.05); --text: #f1f5f9; --muted: #94a3b8; --accent: #38bdf8; --glow: 0 10px 40px rgba(0,0,0,0.4); --tile: rgba(255,255,255,0.03);
        }
        body { margin: 0; font-family: 'Outfit', sans-serif; background: var(--bg); color: var(--text); padding: 20px 16px 120px 16px; transition: background 0.5s ease; min-height: 100vh; }
        .container { width: 100%; max-width: 1200px; margin: 0 auto; }
        .header { margin-bottom: 24px; display: flex; justify-content: space-between; align-items: center; }
        .header h1 { font-size: 24px; font-weight: 900; margin: 0; letter-spacing: -0.5px; }
        .theme-toggle { background: var(--card); border: 1px solid var(--border); padding: 4px; border-radius: 12px; display: flex; gap: 4px; cursor: pointer; }
        .theme-btn { padding: 6px 10px; border-radius: 8px; font-size: 11px; font-weight: 700; color: var(--muted); }
        .theme-btn.active { background: var(--accent); color: white; }
        
        .nav-tabs { display: flex; gap: 8px; margin-bottom: 24px; }
        .tab-btn { background: var(--card); border: 1px solid var(--border); padding: 10px 20px; border-radius: 14px; color: var(--text); font-weight: 700; cursor: pointer; transition: 0.2s; font-size: 14px; }
        .tab-btn.active { background: var(--accent); color: white; border-color: var(--accent); box-shadow: var(--glow); }

        /* BENTO GRID SYSTEM */
        .bento-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 16px; }
        
        .bento-card { 
            background: var(--card); border-radius: 28px; border: 1px solid var(--border); padding: 24px; 
            box-shadow: var(--glow); position: relative; overflow: hidden; display: flex; flex-direction: column;
        }

        .card-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; }
        .card-label { font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); }
        .card-icon { font-size: 20px; }

        .card-body { flex: 1; }
        .main-value-row { display: flex; align-items: baseline; gap: 4px; margin-bottom: 24px; }
        .main-value { font-size: 64px; font-weight: 900; letter-spacing: -2px; line-height: 1; }
        .main-unit { font-size: 20px; font-weight: 600; color: var(--muted); }
        
        .trend-pill { font-size: 11px; font-weight: 800; padding: 6px 12px; border-radius: 100px; background: var(--tile); display: inline-flex; align-items: center; gap: 4px; }

        /* NESTED TILES */
        .tiles-container { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: auto; }
        .bento-tile { background: var(--tile); border-radius: 18px; padding: 14px; display: flex; flex-direction: column; gap: 4px; border: 1px solid var(--border); }
        .tile-label { font-size: 9px; font-weight: 800; text-transform: uppercase; color: var(--muted); letter-spacing: 0.5px; }
        .tile-value { font-size: 16px; font-weight: 800; display: flex; align-items: baseline; gap: 2px; }
        .tile-sub { font-size: 9px; opacity: 0.5; font-weight: 600; }

        #needle { width: 3px; height: 32px; background: linear-gradient(to bottom, #ef4444 50%, var(--muted) 50%); clip-path: polygon(50% 0%, 100% 100%, 50% 85%, 0% 100%); transition: transform 2s cubic-bezier(0.1, 0.9, 0.2, 1); }
        .compass-ring { width: 50px; height: 50px; border: 2px solid var(--border); border-radius: 50%; display: flex; align-items: center; justify-content: center; }

        @keyframes magicFade {
            0% { opacity: 0; filter: blur(8px); transform: translateY(4px); }
            100% { opacity: 1; filter: blur(0); transform: translateY(0); }
        }
        .fade-update { animation: magicFade 0.8s ease-out; }

        @media (max-width: 480px) {
            .main-value { font-size: 48px; }
            .bento-grid { grid-template-columns: 1fr; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>KK Nagar Live</h1>
            <div class="theme-toggle" id="themeToggle">
                <div class="theme-btn" id="btn-light">LIGHT</div>
                <div class="theme-btn" id="btn-dark">DARK</div>
                <div class="theme-btn active" id="btn-auto">AUTO</div>
            </div>
        </div>

        <div class="nav-tabs">
            <button onclick="showPage('dashboard')" id="tab-dash" class="tab-btn active">Dashboard</button>
            <button onclick="showPage('summary')" id="tab-sum" class="tab-btn">Monthly</button>
            <button onclick="showPage('historical')" id="tab-hist" class="tab-btn">Rainfall History</button>
        </div>

        <div id="page-dashboard">
            <div class="bento-grid">
                
                <div class="bento-card">
                    <div class="card-header">
                        <div class="card-label">Temperature</div>
                        <div class="card-icon">🌡️</div>
                    </div>
                    <div class="card-body">
                        <div class="main-value-row">
                            <div class="main-value" id="t">--.-</div>
                            <div class="main-unit">°C</div>
                        </div>
                        <div id="tTrendBox" class="trend-pill" style="margin-bottom:20px">--</div>
                    </div>
                    <div class="tiles-container">
                        <div class="bento-tile">
                            <span class="tile-label">Peak Today</span>
                            <span class="tile-value" style="color:#ef4444"><span id="mx">--</span><span class="tile-sub">°C</span></span>
                        </div>
                        <div class="bento-tile">
                            <span class="tile-label">Lowest</span>
                            <span class="tile-value" style="color:#0ea5e9"><span id="mn">--</span><span class="tile-sub">°C</span></span>
                        </div>
                        <div class="bento-tile">
                            <span class="tile-label">Feels Like</span>
                            <span class="tile-value" id="rf">--.-</span>
                        </div>
                        <div class="bento-tile">
                            <span class="tile-label">Humidity</span>
                            <span class="tile-value" id="h_val">--%</span>
                        </div>
                    </div>
                </div>

                <div class="bento-card">
                    <div class="card-header">
                        <div class="card-label">Wind Dynamics</div>
                        <div class="compass-ring"><div id="needle"></div></div>
                    </div>
                    <div class="card-body">
                        <div class="main-value-row">
                            <div class="main-value" id="w">--.-</div>
                            <div class="main-unit">km/h</div>
                        </div>
                        <div class="trend-pill" style="margin-bottom:20px">
                            <span id="wd_bracket">--</span> Direction
                        </div>
                    </div>
                    <div class="tiles-container">
                        <div class="bento-tile">
                            <span class="tile-label">Max Sustained</span>
                            <span class="tile-value"><span id="mw">--</span><span class="tile-sub">km/h</span></span>
                        </div>
                        <div class="bento-tile">
                            <span class="tile-label">Peak Gust</span>
                            <span class="tile-value" style="color:#f59e0b"><span id="mg">--</span><span class="tile-sub">km/h</span></span>
                        </div>
                        <div class="bento-tile" style="grid-column: span 2;">
                            <span class="tile-label">Live Gust Speed</span>
                            <span class="tile-value" id="wg">-- km/h</span>
                        </div>
                    </div>
                </div>

                <div class="bento-card">
                    <div class="card-header">
                        <div class="card-label">Precipitation</div>
                        <div class="card-icon">💧</div>
                    </div>
                    <div class="card-body">
                        <div class="main-value-row">
                            <div class="main-value" id="r_tot">--.-</div>
                            <div class="main-unit">mm</div>
                        </div>
                        <div class="trend-pill" style="margin-bottom:20px">
                            Rate: <span id="r_rate" style="margin:0 4px">0.0</span> mm/h
                        </div>
                    </div>
                    <div class="tiles-container">
                        <div class="bento-tile">
                            <span class="tile-label">Today's Max Rate</span>
                            <span class="tile-value" id="mr">--.-</span>
                        </div>
                        <div class="bento-tile">
                            <span class="tile-label">Monthly</span>
                            <span class="tile-value" id="r_month">--</span>
                        </div>
                        <div class="bento-tile" style="grid-column: span 2; background: var(--accent); color: white; border: none;">
                            <span class="tile-label" style="color: rgba(255,255,255,0.7)">Annual Total</span>
                            <span class="tile-value" style="font-size: 20px;"><span id="r_year">--</span><span class="tile-sub" style="color:white">mm</span></span>
                        </div>
                    </div>
                </div>

            </div>

            <div style="margin-top: 32px; text-align: center;">
                <div style="font-size: 11px; opacity: 0.5; text-transform: uppercase; letter-spacing: 2px;">Last Updated</div>
                <div id="ts" style="font-weight: 800; font-size: 14px;">--:--:--</div>
            </div>
        </div>

        <div id="page-summary" style="display: none;"><div id="summary-content"></div></div>
        <div id="page-historical" style="display: none;"><div id="historical-content"></div></div>
    </div>

    <script>
        let currentMode = localStorage.getItem('weatherMode') || 'auto';
        
        function applyTheme() {
            const hour = new Date().getHours();
            const isDark = currentMode === 'dark' || (currentMode === 'auto' && (hour >= 18 || hour < 6));
            document.body.classList.toggle('is-night', isDark);
            document.querySelectorAll('.theme-btn').forEach(btn => btn.classList.remove('active'));
            if (currentMode === 'light') document.getElementById('btn-light').classList.add('active');
            else if (currentMode === 'dark') document.getElementById('btn-dark').classList.add('active');
            else document.getElementById('btn-auto').classList.add('active');
        }

        document.getElementById('btn-light').onclick = () => { currentMode = 'light'; localStorage.setItem('weatherMode', 'light'); applyTheme(); };
        document.getElementById('btn-dark').onclick = () => { currentMode = 'dark'; localStorage.setItem('weatherMode', 'dark'); applyTheme(); };
        document.getElementById('btn-auto').onclick = () => { currentMode = 'auto'; localStorage.setItem('weatherMode', 'auto'); applyTheme(); };

        function updateValue(id, newValue, decimals = 1) {
            const obj = document.getElementById(id);
            if (!obj) return;
            const val = parseFloat(newValue || 0).toFixed(decimals);
            if (obj.innerText !== val) {
                obj.classList.remove('fade-update');
                void obj.offsetWidth;
                obj.innerText = val;
                obj.classList.add('fade-update');
            }
        }

        async function update() {
            try {
                const res = await fetch('/weather?v=' + Date.now()); 
                const d = await res.json(); 
                if (!d || d.error) return;

                updateValue('t', d.temp.current);
                updateValue('mx', d.temp.max);
                updateValue('mn', d.temp.min);
                updateValue('rf', d.temp.realFeel);
                document.getElementById('h_val').innerText = d.atmo.hum + '%';
                document.getElementById('tTrendBox').innerHTML = d.temp.rate > 0 ? '▲ +' + d.temp.rate + '°/hr' : d.temp.rate < 0 ? '▼ ' + d.temp.rate + '°/hr' : '● Steady';

                updateValue('w', d.wind.speed);
                updateValue('mw', d.wind.maxS);
                updateValue('mg', d.wind.maxG);
                updateValue('wg', d.wind.gust);
                document.getElementById('wd_bracket').innerText = d.wind.card;
                document.getElementById('needle').style.transform = 'rotate(' + d.wind.deg + 'deg)';

                updateValue('r_tot', d.rain.total);
                updateValue('r_rate', d.rain.rate);
                updateValue('mr', d.rain.maxR);
                updateValue('r_month', d.rain.monthly);
                updateValue('r_year', d.rain.yearly);

                document.getElementById('ts').innerText = new Date(d.lastSync).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            } catch (e) { console.error(e); }
        }

        function showPage(p) {
            document.getElementById('page-dashboard').style.display = p === 'dashboard' ? 'block' : 'none';
            document.getElementById('page-summary').style.display = p === 'summary' ? 'block' : 'none';
            document.getElementById('page-historical').style.display = p === 'historical' ? 'block' : 'none';
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.getElementById('tab-' + p.substring(0,4)).classList.add('active');
        }

        applyTheme(); update(); setInterval(update, 30000);
    </script>
</body>
</html>
    `);
});

app.listen(3000);
