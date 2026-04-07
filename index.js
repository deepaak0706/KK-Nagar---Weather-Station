const express = require("express");
const fetch = require("node-fetch");
const { Pool } = require('pg');
const app = express();

/**
 * DATABASE & ENV CONFIG
 * Hardened with timeouts to prevent Vercel 500 errors.
 */
const pool = new Pool({
    connectionString: process.env.POSTGRES_URL + "?sslmode=require",
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000 
});

const { APPLICATION_KEY, API_KEY, MAC } = process.env;

let state = { 
    cachedData: null, lastFetchTime: 0, lastDbWrite: 0,
    lastRainRaw: null, lastCalculatedRate: 0, lastRainTime: 0,
    bufW: 0, bufG: 0, bufMaxT: -999, bufMinT: 999, bufRR: 0,
    tW: null, tG: null, tMaxT: null, tMinT: null, tRR: null 
};

function resetStateBuffers() {
    state.bufW = 0; state.bufG = 0; state.bufMaxT = -999; state.bufMinT = 999; state.bufRR = 0;
    state.tW = null; state.tG = null; state.tMaxT = null; state.tMinT = null; state.tRR = null;
}

const getCard = (a) => ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"][Math.round(a / 22.5) % 16];

function calculateRealFeel(tempC, humidity) {
    const T = (tempC * 9/5) + 32;
    const R = humidity;
    if (T < 80) return parseFloat(tempC.toFixed(1));
    let hi = -42.379 + 2.04901523 * T + 10.14333127 * R - 0.22475541 * T * R - 0.00683783 * T * T - 0.05481717 * R * R + 0.00122874 * T * T * R + 0.00085282 * T * R * R - 0.00000199 * T * T * R * R;
    return parseFloat(((hi - 32) * 5 / 9).toFixed(1));
}

