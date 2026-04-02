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
        if (state.todayHistory.length > 250) state.todayHistory.shift();

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
    <title>KK Nagar Weather Station</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root { --bg: #0b0f1a; --card: #161e31; --accent: #38bdf8; }
        body { margin:0; font-family: 'Segoe UI', sans-serif; background: var(--bg); color: #f1f5f9; padding: 20px; }
        .header { text-align: center; margin-bottom: 30px; }
        .header h1 { margin: 0; font-size: 22px; letter-spacing: 2px; font-weight: 800; }
        .live-indicator { display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 10px; font-size: 16px; font-weight: 600; }
        .dot { width: 10px; height: 10px; background: #4ade80; border-radius: 50%; box-shadow: 0 0 12px #4ade80; animation: pulse 2s infinite; }
        @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.3; } 100% { opacity: 1; } }
        
        .readings-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 15px; margin-bottom: 40px; }
        .card { background: var(--card); padding: 22px; border-radius: 18px; border: 1px solid #ffffff0a; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.3); }
        .label { color: var(--accent); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 8px; }
        .main-val { font-size: 52px; font-weight: 800; margin: 5px 0; letter-spacing: -2px; }
        .trend-line { font-size: 15px; font-weight: 600; margin-bottom: 18px; display: flex; align-items: center; gap: 5px; }
        .sub-box { display: grid; grid-template-columns: 1fr 1fr; font-size: 14px; gap: 10px; padding-top: 15px; border-top: 1px solid #ffffff10; opacity: 0.9; }
        
        .graphs-title { font-size: 16px; font-weight: 800; margin-bottom: 20px; letter-spacing: 1px; color: #64748b; text-align: center; border-bottom: 1px solid #334155; padding-bottom: 10px; }
        .graphs-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 20px; }
        .graph-card { background: var(--card); padding: 15px; border-radius: 18px; height: 260px; border: 1px solid #ffffff0a; }
        @media (max-width: 500px) { .graphs-grid { grid-template-columns: 1fr; } .main-val { font-size: 42px; } }
    </style>
</head>
<body>
    <div class="header">
        <h1>KK NAGAR WEATHER STATION LIVE</h1>
        <div class="live-indicator"><div class="dot"></div> <span id="ts">--:--:--</span></div>
    </div>

    <div class="readings-grid">
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
            <div class="trend-line" style="color:#4ade80">Atmospheric Stability: Normal</div>
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
                <span>Max Rate: <b id="mr">--</b></span><span>Status: <b id="rs">--</b></span>
            </div>
        </div>
    </div>

    <div class="graphs-title">HISTORICAL TRENDS</div>
    <div class="graphs-grid">
        <div class="graph-card"><canvas id="cT"></canvas></div>
        <div class="graph-card"><canvas id="cH"></canvas></div>
        <div class="graph-card"><canvas id="cW"></canvas></div>
        <div class="graph-card"><canvas id="cR"></canvas></div>
    </div>

    <script>
        let charts = {};
        function setupChart(id, label, col, minZero = false) {
            return new Chart(document.getElementById(id), {
                type: 'line',
                data: { labels: [], datasets: [{ label: label, data: [], borderColor: col, tension: 0.4, pointRadius: 0, borderWidth: 2.5, fill: true, backgroundColor: col + '05' }]},
                options: { 
                    responsive: true, maintainAspectRatio: false, 
                    plugins: { legend: { display: true, labels: {color: '#94a3b8', font: {size: 11, weight: 'bold'}} } },
                    scales: { 
                        x: { ticks: { color: '#475569', font: { size: 10 }, autoSkip: true, maxTicksLimit: 6 }, grid: { display: false } }, 
                        y: { 
                            beginAtZero: minZero, 
                            min: minZero ? 0 : undefined,
                            ticks: { color: '#475569' }, 
                            grid: { color: '#ffffff03' } 
                        } 
                    }
                }
            });
        }

        async function update() {
            try {
                const res = await fetch('/weather?v=' + Date.now());
                const d = await res.json();
                
                document.getElementById('t').innerText = d.temp.current + '°C';
                const tr = document.getElementById('tr');
                const symbol = d.temp.trend > 0 ? '▲' : d.temp.trend < 0 ? '▼' : '●';
                tr.innerHTML = '<span>Temperature Trend: </span> <span style="color:' + (d.temp.trend >= 0 ? '#f87171' : '#4ade80') + '">' + symbol + ' ' + Math.abs(d.temp.trend) + '°C/hr</span>';
                
                document.getElementById('mx').innerText = d.temp.max + '°C';
                document.getElementById('mn').innerText = d.temp.min + '°C';

                document.getElementById('h').innerText = d.atmo.hum + '%';
                document.getElementById('dp').innerText = d.atmo.dew + '°C';
                document.getElementById('pr').innerText = d.atmo.press + ' hPa';

                document.getElementById('w').innerText = d.wind.speed + ' km/h';
                document.getElementById('wg').innerText = 'Gust: ' + d.wind.gust + ' km/h (' + d.wind.card + ')';
                document.getElementById('mw').innerText = d.wind.maxS + ' km/h';
                document.getElementById('mg').innerText = d.wind.maxG + ' km/h';

                document.getElementById('r').innerText = d.rain.total + ' mm';
                document.getElementById('rr').innerText = 'Current Rate: ' + d.rain.rate + ' mm/h';
                document.getElementById('mr').innerText = d.rain.maxR + ' mm/h';
                document.getElementById('rs').innerText = d.rain.rate > 0 ? 'Raining' : 'Dry';

                document.getElementById('ts').innerText = new Date(d.lastSync).toLocaleTimeString('en-IN', {hour: '2-digit', minute:'2-digit', second:'2-digit'});

                const lbls = d.history.map(h => new Date(h.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }));
                if (!charts.cT) {
                    charts.cT = setupChart('cT', 'Temperature °C', '#38bdf8', false); // Temp can be negative
                    charts.cH = setupChart('cH', 'Humidity %', '#4ade80', true);     // Humidity cannot be negative
                    charts.cW = setupChart('cW', 'Wind Speed km/h', '#fb923c', true); // Wind cannot be negative
                    charts.cR = setupChart('cR', 'Rain Rate mm/h', '#818cf8', true);  // Rain cannot be negative
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
