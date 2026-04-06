const express = require("express");
const fetch = require("node-fetch");
const { Pool } = require('pg');
const app = express();

/**
 * DATABASE CONFIGURATION
 * Using connection pooling for high-frequency writes and history lookups.
 */
const pool = new Pool({
    connectionString: process.env.POSTGRES_URL + "?sslmode=require",
    ssl: { rejectUnauthorized: false }
});

const APPLICATION_KEY = process.env.APPLICATION_KEY;
const API_KEY = process.env.API_KEY;
const MAC = process.env.MAC;

/**
 * GLOBAL STATE ENGINE
 * Manages caching to prevent API rate limiting and buffers peaks
 * between database write intervals (e.g., catching a gust between 5-minute writes).
 */
let state = { 
    cachedData: null, 
    lastFetchTime: 0, 
    lastDbWrite: 0,
    lastRainTotal: null, 
    // Buffers for internal interval tracking
    bufW: 0, 
    bufG: 0, 
    bufMaxT: -999, 
    bufMinT: 999, 
    bufRR: 0,
    // Exact ISO strings for when peaks occurred
    tW: null, 
    tG: null, 
    tMaxT: null, 
    tMinT: null, 
    tRR: null 
};

/**
 * RESET LOGIC
 * Clears memory buffers after a successful DB commit to prevent "ghost" peaks 
 * from bleeding into the next interval.
 */
function resetStateBuffers() {
    state.bufW = 0; 
    state.bufG = 0; 
    state.bufMaxT = -999; 
    state.bufMinT = 999; 
    state.bufRR = 0;
    state.tW = null; 
    state.tG = null; 
    state.tMaxT = null; 
    state.tMinT = null; 
    state.tRR = null;
}

const getCard = (a) => {
    const directions = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
    return directions[Math.round(a / 22.5) % 16];
};

/**
 * NOAA HEAT INDEX CALCULATION
 * Converts C to F, applies the Rothfusz regression, then back to C.
 */
function calculateRealFeel(tempC, humidity) {
    const T = (tempC * 9/5) + 32;
    const R = humidity;
    let hi = 0.5 * (T + 61.0 + ((T - 68.0) * 1.2) + (R * 0.094));
    
    if (hi > 79) {
        hi = -42.379 + 2.04901523 * T + 10.14333127 * R - 0.22475541 * T * R - 0.00683783 * T * T - 0.05481717 * R * R + 0.00122874 * T * T * R + 0.00085282 * T * R * R - 0.00000199 * T * T * R * R;
        if (R < 13 && T >= 80 && T <= 112) hi -= ((13 - R) / 4) * Math.sqrt((17 - Math.abs(T - 95)) / 17);
        else if (R > 85 && T >= 80 && T <= 87) hi += ((R - 85) / 10) * ((87 - T) / 5);
    }
    return parseFloat(((hi - 32) * 5 / 9).toFixed(1));
}

/**
 * CORE SYNC LOGIC
 * Handles Ecowitt API fetching, Unit Conversion, State Buffering, 
 * Daily Archiving, and History Retrieval.
 */