async function syncWithEcowitt(forceWrite = false) {
    const now = Date.now();
    if (!forceWrite && state.cachedData && (now - state.lastFetchTime < 40000)) return state.cachedData;

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        
        const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}`;
        const response = await fetch(url, { signal: controller.signal });
        const json = await response.json();
        clearTimeout(timeout);
        
        if (!json.data) throw new Error(json.msg || "No API Data");
        const d = json.data;
        const currentTimeStamp = new Date().toISOString();

        const tempF = d.outdoor.temperature.value;
        const liveTemp = parseFloat(((tempF - 32) * 5 / 9).toFixed(1));
        const liveHum = d.outdoor.humidity.value || 0;
        const livePress = parseFloat((d.pressure.relative.value * 33.8639).toFixed(1));
        const liveWindMph = d.wind.wind_speed.value;
        const liveGustMph = d.wind.wind_gust.value;

        if (state.tW === null || liveWindMph > state.bufW) { state.bufW = liveWindMph; state.tW = currentTimeStamp; }
        if (state.tG === null || liveGustMph > state.bufG) { state.bufG = liveGustMph; state.tG = currentTimeStamp; }
        if (state.tMaxT === null || tempF > state.bufMaxT) { state.bufMaxT = tempF; state.tMaxT = currentTimeStamp; }
        if (state.tMinT === null || tempF < state.bufMinT) { state.bufMinT = tempF; state.tMinT = currentTimeStamp; }
        
        const rawDailyIn = d.rainfall.daily.value;
        let customRateIn = 0;
        if (state.lastRainRaw !== null) {
            const delta = rawDailyIn - state.lastRainRaw;
            const timeDiff = (now - state.lastFetchTime) / 1000;
            if (delta > 0 && timeDiff > 0) {
                customRateIn = delta * (3600 / timeDiff);
                state.lastCalculatedRate = customRateIn;
                state.lastRainTime = now;
            } else if (now - state.lastRainTime > 900000) {
                state.lastCalculatedRate = 0;
            }
            customRateIn = state.lastCalculatedRate;
        }
        state.lastRainRaw = rawDailyIn;
        if (state.tRR === null || customRateIn > state.bufRR) { state.bufRR = customRateIn; state.tRR = currentTimeStamp; }

        if (forceWrite) {
            await pool.query(`
                INSERT INTO weather_history 
                (time, temp_f, humidity, wind_speed_mph, wind_gust_mph, daily_rain_in, solar_radiation, press_rel, rain_rate_in, temp_min_f, max_t_time, min_t_time, max_w_time, max_g_time, max_r_time) 
                VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`, 
                [state.bufMaxT, liveHum, state.bufW, state.bufG, rawDailyIn, d.solar_and_uvi?.solar?.value || 0, livePress, state.bufRR, state.bufMinT, state.tMaxT, state.tMinT, state.tW, state.tG, state.tRR]);
            
            const dateCheck = await pool.query(`SELECT 1 FROM weather_history WHERE (time AT TIME ZONE 'Asia/Kolkata')::date < (NOW() AT TIME ZONE 'Asia/Kolkata')::date LIMIT 1`);
            if (dateCheck.rows.length > 0) {
                await pool.query(`
                    INSERT INTO daily_max_records (record_date, max_temp_c, min_temp_c, max_wind_kmh, max_gust_kmh, total_rain_mm) 
                    SELECT (time AT TIME ZONE 'Asia/Kolkata')::date, MAX((temp_f - 32) * 5/9), MIN((temp_min_f - 32) * 5/9), MAX(wind_speed_mph * 1.60934), MAX(wind_gust_mph * 1.60934), MAX(daily_rain_in * 25.4) 
                    FROM weather_history WHERE (time AT TIME ZONE 'Asia/Kolkata')::date < (NOW() AT TIME ZONE 'Asia/Kolkata')::date
                    GROUP BY 1 ON CONFLICT (record_date) DO NOTHING;
                `);
                await pool.query(`DELETE FROM weather_history WHERE (time AT TIME ZONE 'Asia/Kolkata')::date < (NOW() AT TIME ZONE 'Asia/Kolkata')::date;`);
            }
            resetStateBuffers();
        }

        const historyRes = await pool.query(`SELECT * FROM weather_history WHERE (time AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date ORDER BY time ASC`);
        const oneHourRes = await pool.query(`SELECT temp_f, humidity FROM weather_history WHERE time >= NOW() - INTERVAL '1 hour' ORDER BY time ASC LIMIT 1`);
        
        let mx_t = -999, mn_t = 999, mx_t_time = "--:--", mn_t_time = "--:--", mx_w = 0, mx_w_t = "--:--", mx_g = 0, mx_g_t = "--:--", mx_r = 0, mx_r_t = "--:--", pTrend = 0, tRate = 0, hTrend = 0, graphHistory = [];

        if (historyRes.rows.length > 0) {
            const lastRow = historyRes.rows[historyRes.rows.length - 1];
            pTrend = parseFloat((livePress - (lastRow.press_rel || livePress)).toFixed(1));
            const baseTempF = oneHourRes.rows[0]?.temp_f || historyRes.rows[0].temp_f;
            tRate = parseFloat((liveTemp - ((baseTempF - 32) * 5/9)).toFixed(1));
            hTrend = liveHum - (oneHourRes.rows[0]?.humidity || historyRes.rows[0].humidity);

            historyRes.rows.forEach(r => {
                const fTime = (iso) => iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }) : "--:--";
                const r_temp = parseFloat(((r.temp_f - 32) * 5 / 9).toFixed(1));
                const r_min_temp = parseFloat(((r.temp_min_f - 32) * 5 / 9).toFixed(1));
                const r_wind = parseFloat((r.wind_speed_mph * 1.60934).toFixed(1));
                const r_gust = parseFloat((r.wind_gust_mph * 1.60934).toFixed(1));
                const r_rain_rate = parseFloat((r.rain_rate_in * 25.4).toFixed(1));

                if (r_temp > mx_t) { mx_t = r_temp; mx_t_time = fTime(r.max_t_time); }
                if (r_min_temp < mn_t || mn_t === 999) { mn_t = r_min_temp; mn_t_time = fTime(r.min_t_time); }
                if (r_wind > mx_w) { mx_w = r_wind; mx_w_t = fTime(r.max_w_time); }
                if (r_gust > mx_g) { mx_g = r_gust; mx_g_t = fTime(r.max_g_time); }
                if (r_rain_rate > mx_r) { mx_r = r_rain_rate; mx_r_t = fTime(r.max_r_time); }
                graphHistory.push({ time: r.time, temp: r_temp, hum: r.humidity, wind: r_wind, rain: parseFloat((r.daily_rain_in * 25.4).toFixed(1)) });
            });
        }

        state.cachedData = {
            temp: { current: liveTemp, dew: parseFloat(((d.outdoor.dew_point.value - 32) * 5 / 9).toFixed(1)), max: mx_t, maxTime: mx_t_time, min: mn_t, minTime: mn_t_time, realFeel: calculateRealFeel(liveTemp, liveHum), rate: tRate },
            atmo: { hum: liveHum, hTrend: hTrend, press: livePress, pTrend, sol: d.solar_and_uvi?.solar?.value || 0, uv: d.solar_and_uvi?.uvi?.value || 0 },
            wind: { speed: parseFloat((liveWindMph * 1.60934).toFixed(1)), gust: parseFloat((liveGustMph * 1.60934).toFixed(1)), maxS: mx_w, maxSTime: mx_w_t, maxG: mx_g, maxGTime: mx_g_t, deg: d.wind.wind_direction.value, card: getCard(d.wind.wind_direction.value) },
            rain: { total: parseFloat((rawDailyIn * 25.4).toFixed(1)), weekly: parseFloat((d.rainfall.weekly.value * 25.4).toFixed(1)), monthly: parseFloat((d.rainfall.monthly.value * 25.4).toFixed(1)), yearly: parseFloat((d.rainfall.yearly.value * 25.4).toFixed(1)), rate: parseFloat((customRateIn * 25.4).toFixed(1)), maxR: mx_r, maxRTime: mx_r_t },
            history: graphHistory,
            lastSync: new Date().toISOString()
        };
        state.lastFetchTime = now;
        return state.cachedData;
    } catch (e) { return { error: e.message }; }
}

app.get("/weather", async (req, res) => res.json(await syncWithEcowitt(false)));
app.get("/api/sync", async (req, res) => res.json(await syncWithEcowitt(req.query.write === 'true')));
app.get("/api/summary", async (req, res) => {
    const { month, year } = req.query;
    try {
        const result = await pool.query(`SELECT record_date, max_temp_c, min_temp_c, max_wind_kmh, total_rain_mm FROM daily_max_records WHERE EXTRACT(MONTH FROM record_date) = $1 AND EXTRACT(YEAR FROM record_date) = $2 ORDER BY record_date DESC`, [month, year]);
        res.json(result.rows);
    } catch (e) { res.status(500).json({ error: "Failed to fetch archive" }); }
});

app.get("/", (req, res) => {
    // THIS IS THE 500+ LINES OF HTML/CSS/FRONTEND SCRIPTING
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
        body { margin: 0; font-family: 'Outfit', sans-serif; background: var(--bg); color: var(--text); padding: 20px 16px 120px 16px; transition: background 0.5s ease; min-height: 100vh; overflow-x: hidden; }
        .container { width: 100%; max-width: 1200px; margin: 0 auto; }
        .header { margin-bottom: 32px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px; }
        .status-bar { display: flex; align-items: center; gap: 8px; background: var(--card); padding: 6px 16px; border-radius: 100px; border: 1px solid var(--border); box-shadow: var(--glow); font-size: 13px; }
        .live-dot { width: 6px; height: 6px; background: #10b981; border-radius: 50%; animation: blink 2s infinite; }
        @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        .grid-system { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
        .card { background: var(--card); padding: 28px; border-radius: 32px; border: 1px solid var(--border); backdrop-filter: blur(20px); box-shadow: var(--glow); position: relative; overflow: hidden; transition: background 0.5s ease; }
        .label { color: var(--accent); font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 6px; }
        .main-val { font-size: 56px; font-weight: 900; margin: 0; letter-spacing: -2px; display: flex; align-items: baseline; line-height: 1.1; }
        .unit { font-size: 20px; font-weight: 600; color: var(--muted); margin-left: 4px; }
        .sub-pill { font-size: 12px; font-weight: 800; padding: 6px 12px; border-radius: 10px; background: var(--badge); display: inline-flex; align-items: center; gap: 4px; margin: 12px 0 20px 0; }
        .sub-box-4 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding-top: 20px; border-top: 1px solid var(--border); }
        .badge { padding: 12px; border-radius: 18px; background: var(--badge); display: flex; flex-direction: column; gap: 2px; }
        .badge-label { font-size: 9px; color: var(--muted); text-transform: uppercase; font-weight: 800; }
        .badge-val { font-size: 16px; font-weight: 800; }
        .theme-toggle { background: var(--card); border: 1px solid var(--border); padding: 4px; border-radius: 12px; display: flex; gap: 4px; cursor: pointer; }
        .theme-btn { padding: 6px 10px; border-radius: 8px; font-size: 11px; font-weight: 700; color: var(--muted); }
        .theme-btn.active { background: var(--accent); color: white; }
        .graphs-wrapper { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-top: 20px; }
        .graph-card { background: var(--card); padding: 24px; border-radius: 32px; border: 1px solid var(--border); height: 320px; }
        #archive-view { display: none; margin-top: 20px; }
        .archive-table { width: 100%; border-collapse: collapse; background: var(--card); border-radius: 24px; overflow: hidden; }
        .archive-table th, .archive-table td { padding: 15px; text-align: left; border-bottom: 1px solid var(--border); }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>KK Nagar Weather Hub</h1>
            <div class="header-actions" style="display:flex; gap:10px; align-items:center;">
                <div class="status-bar"><div class="live-dot"></div><span id="ts">--:--:--</span></div>
                <div class="theme-toggle" id="themeToggle">
                    <div class="theme-btn" id="btn-light">LIGHT</div>
                    <div class="theme-btn" id="btn-dark">DARK</div>
                    <div class="theme-btn active" id="btn-auto">AUTO</div>
                </div>
            </div>
        </div>
        <div class="grid-system">
            <div class="card">
                <div class="label">Temperature</div>
                <div class="main-val"><span id="t">0.0</span><span class="unit">°C</span></div>
                <div id="tTrendBox" class="sub-pill">--</div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Today High</span><span id="mx" class="badge-val" style="color:#ef4444">--</span></div>
                    <div class="badge"><span class="badge-label">Today Low</span><span id="mn" class="badge-val" style="color:#0ea5e9">--</span></div>
                    <div class="badge"><span class="badge-label">Humidity</span><span id="h_val" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Feels Like</span><span id="rf" class="badge-val">--</span></div>
                </div>
            </div>
            <div class="card">
                <div class="label">Wind Dynamics</div>
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
                    <div class="badge"><span class="badge-label">Weekly</span><span id="r_week" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Monthly</span><span id="r_month" class="badge-val">--</span></div>
                </div>
            </div>
        </div>
        <div class="graphs-wrapper">
            <div class="graph-card"><canvas id="cT"></canvas></div>
            <div class="graph-card"><canvas id="cH"></canvas></div>
        </div>
    </div>
    <script>
        let charts = {};
        async function update() {
            try {
                const res = await fetch('/weather');
                const d = await res.json();
                if(d.error) return;
                document.getElementById('t').innerText = d.temp.current;
                document.getElementById('mx').innerText = d.temp.max + '°C';
                document.getElementById('mn').innerText = d.temp.min + '°C';
                document.getElementById('w').innerText = d.wind.speed;
                document.getElementById('r_tot').innerText = d.rain.total;
                document.getElementById('ts').innerText = new Date(d.lastSync).toLocaleTimeString();
                
                const labels = d.history.map(h => new Date(h.time).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}));
                if(!charts.cT) {
                    charts.cT = new Chart(document.getElementById('cT'), { type: 'line', data: { labels, datasets: [{label: 'Temp', data: d.history.map(h => h.temp), borderColor: '#ef4444'}] } });
                    charts.cH = new Chart(document.getElementById('cH'), { type: 'line', data: { labels, datasets: [{label: 'Hum', data: d.history.map(h => h.hum), borderColor: '#10b981'}] } });
                } else {
                    charts.cT.data.labels = labels; charts.cT.data.datasets[0].data = d.history.map(h => h.temp); charts.cT.update();
                    charts.cH.data.labels = labels; charts.cH.data.datasets[0].data = d.history.map(h => h.hum); charts.cH.update();
                }
            } catch(e) {}
        }
        setInterval(update, 45000); update();
        // Theme Toggle Logic
        document.getElementById('btn-dark').onclick = () => { document.body.classList.add('is-night'); };
        document.getElementById('btn-light').onclick = () => { document.body.classList.remove('is-night'); };
    </script>
</body>
</html>
    `);
});

if (process.env.NODE_ENV !== 'production') {
    app.listen(3000, () => console.log(`Running at http://localhost:3000`));
}

module.exports = app;
