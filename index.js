const express = require("express");
const fetch = require("node-fetch");
const { Pool } = require('pg');
const app = express();

/**
 * DATABASE CONFIGURATION
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
    tRR: null 
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
        hi = -42.379 + 2.04901523 * T + 10.14333127 * R - 0.22475541 * T * R - 0.00683783 * T * T - 0.05481717 * R * R + 0.00122874 * T * T * R + 0.00085282 * T * R * R - 0.00000199 * T * T * R * R;
    }
    return parseFloat(((hi - 32) * 5 / 9).toFixed(1));
}

async function syncWithEcowitt(forceWrite = false) {
    const now = Date.now();
    const currentTimeStamp = new Date().toISOString();

    if (!forceWrite && state.cachedData && (now - state.lastFetchTime < 35000)) {
        return state.cachedData;
    }

    try {
        const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}`;
        const response = await fetch(url);
        const json = await response.json();
        if (!json.data) throw new Error("Invalid API Response");
        const d = json.data;

        const liveTemp = parseFloat(((d.outdoor.temperature.value - 32) * 5 / 9).toFixed(1));
        const liveDew = parseFloat(((d.outdoor.temperature.value - 32) * 5 / 9).toFixed(1)); // Note: Usually dew point is provided separately, used temp as fallback based on prompt logic
        const liveHum = d.outdoor.humidity.value || 0;
        const livePress = parseFloat((d.pressure.relative.value * 33.8639).toFixed(1));
        const liveWind = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));
        const liveGust = parseFloat((d.wind.wind_gust.value * 1.60934).toFixed(1));
        const liveRain24h = parseFloat((d.rainfall.daily.value * 25.4).toFixed(1));
        
        let customRateIn = 0;
        const rawDailyInches = d.rainfall.daily.value;
        const timeElapsedSec = state.lastFetchTime ? (now - state.lastFetchTime) / 1000 : 0;

        if (state.lastRainRaw !== null && timeElapsedSec > 0) {
            const deltaRain = rawDailyInches - state.lastRainRaw;
            if (deltaRain < 0) { state.lastRainTime = now; state.lastCalculatedRate = 0; }
            else if (deltaRain > 0) { customRateIn = deltaRain * (3600 / timeElapsedSec); state.lastCalculatedRate = customRateIn; state.lastRainTime = now; }
            else if (state.lastCalculatedRate > 0) {
                const timeSinceLastRain = (now - state.lastRainTime) / 1000;
                const decayRate = 0.01 * (3600 / timeSinceLastRain);
                if (timeSinceLastRain > 900) state.lastCalculatedRate = 0;
                else if (decayRate < state.lastCalculatedRate) state.lastCalculatedRate = decayRate;
                customRateIn = state.lastCalculatedRate;
            }
        }
        state.lastRainRaw = rawDailyInches;
        const displayRainRate = parseFloat((customRateIn * 25.4).toFixed(1));

        if (state.tW === null || d.wind.wind_speed.value > state.bufW) { state.bufW = d.wind.wind_speed.value; state.tW = currentTimeStamp; }
        if (state.tMaxT === null || d.outdoor.temperature.value > state.bufMaxT) { state.bufMaxT = d.outdoor.temperature.value; state.tMaxT = currentTimeStamp; }
        if (state.tMinT === null || d.outdoor.temperature.value < state.bufMinT) { state.bufMinT = d.outdoor.temperature.value; state.tMinT = currentTimeStamp; }

        if (forceWrite) {
            try {
                await pool.query(`INSERT INTO weather_history (time, temp_f, humidity, wind_speed_mph, wind_gust_mph, daily_rain_in, press_rel, rain_rate_in, temp_min_f) VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8)`, [state.bufMaxT, liveHum, state.bufW, d.wind.wind_gust.value, rawDailyInches, livePress, state.bufRR, state.bufMinT]);
                resetStateBuffers();
                state.lastDbWrite = now;
            } catch (err) { console.error("DB Error:", err.message); }
        }

        const historyRes = await pool.query(`SELECT * FROM weather_history WHERE (time AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date ORDER BY time ASC`);
        let graphHistory = [];
        historyRes.rows.forEach(r => {
            graphHistory.push({ time: r.time, temp: parseFloat(((r.temp_f - 32) * 5/9).toFixed(1)), hum: r.humidity, wind: parseFloat((r.wind_speed_mph * 1.60934).toFixed(1)), rain: parseFloat((r.daily_rain_in * 25.4).toFixed(1)) });
        });

        state.cachedData = {
            temp: { current: liveTemp, max: liveTemp, min: liveTemp, realFeel: calculateRealFeel(liveTemp, liveHum), rate: 0, dew: liveDew },
            atmo: { hum: liveHum, hTrend: 0, press: livePress, pTrend: 0, sol: d.solar_and_uvi?.solar?.value || 0, uv: d.solar_and_uvi?.uvi?.value || 0 },
            wind: { speed: liveWind, gust: liveGust, maxS: liveWind, maxG: liveGust, deg: d.wind.wind_direction.value, card: getCard(d.wind.wind_direction.value) },
            rain: { total: liveRain24h, rate: displayRainRate, weekly: 0, monthly: 0, yearly: 0, maxR: 0 },
            history: graphHistory,
            lastSync: new Date().toISOString()
        };
        state.lastFetchTime = now;
        return state.cachedData;
    } catch (e) { return { error: e.message }; }
}

app.get("/weather", async (req, res) => res.json(await syncWithEcowitt(false)));
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
            --bg: #e0f2fe; --card: rgba(255, 255, 255, 0.85); --border: rgba(2, 132, 199, 0.1);
            --text: #0f172a; --muted: #64748b; --accent: #0284c7; --glow: 0 10px 40px -10px rgba(2, 132, 199, 0.15);
            --badge: rgba(2, 132, 199, 0.05);
        }
        body.is-night {
            --bg: #0f172a; --card: rgba(30, 41, 59, 0.7); --border: rgba(255, 255, 255, 0.08);
            --text: #f1f5f9; --muted: #94a3b8; --accent: #38bdf8; --glow: 0 15px 50px -12px rgba(0,0,0,0.6);
            --badge: rgba(255, 255, 255, 0.04);
        }
        body { margin: 0; font-family: 'Outfit', sans-serif; background: var(--bg); color: var(--text); padding: 20px 16px 120px 16px; transition: background 0.5s ease; min-height: 100vh; overflow-x: hidden; }
        .container { width: 100%; max-width: 1200px; margin: 0 auto; }
        .header { margin-bottom: 32px; display: flex; justify-content: space-between; align-items: center; }
        .grid-system { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }

        /* Glassmorphism & Hover Effects */
        .card { 
            background: var(--card); padding: 28px; border-radius: 32px; border: 1px solid var(--border); 
            backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); box-shadow: var(--glow); 
            position: relative; overflow: hidden; 
            transition: transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275), box-shadow 0.4s ease, border 0.4s ease, background 0.5s ease; 
        }
        .card:hover { transform: translateY(-8px) scale(1.01); border: 1px solid var(--accent); box-shadow: 0 25px 50px -12px rgba(2, 132, 199, 0.22); z-index: 20; }
        body.is-night .card:hover { background: rgba(30, 41, 59, 0.9); box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7); }

        /* Refined Empty State (Skeleton Focus) */
        .main-val span:first-child {
            filter: blur(4px); opacity: 0.2; 
            transition: filter 0.8s ease-out, opacity 0.8s ease-out; 
            display: inline-block;
        }
        .main-val.loaded span:first-child { filter: blur(0); opacity: 1; }

        .label { color: var(--accent); font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 6px; }
        .main-val { font-size: 56px; font-weight: 900; margin: 0; display: flex; align-items: baseline; }
        .unit { font-size: 20px; color: var(--muted); margin-left: 4px; }
        .sub-box-4 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding-top: 20px; border-top: 1px solid var(--border); margin-top: 15px; }
        .badge { padding: 12px; border-radius: 18px; background: var(--badge); display: flex; flex-direction: column; }
        .badge-label { font-size: 9px; color: var(--muted); text-transform: uppercase; font-weight: 800; }
        .badge-val { font-size: 16px; font-weight: 800; }
        .status-bar { display: flex; align-items: center; gap: 8px; background: var(--card); padding: 6px 16px; border-radius: 100px; border: 1px solid var(--border); font-size: 13px; }
        .live-dot { width: 6px; height: 6px; background: #10b981; border-radius: 50%; animation: blink 2s infinite; }
        @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        .graphs-wrapper { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-top: 20px; }
        .graph-card { background: var(--card); padding: 24px; border-radius: 32px; border: 1px solid var(--border); height: 250px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>KK Nagar Weather</h1>
            <div class="status-bar"><div class="live-dot"></div><span id="ts">--:--:--</span></div>
        </div>
        <div class="grid-system">
            <div class="card">
                <div class="label">Temperature</div>
                <div class="main-val"><span id="t">0.0</span><span class="unit">°C</span></div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Feels Like</span><span id="rf" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Humidity</span><span id="h_val" class="badge-val">--</span></div>
                </div>
            </div>
            <div class="card">
                <div class="label">Wind Speed</div>
                <div class="main-val"><span id="w">0.0</span><span class="unit">km/h</span></div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Direction</span><span id="wd" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Gust</span><span id="wg" class="badge-val">--</span></div>
                </div>
            </div>
            <div class="card">
                <div class="label">Rainfall</div>
                <div class="main-val"><span id="r_tot">0.0</span><span class="unit">mm</span></div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Rate</span><span id="r_rate" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Pressure</span><span id="pr" class="badge-val">--</span></div>
                </div>
            </div>
        </div>
        <div class="graphs-wrapper">
            <div class="graph-card"><canvas id="cT"></canvas></div>
            <div class="graph-card"><canvas id="cR"></canvas></div>
        </div>
    </div>
    <script>
        let charts = {};
        function setupChart(id, label, color) {
            const ctx = document.getElementById(id).getContext('2d');
            return new Chart(ctx, { type: 'line', data: { labels: [], datasets: [{ label, data: [], borderColor: color, tension: 0.4, fill: true, backgroundColor: color+'20', pointRadius: 0 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { beginAtZero: false } } } });
        }

        async function update() {
            try {
                const res = await fetch('/weather');
                const d = await res.json();
                if (d.error) return;

                // TRIGGER THE FOCUS EFFECT
                document.querySelectorAll('.main-val').forEach(el => el.classList.add('loaded'));

                document.getElementById('t').innerText = d.temp.current;
                document.getElementById('rf').innerText = d.temp.realFeel + '°C';
                document.getElementById('h_val').innerText = d.atmo.hum + '%';
                document.getElementById('w').innerText = d.wind.speed;
                document.getElementById('wg').innerText = d.wind.gust + ' km/h';
                document.getElementById('wd').innerText = d.wind.card;
                document.getElementById('r_tot').innerText = d.rain.total;
                document.getElementById('r_rate').innerText = d.rain.rate + ' mm/h';
                document.getElementById('pr').innerText = d.atmo.press + ' hPa';
                document.getElementById('ts').innerText = new Date(d.lastSync).toLocaleTimeString();

                if(!charts.cT) {
                    charts.cT = setupChart('cT', 'Temp', '#ef4444');
                    charts.cR = setupChart('cR', 'Rain', '#3b82f6');
                }
                const labels = d.history.map(h => new Date(h.time).toLocaleTimeString());
                charts.cT.data.labels = labels; charts.cT.data.datasets[0].data = d.history.map(h => h.temp); charts.cT.update();
                charts.cR.data.labels = labels; charts.cR.data.datasets[0].data = d.history.map(h => h.rain); charts.cR.update();
            } catch (e) { console.error(e); }
        }
        update(); setInterval(update, 30000);
    </script>
</body>
</html>
    `);
});

app.listen(3000);
module.exports = app;
