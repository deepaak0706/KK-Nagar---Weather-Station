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
    <title>KK Nagar Weather</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root { --bg: #080b14; --card: #111827; --accent: #0ea5e9; }
        body { margin:0; font-family: 'Inter', system-ui, sans-serif; background: var(--bg); color: #f8fafc; padding: 20px; overflow-x: hidden; }
        
        /* HEADER */
        .header { text-align: center; margin-bottom: 25px; border-bottom: 1px solid #1e293b; padding-bottom: 15px; }
        .header h1 { margin: 0; font-size: 20px; letter-spacing: 3px; font-weight: 900; color: #f8fafc; }
        .live-indicator { display: flex; align-items: center; justify-content: center; gap: 10px; margin-top: 8px; font-family: monospace; font-size: 18px; color: #94a3b8; }
        .dot { width: 12px; height: 12px; background: #22c55e; border-radius: 50%; box-shadow: 0 0 15px #22c55e; animation: pulse 2s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.2; } }

        /* HORIZONTAL READINGS */
        .readings-container { 
            display: flex; 
            gap: 15px; 
            margin-bottom: 40px; 
            overflow-x: auto; 
            padding-bottom: 10px;
            scrollbar-width: none; /* Firefox */
        }
        .readings-container::-webkit-scrollbar { display: none; } /* Chrome/Safari */

        .card { 
            flex: 0 0 calc(25% - 12px); /* 4 side-by-side */
            min-width: 280px; 
            background: var(--card); 
            padding: 20px; 
            border-radius: 20px; 
            border: 1px solid #1e293b;
            box-shadow: 0 4px 6px -1px rgba(0,0,0,0.5);
        }
        
        .label { color: var(--accent); font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 5px; }
        .main-val { font-size: 48px; font-weight: 900; margin: 2px 0; letter-spacing: -2px; }
        .trend-line { font-size: 14px; font-weight: 600; margin-bottom: 15px; display: flex; align-items: center; gap: 6px; }
        .sub-box { display: grid; grid-template-columns: 1fr 1fr; font-size: 13px; gap: 10px; padding-top: 12px; border-top: 1px solid #1e293b; color: #94a3b8; }
        b { color: #f8fafc; }

        /* GRAPHS SECTION */
        .graphs-title { font-size: 14px; font-weight: 800; color: #475569; margin-bottom: 20px; text-transform: uppercase; letter-spacing: 2px; text-align: center; }
        .graphs-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(450px, 1fr)); gap: 20px; }
        .graph-card { background: var(--card); padding: 15px; border-radius: 20px; height: 280px; border: 1px solid #1e293b; }

        @media (max-width: 1024px) {
            .card { flex: 0 0 300px; } /* Swipeable on tablet/mobile */
        }
    </style>
</head>
<body>

    <div class="header">
        <h1>KK NAGAR WEATHER STATION LIVE</h1>
        <div class="live-indicator"><div class="dot"></div> <span id="ts">00:00:00</span></div>
    </div>

    <div class="readings-container">
        <div class="card">
            <div class="label">Temperature</div>
            <div id="t" class="main-val">--</div>
            <div id="tr" class="trend-line">--</div>
            <div class="sub-box">
                <span>Daily Max: <b id="mx">--</b></span><span>Daily Min: <b id="mn">--</b></span>
            </div>
        </div>

        <div class="card">
            <div class="label">Humidity & Dew Point</div>
            <div id="h" class="main-val">--</div>
            <div class="trend-line" style="color:#22c55e">● Stable Conditions</div>
            <div class="sub-box">
                <span>Dew Point: <b id="dp">--</b></span><span>Pressure: <b id="pr">--</b></span>
            </div>
        </div>

        <div class="card">
            <div class="label">Wind Conditions</div>
            <div id="w" class="main-val">--</div>
            <div id="wg" class="trend-line" style="color:var(--accent)">--</div>
            <div class="sub-box">
                <span>Max Speed: <b id="mw">--</b></span><span>Max Gust: <b id="mg">--</b></span>
            </div>
        </div>

        <div class="card">
            <div class="label">Rainfall (24h)</div>
            <div id="r" class="main-val">--</div>
            <div id="rr" class="trend-line" style="color:#818cf8">--</div>
            <div class="sub-box">
                <span>Peak Rate: <b id="mr">--</b></span><span>Status: <b id="rs">--</b></span>
            </div>
        </div>
    </div>

    <div class="graphs-title">Historical Insights</div>
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
            const gradient = ctx.createLinearGradient(0, 0, 0, 300);
            gradient.addColorStop(0, col + '44');
            gradient.addColorStop(1, col + '00');

            return new Chart(ctx, {
                type: 'line',
                data: { labels: [], datasets: [{ label: label, data: [], borderColor: col, tension: 0.4, pointRadius: 0, borderWidth: 3, fill: true, backgroundColor: gradient }]},
                options: { 
                    responsive: true, maintainAspectRatio: false, 
                    plugins: { legend: { display: true, labels: {color: '#94a3b8', font: {size: 12, weight: 'bold'}} } },
                    scales: { 
                        x: { ticks: { color: '#475569', font: { size: 10 } }, grid: { display: false } }, 
                        y: { beginAtZero: minZero, min: minZero ? 0 : undefined, ticks: { color: '#475569' }, grid: { color: '#1e293b' } } 
                    }
                }
            });
        }

        async function update() {
            try {
                const res = await fetch('/weather?v=' + Date.now());
                const d = await res.json();
                
                // Temp
                document.getElementById('t').innerText = d.temp.current + '°';
                const tr = document.getElementById('tr');
                const symbol = d.temp.trend > 0 ? '▲' : d.temp.trend < 0 ? '▼' : '●';
                tr.innerHTML = '<span>Temperature Trend: </span> <span style="color:' + (d.temp.trend >= 0 ? '#f87171' : '#22c55e') + '">' + symbol + ' ' + Math.abs(d.temp.trend) + '°C/hr</span>';
                document.getElementById('mx').innerText = d.temp.max + '°';
                document.getElementById('mn').innerText = d.temp.min + '°';

                // Hum
                document.getElementById('h').innerText = d.atmo.hum + '%';
                document.getElementById('dp').innerText = d.atmo.dew + '°';
                document.getElementById('pr').innerText = d.atmo.press + ' hPa';

                // Wind
                document.getElementById('w').innerText = d.wind.speed + ' km/h';
                document.getElementById('wg').innerText = 'Gust: ' + d.wind.gust + ' km/h (' + d.wind.card + ')';
                document.getElementById('mw').innerText = d.wind.maxS + ' km/h';
                document.getElementById('mg').innerText = d.wind.maxG + ' km/h';

                // Rain
                document.getElementById('r').innerText = d.rain.total + ' mm';
                document.getElementById('rr').innerText = 'Rate: ' + d.rain.rate + ' mm/h';
                document.getElementById('mr').innerText = d.rain.maxR + ' mm/h';
                document.getElementById('rs').innerText = d.rain.rate > 0 ? 'Raining' : 'Dry';

                // Header Time
                document.getElementById('ts').innerText = new Date(d.lastSync).toLocaleTimeString('en-IN', {hour12: false});

                // Charts
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
