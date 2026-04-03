const express = require("express");
const fetch = require("node-fetch");
const fs = require("fs");
const app = express();

const APPLICATION_KEY = process.env.APPLICATION_KEY;
const API_KEY = process.env.API_KEY;
const MAC = process.env.MAC;

// Use /tmp for serverless environments (like Vercel) to prevent write-errors
const STORAGE_FILE = process.env.VERCEL ? "/tmp/weather_stats.json" : "./weather_stats.json";

let state = {
    cachedData: null,
    todayHistory: [],
    maxTemp: -999,
    minTemp: 999,
    maxWindSpeed: 0,
    maxGust: 0,
    maxRainRate: 0,
    lastFetchTime: 0,
    currentDate: new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })
};

// --- RESTORE MAX/MIN ON RESTART ---
if (fs.existsSync(STORAGE_FILE)) {
    try {
        const saved = JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf-8'));
        if (saved.currentDate === state.currentDate) {
            state.maxTemp = saved.maxTemp ?? -999;
            state.minTemp = saved.minTemp ?? 999;
            state.maxWindSpeed = saved.maxWindSpeed ?? 0;
            state.maxGust = saved.maxGust ?? 0;
            state.maxRainRate = saved.maxRainRate ?? 0;
        }
    } catch (e) { console.log("Init: Starting fresh records."); }
}

function saveToDisk() {
    try {
        const data = {
            currentDate: state.currentDate,
            maxTemp: state.maxTemp, minTemp: state.minTemp,
            maxWindSpeed: state.maxWindSpeed, maxGust: state.maxGust, maxRainRate: state.maxRainRate
        };
        fs.writeFileSync(STORAGE_FILE, JSON.stringify(data), 'utf-8');
    } catch (e) { /* Silently handle read-only filesystems to prevent UI freeze */ }
}

const getCard = (a) => ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"][Math.round(a/22.5)%16];

