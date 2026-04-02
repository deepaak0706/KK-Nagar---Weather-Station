const express = require("express");
const fetch = require("node-fetch");
const app = express();

const APPLICATION_KEY = process.env.APPLICATION_KEY;
const API_KEY = process.env.API_KEY;
const MAC = process.env.MAC;

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

        if (tempC > state.maxTemp || state.maxTemp === -999) state.maxTemp = tempC;
        if (tempC < state.minTemp || state.minTemp === 999) state.minTemp = tempC;
        if (windKmh > state.maxWindSpeed) state.maxWindSpeed = windKmh;
        if (gustKmh > state.maxGust) state.maxGust = gustKmh;
        if (rainRate > state.maxRainRate) state.maxRainRate = rainRate;

        let trend = 0;
        if (state.todayHistory.length > 10) {
            trend = parseFloat((tempC - state.todayHistory[state.todayHistory.length - 10].temp).toFixed(1));
        }

        state.todayHistory.push({ time: new Date().toISOString(), temp: tempC, hum: d.outdoor.humidity.value, wind: windKmh, rain: rainRate });
        if (state.todayHistory.length > 300) state.todayHistory.shift();

        state.cachedData = {
            temp: { current: tempC, max: state.maxTemp, min: state.minTemp, trend: trend },
            atmo: { hum: d.outdoor.humidity.value, dew: dewC, press: (d.pressure.relative.value * 33.8639).toFixed(1) },
            wind: { speed: windKmh, gust: gustKmh, maxS: state.maxWindSpeed, maxG: state.maxGust, card: getCard(d.wind.wind_direction.value) },
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
    <title>KK Nagar Weather Live</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root { 
            --bg: #06080e; --card: #111827; --accent: #0ea5e9;
            --max-t: #f87171; --min-t: #60a5fa; --wind: #fbbf24; --rain: #818cf8;
        }
        body { margin:0; font-family: 'Inter', system-ui, sans-serif; background: var(--bg); color: #f1f5f9; padding: 15px; }
        
        .header { text-align: center; margin-bottom: 20px; }
        .header h1 { margin: 0; font-size: 18px; letter-spacing: 2px; font-weight: 900; opacity: 0.9; }
        .live-indicator { display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 5px; font-family: monospace; font-size: 16px; color: #64748b; }
        .dot { width: 8px; height: 8px; background: #22c55e; border-radius: 50%; box-shadow: 0 0 10px #22c55e; animation: pulse 2s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

        /* THE 2-COLUMN GROUPED GRID */
        .readings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 30px; }

        .card { 
            background: var(--card); padding: 18px; border-radius: 16px; 
            border: 1px solid #1e293b; box-shadow: 0 4px 20px rgba(0,0,0,0.4); 
        }
        
        .label { color: var(--accent); font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; opacity: 0.8; }
        .main-val { font-size: 32px; font-weight: 800; margin: 2px 0; letter-spacing: -1px; }
        .trend-text { font-size: 12px; font-weight: 600; margin-bottom: 12px; display: flex; align-items: center; gap: 4px; }
        
        .badge-row { display: flex; flex-wrap: wrap; gap: 6px; padding-top: 10px; border-top: 1px solid #1e293b; }
        .badge { padding: 3px 8px; border-radius: 5px; font-size: 11px; font-weight: 700; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05); }

        .graphs-title { font-size: 12px; font-weight: 800; color: #475569; margin-bottom: 15px; text-transform: uppercase; letter-spacing: 2px; text-align: center; }
        .graphs-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 15px; }
        .graph-card { background: var(--card); padding: 12px; border-radius: 16px; height: 240px; border: 1px solid #1e293b; }

        @media (max-width: 600px) { .readings-grid, .graphs-grid { grid-template-columns: 1fr; } }
    </style>
</head>
<body>

    <div class="header">
        <h1>KK NAGAR WEATHER STATION LIVE</h1>
        <div class="live-indicator"><div class="dot"></div> <span id="ts">00:00:00</span></div>
    </div>

    <div class="readings-grid">
        <div class="card">
            <div class="label">Temperature</div>
            <div id="t" class="main-val">--</div>
            <div id="tr" class="trend-text">--</div>
            <div class="badge-row">
                <div class="badge" style="color:var(--max-t)">Max: <span id="mx">--</span></div>
                <div class="badge" style="color:var(--min-t)">Min: <span id="mn">--</span></div>
            </div>
        </div>

        <div class="card">
            <div class="label">Wind Speed</div>
            <div id="w" class="main-val">--</div>
            <div id="wg" class="trend-text" style="color:var(--accent)">--</div>
            <div class="badge-row">
                <div class="badge" style="color:var(--wind)">Max: <span id="mw">--</span></div>
                <div class="badge" style="color:var(--wind); opacity:0.8">Gust: <span id="mg">--</span></div>
            </div>
        </div>

        <div class="card">
            <div class="label">Humidity</div>
            <div id="h" class="main-val">--</div>
            <div class="trend-text" style="color:#22c55e">● Atmospheric Stability</div>
            <div class="badge-row">
                <div class="badge" style="color:#94a3b8">Pressure: <span id="pr">--</span></div>
            </div>
        </div>

        <div class="card">
            <div class="label">Dew Point</div>
            <div id="dp" class="main-val">--</div>
            <div class="trend-text" style="color:#94a3b8">Comfort Level: Normal</div>
            <div class="badge-row">
                <div class="badge" style="color:#94a3b8">Relative to Temp</div>
            </div>
        </div>

        <div class="card">
            <div class="label">Rainfall (24h)</div>
            <div id="r" class="main-val">--</div>
            <div class="trend-text" style="color:#818cf8">Total Accumulation</div>
            <div class="badge-row">
                <div class="badge" style="color:#94a3b8">Status: <span id="rs">--</span></div>
            </div>
        </div>

        <div class="card">
            <div class="label">Rain Rate</div>
            <div id="rr_val" class="main-val">--</div>
            <div class="trend-text" style="color:var(--rain)">Intensity Meter</div>
            <div class="badge-row">
                <div class="badge" style="color:var(--rain)">Peak: <span id="mr">--</span></div>
            </div>
        </div>
    </div>

    <div class="graphs-title">Live Trend Analytics</div>
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
            const gradient = ctx.createLinearGradient(0, 0, 0, 240);
            gradient.addColorStop(0, col + '33');
            gradient.addColorStop(1, col + '00');

            return new Chart(ctx, {
                type: 'line',
                data: { labels: [], datasets: [{ label: label, data: [], borderColor: col, tension: 0.4, pointRadius: 0, borderWidth: 2.5, fill: true, backgroundColor: gradient }]},
                options: { 
                    responsive: true, maintainAspectRatio: false, 
                    plugins: { legend: { display: true, labels: {color: '#64748b', font: {size: 10, weight: 'bold'}} } },
                    scales: { 
                        x: { ticks: { color: '#475569', font: { size: 9 }, autoSkip: true, maxTicksLimit: 6 }, grid: { display: false } }, 
                        y: { beginAtZero: minZero, min: minZero ? 0 : undefined, ticks: { color: '#475569', font: {size: 9} }, grid: { color: '#1e293b' } } 
                    }
                }
            });
        }

        async function update() {
            try {
                const res = await fetch('/weather?v=' + Date.now());
                const d = await res.json();
                
                // Temp
                document.getElementById('t').innerText = d.temp.current + '°C';
                const symb = d.temp.trend > 0 ? '▲' : d.temp.trend < 0 ? '▼' : '●';
                document.getElementById('tr').innerHTML = '<span style="color:' + (d.temp.trend >= 0 ? 'var(--max-t)' : '#22c55e') + '">' + symb + ' ' + Math.abs(d.temp.trend) + '°C/hr</span>';
                document.getElementById('mx').innerText = d.temp.max + '°';
                document.getElementById('mn').innerText = d.temp.min + '°';

                // Wind
                document.getElementById('w').innerText = d.wind.speed + ' km/h';
                document.getElementById('wg').innerText = d.wind.card + ' Direction';
                document.getElementById('mw').innerText = d.wind.maxS + ' km/h';
                document.getElementById('mg').innerText = d.wind.maxG + ' km/h';

                // Humidity & Dew
                document.getElementById('h').innerText = d.atmo.hum + '%';
                document.getElementById('pr').innerText = d.atmo.press + ' hPa';
                document.getElementById('dp').innerText = d.atmo.dew + '°C';

                // Rain
                document.getElementById('r').innerText = d.rain.total + ' mm';
                document.getElementById('rs').innerText = d.rain.rate > 0 ? 'Raining' : 'Dry';
                document.getElementById('rr_val').innerText = d.rain.rate + ' mm/h';
                document.getElementById('mr').innerText = d.rain.maxR + ' mm/h';

                document.getElementById('ts').innerText = new Date(d.lastSync).toLocaleTimeString('en-IN', {hour12: false});

                const lbls = d.history.map(h => new Date(h.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }));
                if (!charts.cT) {
                    charts.cT = setupChart('cT', 'Temperature (°C)', '#0ea5e9', false);
                    charts.cH = setupChart('cH', 'Humidity (%)', '#10b981', true);
                    charts.cW = setupChart('cW', 'Wind Speed (km/h)', '#f59e0b', true);
                    charts.cR = setupChart('cR', 'Rain Rate (mm/h)', '#6366f1', true);
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