async function syncWithEcowitt(forceWrite = false, isSyncCall = false) {
    const now = Date.now();
    const currentTimeStamp = new Date().toISOString();

    // Cache management: 35s throttle unless Cron/Write is triggered
    if (!forceWrite && !isSyncCall && state.cachedData && (now - state.lastFetchTime < 35000)) {
        return state.cachedData;
    }

    try {
        const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}`;
        const response = await fetch(url);
        const json = await response.json();
        
        if (!json.data) throw new Error("Invalid API Response");
        const d = json.data;

        // Metric Conversions
        const liveTemp = parseFloat(((d.outdoor.temperature.value - 32) * 5 / 9).toFixed(1));
        const liveDew = parseFloat(((d.outdoor.dew_point.value - 32) * 5 / 9).toFixed(1));
        const liveHum = d.outdoor.humidity.value || 0;
        const livePress = parseFloat((d.pressure.relative.value * 33.8639).toFixed(1));
        const liveWind = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));
        const liveGust = parseFloat((d.wind.wind_gust.value * 1.60934).toFixed(1));
        
        const liveRain24h = parseFloat((d.rainfall.daily.value * 25.4).toFixed(1));
        const liveRainWeekly = parseFloat((d.rainfall.weekly.value * 25.4).toFixed(1));
        const liveRainMonthly = parseFloat((d.rainfall.monthly.value * 25.4).toFixed(1));
        const liveRainYearly = parseFloat((d.rainfall.yearly.value * 25.4).toFixed(1));

        // Instantaneous Rain Rate (Davis Method)
        const currentDailyRainRaw = d.rainfall.daily.value;
        let calculatedRainRateInPerHour = 0;
        if (state.lastRainTotal !== null && now > state.lastFetchTime) {
            const rainDelta = Math.max(0, currentDailyRainRaw - state.lastRainTotal);
            const timeDeltaHours = (now - state.lastFetchTime) / 3600000;
            if (timeDeltaHours > 0) calculatedRainRateInPerHour = rainDelta / timeDeltaHours;
        }
        state.lastRainTotal = currentDailyRainRaw;
        const liveRainRate = parseFloat((calculatedRainRateInPerHour * 25.4).toFixed(1));

        // Update State Buffers for Peaks
        if (d.wind.wind_speed.value >= state.bufW) { state.bufW = d.wind.wind_speed.value; state.tW = currentTimeStamp; }
        if (d.wind.wind_gust.value >= state.bufG) { state.bufG = d.wind.wind_gust.value; state.tG = currentTimeStamp; }
        if (d.outdoor.temperature.value >= state.bufMaxT) { state.bufMaxT = d.outdoor.temperature.value; state.tMaxT = currentTimeStamp; }
        if (d.outdoor.temperature.value <= state.bufMinT) { state.bufMinT = d.outdoor.temperature.value; state.tMinT = currentTimeStamp; }
        if (calculatedRainRateInPerHour >= state.bufRR) { state.bufRR = calculatedRainRateInPerHour; state.tRR = currentTimeStamp; }

        /**
         * DAILY ARCHIVING & CLEANUP
         * Moves yesterday's data to long-term storage and purges the buffer table.
         */
        const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        const dateCheck = await pool.query(`SELECT (time AT TIME ZONE 'Asia/Kolkata')::date as record_date FROM weather_history ORDER BY time ASC LIMIT 1`);
        
        if (dateCheck.rows.length > 0) {
            const oldestDate = new Date(dateCheck.rows[0].record_date).toLocaleDateString('en-CA');
            if (oldestDate !== todayIST) {
                await pool.query(`
                    INSERT INTO daily_max_records (record_date, max_temp_c, min_temp_c, max_wind_kmh, max_gust_kmh, total_rain_mm) 
                    SELECT $1, MAX((temp_f - 32) * 5/9), MIN((temp_min_f - 32) * 5/9), MAX(wind_speed_mph * 1.60934), MAX(wind_gust_mph * 1.60934), MAX(daily_rain_in * 25.4) 
                    FROM weather_history WHERE (time AT TIME ZONE 'Asia/Kolkata')::date = $1::date;`, [oldestDate]);
                await pool.query(`DELETE FROM weather_history WHERE (time AT TIME ZONE 'Asia/Kolkata')::date < (NOW() AT TIME ZONE 'Asia/Kolkata')::date;`);
            }
        }

        /**
         * DATABASE WRITE
         * Commits the buffered peaks and current atmospheric state.
         */
        if (forceWrite) {
            try {
                await pool.query(`
                    INSERT INTO weather_history 
                    (time, temp_f, humidity, wind_speed_mph, wind_gust_mph, daily_rain_in, solar_radiation, press_rel, rain_rate_in, temp_min_f, max_t_time, min_t_time, max_w_time, max_g_time, max_r_time) 
                    VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`, 
                    [state.bufMaxT, liveHum, state.bufW, state.bufG, d.rainfall.daily.value, d.solar_and_uvi?.solar?.value || 0, livePress, state.bufRR, state.bufMinT, state.tMaxT, state.tMinT, state.tW, state.tG, state.tRR]);
                resetStateBuffers();
                state.lastDbWrite = now;
            } catch (err) { 
                console.error("Critical DB Error:", err.message); 
            }
        }

        // History Processing
        const historyRes = await pool.query(`SELECT * FROM weather_history WHERE (time AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date ORDER BY time ASC`);
        const oneHourAgoRes = await pool.query(`SELECT temp_f, humidity FROM weather_history WHERE time >= NOW() - INTERVAL '1 hour' ORDER BY time ASC LIMIT 1`);
        
        let mx_t = -999, mn_t = 999, mx_t_time = "--:--", mn_t_time = "--:--", mx_w = 0, mx_w_t = "--:--", mx_g = 0, mx_g_t = "--:--", mx_r = 0, mx_r_t = "--:--", graphHistory = [];

        if (historyRes.rows.length > 0) {
            historyRes.rows.forEach(r => {
                const formatTime = (iso) => iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }) : "--:--";
                const r_temp = parseFloat(((r.temp_f - 32) * 5 / 9).toFixed(1));
                const r_min_temp = parseFloat(((r.temp_min_f - 32) * 5 / 9).toFixed(1));
                const r_wind = parseFloat((r.wind_speed_mph * 1.60934).toFixed(1));
                const r_gust = parseFloat((r.wind_gust_mph * 1.60934).toFixed(1));
                const r_rain_rate = parseFloat((r.rain_rate_in * 25.4).toFixed(1));

                if (r_temp > mx_t) { mx_t = r_temp; mx_t_time = formatTime(r.max_t_time); }
                if (r_min_temp < mn_t || mn_t === 999) { mn_t = r_min_temp; mn_t_time = formatTime(r.min_t_time); }
                if (r_wind > mx_w) { mx_w = r_wind; mx_w_t = formatTime(r.max_w_time); }
                if (r_gust > mx_g) { mx_g = r_gust; mx_g_t = formatTime(r.max_g_time); }
                if (r_rain_rate > mx_r) { mx_r = r_rain_rate; mx_r_t = formatTime(r.max_r_time); }
                
                graphHistory.push({ time: r.time, temp: r_temp, hum: r.humidity, wind: r_wind, rain: parseFloat((r.daily_rain_in * 25.4).toFixed(1)) });
            });
        }

        // Logic to merge current live data with DB records for the dashboard
        const liveTime = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
        if (liveTemp > mx_t) { mx_t = liveTemp; mx_t_time = liveTime; }
        if (liveTemp < mn_t || mn_t === 999) { mn_t = liveTemp; mn_t_time = liveTime; }

        state.cachedData = {
            temp: { current: liveTemp, dew: liveDew, max: mx_t, maxTime: mx_t_time, min: mn_t, minTime: mn_t_time, realFeel: calculateRealFeel(liveTemp, liveHum) },
            atmo: { hum: liveHum, press: livePress, sol: d.solar_and_uvi?.solar?.value || 0, uv: d.solar_and_uvi?.uvi?.value || 0 },
            wind: { speed: liveWind, gust: liveGust, maxS: mx_w, maxSTime: mx_w_t, maxG: mx_g, maxGTime: mx_g_t, deg: d.wind.wind_direction.value, card: getCard(d.wind.wind_direction.value) },
            rain: { total: liveRain24h, weekly: liveRainWeekly, monthly: liveRainMonthly, yearly: liveRainYearly, rate: liveRainRate, maxR: mx_r, maxRTime: mx_r_t },
            history: graphHistory,
            lastSync: new Date().toISOString()
        };
        state.lastFetchTime = now;
        return state.cachedData;
    } catch (e) { return { error: e.message }; }
}

/**
 * ROUTES
 */
app.get("/weather", async (req, res) => res.json(await syncWithEcowitt(false, false)));
app.get("/api/sync", async (req, res) => res.json(await syncWithEcowitt(req.query.write === 'true', true)));

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
            --bg: #f0f9ff; 
            --card: rgba(255, 255, 255, 0.9); 
            --border: rgba(2, 132, 199, 0.1);
            --text: #0f172a; 
            --muted: #64748b; 
            --accent: #0284c7; 
            --glow: 0 20px 50px -12px rgba(2, 132, 199, 0.1);
            --badge: rgba(2, 132, 199, 0.05);
        }

        body.is-night {
            --bg: #020617; 
            --card: rgba(15, 23, 42, 0.8); 
            --border: rgba(255, 255, 255, 0.08);
            --text: #f1f5f9; 
            --muted: #94a3b8; 
            --accent: #38bdf8; 
            --glow: 0 20px 50px -12px rgba(0,0,0,0.5);
            --badge: rgba(255, 255, 255, 0.03);
        }

        body { 
            margin: 0; font-family: 'Outfit', sans-serif; background: var(--bg); color: var(--text); 
            padding: 20px; transition: background 0.6s cubic-bezier(0.4, 0, 0.2, 1); 
            min-height: 100vh;
        }

        .container { max-width: 1300px; margin: 0 auto; }
        
        /* HEADER STYLES */
        .header { margin-bottom: 40px; display: flex; justify-content: space-between; align-items: center; }
        .header h1 { font-size: 32px; font-weight: 900; margin: 0; letter-spacing: -1.5px; }
        
        .status-pill { 
            background: var(--card); padding: 8px 20px; border-radius: 100px; border: 1px solid var(--border);
            display: flex; align-items: center; gap: 10px; font-size: 14px; box-shadow: var(--glow);
        }
        .dot { width: 8px; height: 8px; background: #10b981; border-radius: 50%; animation: pulse 2s infinite; }
        @keyframes pulse { 0% { transform: scale(0.95); opacity: 1; } 50% { transform: scale(1.2); opacity: 0.5; } 100% { transform: scale(0.95); opacity: 1; } }

        /* GRID & CARDS */
        .dashboard-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 24px; }
        
        .card { 
            background: var(--card); padding: 32px; border-radius: 40px; border: 1px solid var(--border); 
            backdrop-filter: blur(20px); box-shadow: var(--glow); position: relative; overflow: hidden;
            transition: transform 0.3s ease;
        }
        .card:hover { transform: translateY(-5px); }

        .label { color: var(--accent); font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 8px; }
        .value { font-size: 64px; font-weight: 900; letter-spacing: -3px; display: flex; align-items: baseline; }
        .unit { font-size: 24px; color: var(--muted); margin-left: 6px; font-weight: 500; letter-spacing: 0; }

        .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 24px; border-top: 1px solid var(--border); padding-top: 24px; }
        .stat-item { background: var(--badge); padding: 16px; border-radius: 24px; display: flex; flex-direction: column; }
        .stat-label { font-size: 10px; color: var(--muted); text-transform: uppercase; font-weight: 800; margin-bottom: 4px; }
        .stat-val { font-size: 18px; font-weight: 700; }
        .time-label { font-size: 10px; color: var(--muted); opacity: 0.6; }

        /* WIND CANVAS */
        #windCanvas { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; opacity: 0.6; }

        /* COMPASS */
        .compass { width: 60px; height: 60px; border: 2px solid var(--border); border-radius: 50%; position: absolute; top: 32px; right: 32px; display: flex; align-items: center; justify-content: center; }
        #needle { width: 4px; height: 35px; background: linear-gradient(to bottom, #ef4444 50%, #64748b 50%); clip-path: polygon(50% 0%, 100% 100%, 50% 85%, 0% 100%); transition: transform 1.5s cubic-bezier(0.1, 0.9, 0.2, 1); }

        /* GRAPHS */
        .graphs-section { display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 24px; margin-top: 24px; }
        .graph-card { background: var(--card); padding: 32px; border-radius: 40px; border: 1px solid var(--border); height: 350px; }

        /* THEME TOGGLE */
        .theme-switcher { display: flex; gap: 8px; background: var(--card); padding: 6px; border-radius: 16px; border: 1px solid var(--border); }
        .t-btn { padding: 8px 16px; border-radius: 10px; font-size: 12px; font-weight: 700; cursor: pointer; transition: 0.3s; color: var(--muted); }
        .t-btn.active { background: var(--accent); color: white; }

        @media (max-width: 600px) {
            .value { font-size: 48px; }
            .graph-card { height: 280px; }
        }
    </style>
</head>
<body class="is-night">
    <div class="container">
        <div class="header">
            <div>
                <h1>KK Nagar Weather</h1>
                <div class="status-pill" style="margin-top:10px">
                    <div class="dot"></div>
                    <span id="ts">Loading Hub...</span>
                </div>
            </div>
            <div class="theme-switcher">
                <div class="t-btn" id="t-light">Light</div>
                <div class="t-btn" id="t-dark">Dark</div>
                <div class="t-btn active" id="t-auto">Auto</div>
            </div>
        </div>

        <div class="dashboard-grid">
            <div class="card">
                <div class="label">Atmosphere</div>
                <div class="value"><span id="temp">--</span><span class="unit">°C</span></div>
                <div class="stats-grid">
                    <div class="stat-item"><span class="stat-label">Day High</span><span id="mx-t" class="stat-val" style="color:#ef4444">--</span><span id="mx-t-tm" class="time-label">--</span></div>
                    <div class="stat-item"><span class="stat-label">Day Low</span><span id="mn-t" class="stat-val" style="color:#38bdf8">--</span><span id="mn-t-tm" class="time-label">--</span></div>
                    <div class="stat-item"><span class="stat-label">Humidity</span><span id="hum" class="stat-val">--</span></div>
                    <div class="stat-item"><span class="stat-label">Feels Like</span><span id="rf" class="stat-val">--</span></div>
                </div>
            </div>

            <div class="card">
                <canvas id="windCanvas"></canvas>
                <div class="label">Wind Flow</div>
                <div class="compass"><div id="needle"></div></div>
                <div class="value"><span id="wind">--</span><span id="wind-dir" class="unit" style="font-size:18px">--</span><span class="unit">km/h</span></div>
                <div class="stats-grid">
                    <div class="stat-item"><span class="stat-label">Peak Wind</span><span id="mx-w" class="stat-val">--</span><span id="mx-w-tm" class="time-label">--</span></div>
                    <div class="stat-item"><span class="stat-label">Peak Gust</span><span id="mx-g" class="stat-val">--</span><span id="mx-g-tm" class="time-label">--</span></div>
                </div>
            </div>

            <div class="card">
                <div class="label">Precipitation</div>
                <div class="value"><span id="rain">--</span><span class="unit">mm</span></div>
                <div class="stats-grid">
                    <div class="stat-item"><span class="stat-label">Rain Rate</span><span id="r-rate" class="stat-val">--</span><span class="time-label">mm/h</span></div>
                    <div class="stat-item"><span class="stat-label">Max Rate</span><span id="mx-r" class="stat-val">--</span><span id="mx-r-tm" class="time-label">--</span></div>
                    <div class="stat-item"><span class="stat-label">This Week</span><span id="r-wk" class="stat-val">--</span></div>
                    <div class="stat-item"><span class="stat-label">This Month</span><span id="r-mo" class="stat-val">--</span></div>
                </div>
            </div>
        </div>

        <div class="graphs-section">
            <div class="graph-card"><canvas id="chart-temp"></canvas></div>
            <div class="graph-card"><canvas id="chart-wind"></canvas></div>
            <div class="graph-card"><canvas id="chart-hum"></canvas></div>
            <div class="graph-card"><canvas id="chart-rain"></canvas></div>
        </div>
    </div>

    <script>
        /**
         * CLIENT-SIDE ENGINE
         */
        let currentTheme = localStorage.getItem('theme') || 'auto';
        let charts = {};
        let particles = [];
        let windSpeed = 0, windDeg = 0;

        const wCanvas = document.getElementById('windCanvas');
        const ctxW = wCanvas.getContext('2d');

        // Particle Initialization
        for(let i=0; i<40; i++) {
            particles.push({
                x: Math.random() * 500,
                y: Math.random() * 500,
                s: 0.5 + Math.random(),
                o: 0.1 + Math.random() * 0.5
            });
        }

        /**
         * CUSTOM CHART.JS PLUGIN
         * Draws the MAX highlight circle and text label.
         */
        const maxHighlightPlugin = {
            id: 'maxHighlight',
            afterDatasetsDraw: (chart) => {
                const {ctx, data} = chart;
                const dataset = data.datasets[0];
                if (!dataset || !dataset.data.length) return;

                const max = Math.max(...dataset.data);
                const index = dataset.data.lastIndexOf(max);
                const meta = chart.getDatasetMeta(0);
                const point = meta.data[index];

                if (point && max > -100) {
                    ctx.save();
                    ctx.beginPath();
                    ctx.arc(point.x, point.y, 6, 0, 2 * Math.PI);
                    ctx.strokeStyle = dataset.borderColor;
                    ctx.lineWidth = 3;
                    ctx.stroke();
                    ctx.fillStyle = document.body.classList.contains('is-night') ? '#fff' : '#000';
                    ctx.font = 'bold 11px Outfit';
                    ctx.textAlign = 'center';
                    ctx.fillText('MAX', point.x, point.y - 15);
                    ctx.restore();
                }
            }
        };
        Chart.register(maxHighlightPlugin);

        function setupChart(id, label, color) {
            const ctx = document.getElementById(id).getContext('2d');
            const grad = ctx.createLinearGradient(0, 0, 0, 400);
            grad.addColorStop(0, color + '44');
            grad.addColorStop(1, color + '00');

            return new Chart(ctx, {
                type: 'line',
                data: { labels: [], datasets: [{ label: label, data: [], borderColor: color, backgroundColor: grad, fill: true, tension: 0.4, pointRadius: 0, borderWidth: 3 }] },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { font: { family: 'Outfit', size: 10 } } },
                        x: { grid: { display: false }, ticks: { font: { family: 'Outfit', size: 10 }, maxTicksLimit: 6 } }
                    }
                }
            });
        }

        async function refresh() {
            try {
                const res = await fetch('/weather');
                const d = await res.json();
                
                document.getElementById('temp').innerText = d.temp.current;
                document.getElementById('mx-t').innerText = d.temp.max + '°';
                document.getElementById('mn-t').innerText = d.temp.min + '°';
                document.getElementById('mx-t-tm').innerText = d.temp.maxTime;
                document.getElementById('mn-t-tm').innerText = d.temp.minTime;
                document.getElementById('hum').innerText = d.atmo.hum + '%';
                document.getElementById('rf').innerText = d.temp.realFeel + '°';
                
                document.getElementById('wind').innerText = d.wind.speed;
                document.getElementById('wind-dir').innerText = d.wind.card;
                document.getElementById('mx-w').innerText = d.wind.maxS + ' km/h';
                document.getElementById('mx-g').innerText = d.wind.maxG + ' km/h';
                document.getElementById('mx-w-tm').innerText = d.wind.maxSTime;
                document.getElementById('mx-g-tm').innerText = d.wind.maxGTime;
                document.getElementById('needle').style.transform = 'rotate('+d.wind.deg+'deg)';
                
                windSpeed = d.wind.speed;
                windDeg = d.wind.deg;

                document.getElementById('rain').innerText = d.rain.total;
                document.getElementById('r-rate').innerText = d.rain.rate;
                document.getElementById('mx-r').innerText = d.rain.maxR + ' mm/h';
                document.getElementById('mx-r-tm').innerText = d.rain.maxRTime;
                document.getElementById('r-wk').innerText = d.rain.weekly + ' mm';
                document.getElementById('r-mo').innerText = d.rain.monthly + ' mm';

                document.getElementById('ts').innerText = 'Last Updated: ' + new Date(d.lastSync).toLocaleTimeString();

                // Charts
                const labels = d.history.map(h => new Date(h.time).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', hour12:false}));
                if (!charts.temp) {
                    charts.temp = setupChart('chart-temp', 'Temp', '#ef4444');
                    charts.wind = setupChart('chart-wind', 'Wind', '#f59e0b');
                    charts.hum = setupChart('chart-hum', 'Humidity', '#10b981');
                    charts.rain = setupChart('chart-rain', 'Rain', '#38bdf8');
                }
                charts.temp.data.labels = labels; charts.temp.data.datasets[0].data = d.history.map(h => h.temp); charts.temp.update();
                charts.wind.data.labels = labels; charts.wind.data.datasets[0].data = d.history.map(h => h.wind); charts.wind.update();
                charts.hum.data.labels = labels; charts.hum.data.datasets[0].data = d.history.map(h => h.hum); charts.hum.update();
                charts.rain.data.labels = labels; charts.rain.data.datasets[0].data = d.history.map(h => h.rain); charts.rain.update();

            } catch (e) { console.error(e); }
        }

        function drawWind() {
            wCanvas.width = wCanvas.offsetWidth;
            wCanvas.height = wCanvas.offsetHeight;
            ctxW.clearRect(0, 0, wCanvas.width, wCanvas.height);
            
            const rad = (windDeg - 90) * (Math.PI / 180);
            const speed = Math.max(0.2, windSpeed * 0.1);
            const dx = -Math.cos(rad) * speed;
            const dy = -Math.sin(rad) * speed;

            ctxW.strokeStyle = document.body.classList.contains('is-night') ? 'rgba(255,255,255,0.1)' : 'rgba(2,132,199,0.1)';
            ctxW.lineWidth = 2;
            ctxW.lineCap = 'round';
            ctxW.beginPath();

            particles.forEach(p => {
                p.x += dx * p.s; p.y += dy * p.s;
                if(p.x > wCanvas.width) p.x = 0; if(p.x < 0) p.x = wCanvas.width;
                if(p.y > wCanvas.height) p.y = 0; if(p.y < 0) p.y = wCanvas.height;
                ctxW.moveTo(p.x, p.y);
                ctxW.lineTo(p.x - dx*10, p.y - dy*10);
            });
            ctxW.stroke();
            requestAnimationFrame(drawWind);
        }

        function toggleTheme(mode) {
            currentTheme = mode;
            localStorage.setItem('theme', mode);
            const hour = new Date().getHours();
            const isDark = mode === 'dark' || (mode === 'auto' && (hour >= 18 || hour < 6));
            document.body.className = isDark ? 'is-night' : '';
            document.querySelectorAll('.t-btn').forEach(b => b.classList.remove('active'));
            document.getElementById('t-'+mode).classList.add('active');
        }

        document.getElementById('t-light').onclick = () => toggleTheme('light');
        document.getElementById('t-dark').onclick = () => toggleTheme('dark');
        document.getElementById('t-auto').onclick = () => toggleTheme('auto');

        toggleTheme(currentTheme);
        drawWind();
        refresh();
        setInterval(refresh, 40000);
    </script>
</body>
</html>
    `);
});

app.listen(3000);
module.exports = app;
