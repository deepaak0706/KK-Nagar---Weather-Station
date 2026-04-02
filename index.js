const express = require("express");
const fetch = require("node-fetch");
const app = express();

const APPLICATION_KEY = process.env.APPLICATION_KEY;
const API_KEY = process.env.API_KEY;
const MAC = process.env.MAC;

// In-Memory State (Note: Resets on Vercel "Cold Starts")
let state = {
    cachedData: null,
    todayHistory: [],
    todayMaxRainRate: 0,
    todayMaxWindSpeed: 0,
    todayMaxWindGust: 0,
    currentDate: new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }),
    maxTemp: -999,
    minTemp: 999,
    lastFetchTime: 0
};

async function syncWithEcowitt() {
    const now = Date.now();
    
    // Serve from cache if we checked Ecowitt less than 45 seconds ago
    if (state.cachedData && (now - state.lastFetchTime < 45000)) {
        return state.cachedData;
    }

    const todayStr = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });

    // Reset daily stats at midnight IST
    if (todayStr !== state.currentDate) {
        state = { ...state, todayHistory: [], todayMaxRainRate: 0, todayMaxWindSpeed: 0, todayMaxWindGust: 0, maxTemp: -999, minTemp: 999, currentDate: todayStr };
    }

    try {
        const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}`;
        const response = await fetch(url);
        const ecowitt = await response.json();
        if (ecowitt.code !== 0) throw new Error(ecowitt.msg);
        
        const d = ecowitt.data;

        // Metric Conversions
        const tempC = parseFloat(((d.outdoor.temperature.value - 32) * 5 / 9).toFixed(1));
        const rainRate = parseFloat((d.rainfall.rain_rate.value * 25.4).toFixed(1));
        const totalRain = parseFloat((d.rainfall.daily.value * 25.4).toFixed(1));
        const windKmh = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));
        const gustKmh = parseFloat((d.wind.wind_gust.value * 1.60934).toFixed(1));

        // Update Highs/Lows
        if (tempC > state.maxTemp || state.maxTemp === -999) state.maxTemp = tempC;
        if (tempC < state.minTemp || state.minTemp === 999) state.minTemp = tempC;
        if (rainRate > state.todayMaxRainRate) state.todayMaxRainRate = rainRate;
        if (windKmh > state.todayMaxWindSpeed) state.todayMaxWindSpeed = windKmh;
        if (gustKmh > state.todayMaxWindGust) state.todayMaxWindGust = gustKmh;

        let trend = 0;
        if (state.todayHistory.length > 10) {
            trend = parseFloat((tempC - state.todayHistory[state.todayHistory.length - 10].temp).toFixed(1));
        }

        state.todayHistory.push({ time: new Date().toISOString(), temp: tempC, hum: d.outdoor.humidity.value, wind: windKmh, rain: rainRate });
        if (state.todayHistory.length > 1440) state.todayHistory.shift();

        state.cachedData = {
            temp: { current: tempC, max: state.maxTemp, min: state.minTemp, trend, feels: ((d.outdoor.feels_like.value - 32) * 5 / 9).toFixed(1) },
            wind: { speed: windKmh, gust: gustKmh, maxSpeed: state.todayMaxWindSpeed, maxGust: state.todayMaxWindGust, deg: d.wind.wind_direction.value },
            atmo: { hum: d.outdoor.humidity.value, dew: ((d.outdoor.dew_point.value - 32) * 5 / 9).toFixed(1), press: (d.pressure.relative.value * 33.8639).toFixed(1), uv: d.solar_and_uvi.uvi.value, solar: d.solar_and_uvi.solar.value },
            rain: { total: totalRain, rate: rainRate, maxRate: state.todayMaxRainRate },
            history: state.todayHistory,
            lastSync: new Date().toISOString()
        };

        state.lastFetchTime = now;
        return state.cachedData;
    } catch (e) {
        console.error("Sync Failed:", e.message);
        return state.cachedData || { error: "Failed to connect to weather station" };
    }
}

// On-Demand API Route
app.get("/weather", async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const data = await syncWithEcowitt();
    res.json(data);
});

// Front-End Dashboard
app.get("/", (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>KK Nagar Weather</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root { --bg: #0b0f1a; --card: rgba(23, 32, 53, 0.9); --accent: #38bdf8; }
        body { margin:0; font-family:'Segoe UI',sans-serif; background:var(--bg); color:#f1f5f9; padding:15px; }
        .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap:15px; margin-bottom:15px; }
        .card { background:var(--card); border:1px solid rgba(255,255,255,0.1); padding:20px; border-radius:15px; }
        .label { font-size:11px; font-weight:bold; text-transform:uppercase; color: var(--accent); letter-spacing:1px; }
        .value { font-size:36px; font-weight:800; margin:10px 0; }
        .sub { display:grid; grid-template-columns: 1fr 1fr; font-size:13px; gap:8px; border-top:1px solid rgba(255,255,255,0.1); padding-top:10px; margin-top:5px; }
        .stat-v { font-weight:bold; text-align:right; }
        .up { color:#4ade80; } .down { color:#f87171; }
        .chart-box { height:220px; }
        #status { text-align:center; font-size:12px; padding:12px; border-radius:8px; margin-bottom:15px; transition: 0.3s; }
        .status-ok { background: rgba(34, 197, 94, 0.1); color: #4ade80; border: 1px solid #22c55e33; }
        .status-err { background: rgba(239, 68, 68, 0.1); color: #f87171; border: 1px solid #ef444433; }
    </style>
</head>
<body>
    <div style="max-width:1200px; margin:0 auto;">
        <h2 style="text-align:center; margin-bottom:15px; letter-spacing:-1px;">KK Nagar Weather Station</h2>
        <div id="status" class="status-ok">Syncing...</div>

        <div class="grid">
            <div class="card">
                <div class="label">Temperature</div>
                <div id="temp" class="value">--</div>
                <div id="tempTrend" style="font-size:14px; font-weight:bold; margin-bottom:10px;">--</div>
                <div class="sub">
                    <span>Daily Max</span><span id="maxT" class="stat-v down">--</span>
                    <span>Daily Min</span><span id="minT" class="stat-v up">--</span>
                    <span>Feels Like</span><span id="feels" class="stat-v">--</span>
                </div>
            </div>

            <div class="card">
                <div class="label">Wind & Direction</div>
                <div id="wSpeed" class="value">--</div>
                <div id="wDirName" style="font-size:14px; font-weight:bold; color:var(--accent);">--</div>
                <div class="sub">
                    <span>Max Speed</span><span id="maxW" class="stat-v">--</span>
                    <span>Max Gust</span><span id="maxG" class="stat-v">--</span>
                    <span>Degrees</span><span id="wDeg" class="stat-v">--</span>
                </div>
            </div>

            <div class="card">
                <div class="label">Atmosphere</div>
                <div id="hum" class="value">--</div>
                <div id="press" style="font-size:14px; font-weight:bold;">--</div>
                <div class="sub">
                    <span>Dew Point</span><span id="dew" class="stat-v">--</span>
                    <span>UV Index</span><span id="uv" class="stat-v">--</span>
                    <span>Solar Rad</span><span id="solar" class="stat-v">--</span>
                </div>
            </div>

            <div class="card">
                <div class="label">Daily Rainfall</div>
                <div id="rTotal" class="value">--</div>
                <div id="rRate" style="font-size:14px; font-weight:bold; color:#818cf8;">--</div>
                <div class="sub">
                    <span>Max Rate</span><span id="maxR" class="stat-v">--</span>
                    <span>Status</span><span id="rStatus" class="stat-v">--</span>
                </div>
            </div>
        </div>

        <div class="grid">
            <div class="card chart-box"><canvas id="cTemp"></canvas></div>
            <div class="card chart-box"><canvas id="cHum"></canvas></div>
            <div class="card chart-box"><canvas id="cWind"></canvas></div>
            <div class="card chart-box"><canvas id="cRain"></canvas></div>
        </div>
    </div>

    <script>
        let charts = {};
        const getCard = (a) => ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"][Math.round(a/22.5)%16];

        function makeChart(id, label, col) {
            return new Chart(document.getElementById(id), {
                type: 'line',
                data: { labels: [], datasets: [{ label: label, data: [], borderColor: col, tension: 0.3, pointRadius: 0, borderWidth: 2 }]},
                options: { 
                    responsive: true, maintainAspectRatio: false,
                    scales: { 
                        y: { min: 0, beginAtZero: true, grid: { color: '#ffffff05' }, ticks: { color: '#888', font: {size