async function syncWithEcowitt() {
    const now = Date.now();
    if (state.cachedData && (now - state.lastFetchTime < 40000)) return state.cachedData;

    try {
        const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}`;
        const response = await fetch(url);
        const json = await response.json();
        const d = json.data;

        const tempC = parseFloat(((d.outdoor.temperature.value - 32) * 5 / 9).toFixed(1));
        const dewC = parseFloat(((d.outdoor.dew_point.value - 32) * 5 / 9).toFixed(1));
        const rainRate = parseFloat((d.rainfall.rain_rate.value * 25.4).toFixed(1));
        const dailyRain = parseFloat((d.rainfall.daily.value * 25.4).toFixed(1));
        const windKmh = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));
        const gustKmh = parseFloat((d.wind.wind_gust.value * 1.60934).toFixed(1));
        const windDeg = d.wind.wind_direction.value;

        // Daily Reset logic (Midnight Chennai)
        const today = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
        if (state.currentDate !== today) {
            state.currentDate = today;
            state.maxTemp = -999; state.minTemp = 999;
            state.maxWindSpeed = 0; state.maxGust = 0; state.maxRainRate = 0;
            state.todayHistory = [];
        }

        let changed = false;
        if (tempC > state.maxTemp || state.maxTemp === -999) { state.maxTemp = tempC; changed = true; }
        if (tempC < state.minTemp || state.minTemp === 999) { state.minTemp = tempC; changed = true; }
        if (windKmh > state.maxWindSpeed) { state.maxWindSpeed = windKmh; changed = true; }
        if (gustKmh > state.maxGust) { state.maxGust = gustKmh; changed = true; }
        if (rainRate > state.maxRainRate) { state.maxRainRate = rainRate; changed = true; }
        if (changed) saveToDisk();

        // --- METEOROLOGICAL 1-HOUR TREND ---
        let trend = 0;
        if (state.todayHistory.length >= 60) {
            trend = parseFloat((tempC - state.todayHistory[state.todayHistory.length - 60].temp).toFixed(1));
        } else if (state.todayHistory.length > 2) {
            const first = state.todayHistory[0];
            const hoursPassed = (now - new Date(first.time).getTime()) / 3600000;
            trend = parseFloat(((tempC - first.temp) / hoursPassed).toFixed(1));
        }

        state.todayHistory.push({ time: new Date().toISOString(), temp: tempC, hum: d.outdoor.humidity.value, wind: windKmh, rain: rainRate });
        if (state.todayHistory.length > 300) state.todayHistory.shift();

        state.cachedData = {
            temp: { current: tempC, max: state.maxTemp, min: state.minTemp, trend: trend },
            atmo: { hum: d.outdoor.humidity.value, dew: dewC, press: (d.pressure.relative.value * 33.8639).toFixed(1) },
            wind: { speed: windKmh, gust: gustKmh, maxS: state.maxWindSpeed, maxG: state.maxGust, card: getCard(windDeg), deg: windDeg },
            rain: { total: dailyRain, rate: rainRate, maxR: state.maxRainRate },
            lastSync: new Date().toISOString(),
            history: state.todayHistory
        };
        state.lastFetchTime = now;
        return state.cachedData;
    } catch (e) { return state.cachedData || { error: "Offline" }; }
}

app.get("/weather", async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await syncWithEcowitt());
});

app.get("/", (req, res) => {
    res.send(`<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>KK Nagar Weather Station</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root { 
            --bg: #030712; 
            --card-bg: rgba(17, 24, 39, 0.7);
            --accent: #38bdf8;
            --max-t: #fb7185; 
            --min-t: #60a5fa; 
            --wind: #fbbf24; 
            --rain: #818cf8;
            --border: rgba(255, 255, 255, 0.08);
        }

        body { 
            margin: 0; 
            font-family: 'Inter', system-ui, sans-serif; 
            background: radial-gradient(circle at top right, #1e1b4b, #030712); 
            color: #f1f5f9; 
            padding: 20px;
            min-height: 100vh;
        }

        .header { text-align: left; margin-bottom: 30px; padding: 0 10px; }
        .header h1 { 
            margin: 0; font-size: 24px; font-weight: 800; 
            background: linear-gradient(to right, #fff, #94a3b8);
            -webkit-background-clip: text; -webkit-text-fill-color: transparent;
        }
        .live-indicator { 
            display: inline-flex; align-items: center; gap: 8px; 
            background: rgba(255,255,255,0.05); padding: 5px 12px; 
            border-radius: 20px; margin-top: 10px; font-size: 13px; font-weight: 600;
        }
        .dot { width: 8px; height: 8px; background: #22c55e; border-radius: 50%; box-shadow: 0 0 12px #22c55e; animation: pulse 2s infinite; }

        .readings-grid { 
            display: grid; 
            grid-template-columns: 1.5fr 1fr 1fr; 
            gap: 16px; 
            margin-bottom: 30px; 
        }

        .card { 
            background: var(--card-bg); 
            backdrop-filter: blur(12px);
            padding: 24px; 
            border-radius: 24px; 
            border: 1px solid var(--border); 
            transition: transform 0.3s ease, border-color 0.3s ease;
            position: relative;
            overflow: hidden;
        }
        .card:hover { border-color: rgba(56, 189, 248, 0.4); transform: translateY(-2px); }

        .card.hero { grid-row: span 2; display: flex; flex-direction: column; justify-content: space-between; }

        .label { color: #94a3b8; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; display: flex; align-items: center; gap: 8px; }
        .main-val { font-size: 56px; font-weight: 900; margin: 15px 0; letter-spacing: -2px; }
        .hero .main-val { font-size: 72px; }

        .trend-line { font-size: 14px; font-weight: 600; padding: 8px 12px; background: rgba(0,0,0,0.2); border-radius: 12px; width: fit-content; }
        
        .sub-box { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 20px; border-top: 1px solid var(--border); padding-top: 15px; }
        .badge { display: flex; flex-direction: column; font-size: 11px; color: #64748b; font-weight: 600; }
        .badge span { font-size: 16px; color: #fff; margin-top: 4px; }

        .compass-ui { position: absolute; top: 20px; right: 20px; width: 50px; height: 50px; border: 1.5px solid var(--border); border-radius: 50%; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.3); }
        #needle { width: 3px; height: 30px; background: linear-gradient(to bottom, var(--max-t) 50%, #fff 50%); clip-path: polygon(50% 0%, 100% 100%, 0% 100%); transition: transform 1.5s cubic-bezier(0.17, 0.67, 0.83, 0.67); }

        .graphs-title { font-size: 12px; font-weight: 800; color: #475569; margin: 40px 0 20px; text-transform: uppercase; letter-spacing: 3px; text-align: center; }
        .graphs-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 16px; }
        .graph-card { background: var(--card-bg); padding: 20px; border-radius: 24px; border: 1px solid var(--border); height: 250px; }

        @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(1.1); } }

        @media (max-width: 1024px) { .readings-grid { grid-template-columns: 1fr 1fr; } .card.hero { grid-row: auto; grid-column: span 2; } }
        @media (max-width: 650px) { .readings-grid { grid-template-columns: 1fr; } .card.hero { grid-column: auto; } .graphs-grid { grid-template-columns: 1fr; } }
    </style>
</head>
<body>
    <div class="header">
        <h1>KK NAGAR LIVE STATION</h1>
        <div class="live-indicator"><div class="dot"></div> <span id="ts">--:--:--</span></div>
    </div>

    <div class="readings-grid">
        <div class="card hero">
            <div>
                <div class="label">🌡️ Outside Temperature</div>
                <div id="t" class="main-val">--°</div>
                <div id="tr" class="trend-line">--</div>
            </div>
            <div class="sub-box">
                <div class="badge">Today's Max <span id="mx" style="color:var(--max-t)">--</span></div>
                <div class="badge">Today's Min <span id="mn" style="color:var(--min-t)">--</span></div>
            </div>
        </div>

        <div class="card">
            <div class="label">💨 Wind Speed</div>
            <div class="compass-ui"><div id="needle"></div></div>
            <div id="w" class="main-val">--</div>
            <div id="wg" style="font-size: 13px; color: var(--accent); margin-bottom: 10px;">--</div>
            <div class="sub-box">
                <div class="badge">Max Speed <span id="mw">--</span></div>
                <div class="badge">Peak Gust <span id="mg">--</span></div>
            </div>
        </div>

        <div class="card">
            <div class="label">🌧️ Total Rainfall</div>
            <div id="r" class="main-val">--</div>
            <div id="rr" style="font-size: 13px; color: var(--rain); margin-bottom: 10px;">--</div>
            <div class="sub-box">
                <div class="badge">Peak Rate <span id="mr">--</span></div>
                <div class="badge">Condition <span id="rs">--</span></div>
            </div>
        </div>

        <div class="card" style="grid-column: span 2;">
            <div class="label">💧 Air & Pressure</div>
            <div style="display: flex; gap: 40px; align-items: baseline; flex-wrap: wrap;">
                <div>
                    <div id="h" style="font-size: 42px; font-weight: 900; margin-top: 10px;">--</div>
                    <div style="font-size: 12px; color: #22c55e;">Humidity %</div>
                </div>
                <div>
                    <div id="pr" style="font-size: 32px; font-weight: 800; margin-top: 15px;">--</div>
                    <div style="font-size: 12px; color: #94a3b8;">Pressure (hPa)</div>
                </div>
                <div>
                    <div id="dp" style="font-size: 32px; font-weight: 800; margin-top: 15px;">--</div>
                    <div style="font-size: 12px; color: #94a3b8;">Dew Point</div>
                </div>
            </div>
        </div>
    </div>

    <div class="graphs-title">Trend Analytics</div>
    <div class="graphs-grid">
        <div class="graph-card"><canvas id="cT"></canvas></div>
        <div class="graph-card"><canvas id="cH"></canvas></div>
        <div class="graph-card"><canvas id="cW"></canvas></div>
        <div class="graph-card"><canvas id="cR"></canvas></div>
    </div>

    <script>
        let charts = {};
        function setupChart(id, label, col, minZero = false) {
            const ctx = document.getElementById(id).getContext('2d');
            const gradient = ctx.createLinearGradient(0, 0, 0, 250);
            gradient.addColorStop(0, col + '44');
            gradient.addColorStop(1, col + '00');
            return new Chart(ctx, {
                type: 'line',
                data: { labels: [], datasets: [{ label: label, data: [], borderColor: col, tension: 0.4, pointRadius: 0, borderWidth: 3, fill: true, backgroundColor: gradient }]},
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: true, labels: {color: '#94a3b8', font: {size: 11}} } },
                    scales: { x: { ticks: { color: '#475569', font: { size: 10 }, autoSkip: true, maxTicksLimit: 6 }, grid: { display: false } }, 
                              y: { beginAtZero: minZero, min: minZero ? 0 : undefined, ticks: { color: '#475569' }, grid: { color: '#1e293b' } } }
                }
            });
        }

        async function update() {
            try {
                const res = await fetch('/weather?v=' + Date.now());
                const d = await res.json();
                if (d.error) return;

                document.getElementById('t').innerText = d.temp.current + '°';
                const symb = d.temp.trend > 0 ? '▲' : d.temp.trend < 0 ? '▼' : '●';
                document.getElementById('tr').innerHTML = '<span>Trend: </span> <span style="color:' + (d.temp.trend >= 0 ? 'var(--max-t)' : '#22c55e') + '">' + symb + ' ' + Math.abs(d.temp.trend) + '°C/hr</span>';
                document.getElementById('mx').innerText = d.temp.max + '°';
                document.getElementById('mn').innerText = d.temp.min + '°';

                document.getElementById('h').innerText = d.atmo.hum + '%';
                document.getElementById('dp').innerText = d.atmo.dew + '°';
                document.getElementById('pr').innerText = d.atmo.press;

                document.getElementById('w').innerText = d.wind.speed + ' km/h';
                document.getElementById('wg').innerText = 'Direction: ' + d.wind.card + ' | Gust: ' + d.wind.gust + ' km/h';
                document.getElementById('mw').innerText = d.wind.maxS + ' km/h';
                document.getElementById('mg').innerText = d.wind.maxG + ' km/h';
                document.getElementById('needle').style.transform = 'rotate(' + d.wind.deg + 'deg)';

                document.getElementById('r').innerText = d.rain.total + ' mm';
                document.getElementById('rr').innerText = 'Intensity: ' + d.rain.rate + ' mm/h';
                document.getElementById('mr').innerText = d.rain.maxR + ' mm/h';
                document.getElementById('rs').innerText = d.rain.rate > 0 ? 'Raining' : 'Dry';

                document.getElementById('ts').innerText = new Date(d.lastSync).toLocaleTimeString('en-IN', {hour12: false});

                const lbls = d.history.map(h => new Date(h.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }));
                if (!charts.cT) {
                    charts.cT = setupChart('cT', 'Temp (°C)', '#38bdf8', false);
                    charts.cH = setupChart('cH', 'Hum (%)', '#10b981', true);
                    charts.cW = setupChart('cW', 'Wind (km/h)', '#fbbf24', true);
                    charts.cR = setupChart('cR', 'Rain (mm/h)', '#818cf8', true);
                }
                charts.cT.data.labels = lbls; charts.cT.data.datasets[0].data = d.history.map(h=>h.temp); charts.cT.update('none');
                charts.cH.data.labels = lbls; charts.cH.data.datasets[0].data = d.history.map(h=>h.hum); charts.cH.update('none');
                charts.cW.data.labels = lbls; charts.cW.data.datasets[0].data = d.history.map(h=>h.wind); charts.cW.update('none');
                charts.cR.data.labels = lbls; charts.cR.data.datasets[0].data = d.history.map(h=>h.rain); charts.cR.update('none');
            } catch(e) {}
        }
        setInterval(update, 45000);
        update();
    </script>
</body>
</html>`);
});

module.exports = app;
