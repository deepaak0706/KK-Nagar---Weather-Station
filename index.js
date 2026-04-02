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
        if (state.todayHistory.length > 200) state.todayHistory.shift();

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
        .header h1 { margin: 0; font-size: 24px; letter-spacing: 1px; }
        .live-indicator { display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 10px; font-size: 14px; opacity: 0.8; }
        .dot { width: 8px; height: 8px; background: #4ade80; border-radius: 50%; box-shadow: 0 0 10px #4ade80; }
        
        /* Section 1: Readings */
        .readings-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 15px; margin-bottom: 40px; }
        .card { background: var(--card); padding: 20px; border-radius: 16px; border: 1px solid #ffffff0a; }
        .label { color: var(--accent); font-size: 12px; font-weight: 700; text-transform: uppercase; margin-bottom: 10px; }
        .main-val { font-size: 48px; font-weight: 800; margin: 5px 0; }
        .trend { font-size: 14px; font-weight: 600; margin-bottom: 15px; }
        .sub-box { display: grid; grid-template-columns: 1fr 1fr; font-size: 14px; gap: 10px; padding-top: 15px; border-top: 1px solid #ffffff10; }
        
        /* Section 2: Graphs */
        .graphs-title { font-size: 18px; font-weight: 700; margin-bottom: 20px; border-left: 4px solid var(--accent); padding-left: 15px; }
        .graphs-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(450px, 1fr)); gap: 20px; }
        .graph-card { background: var(--card); padding: 15px; border-radius: 16px; height: 250px; border: 1px solid #ffffff0a; }
        @media (max-width: 500px) { .graphs-grid { grid-template-columns: 1fr; } }
    </style>
</head>
<body>
    <div class="header">
        <h1>KK NAGAR WEATHER STATION LIVE</h1>
        <div class="live-indicator"><div class="dot"></div> <span id="ts">Initializing...</span></div>
    </div>

    <div class="readings-grid">
        <div class="card">
            <div class="label">Temperature</div>
            <div id="t" class="main-val">--</div>
            <div id="tr" class="trend">--</div>
            <div class="sub-box">
                <span>Daily Max: <b id="mx">--</b></span><span>Daily Min: <b id="mn">--</b></span>
            </div>
        </div>

        <div class="card">
            <div class="label">Humidity & Dew Point</div>
            <div id="h" class="main-val">--</div>
            <div class="trend" style="color:#4ade80">Atmospheric Stability: Normal</div>
            <div class="sub-box">
                <span>Dew Point: <b id="dp">--</b></span><span>Pressure: <b id="pr">--</b></span>
            </div>
        </div>

        <div class="card">
            <div class="label">Wind Conditions</div>
            <div id="w" class="main-val">--</div>
            <div id="wg" class="trend" style="color:var(--accent)">--</div>
            <div class="sub-box">
                <span>Max Speed: <b id="mw">--</b></span><span>Max Gust: <b id="mg">--</b></span>
            </div>
        </div>

        <div class="card">
            <div class="label">Rainfall (24h)</div>
            <div id="r" class="main-val">--</div>
            <div id="rr" class="trend" style="color:#818cf8">--</div>
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
        function setupChart(id, label, col) {
            return new Chart(document.getElementById(id), {
                type: 'line',
                data: { labels: [], datasets: [{ label: label, data: [], borderColor: col, tension: 0.4, pointRadius: 0, borderWidth: 2, fill: true, backgroundColor: col + '05' }]},
                options: { 
                    responsive: true, maintainAspectRatio: false, 
                    plugins: { legend: { display: true, labels: {color: '#fff', size: 10} } },
                    scales: { 
                        x: { ticks: { color: '#64748b', font: { size: 10 }, autoSkip: true, maxTicksLimit: 8 }, grid: { display: false } }, 
                        y: { ticks: { color: '#64748b' }, grid: { color: '#ffffff05' } } 
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
                tr.innerText = 'Rate of Change: ' + (d.temp.trend >= 0 ? '+' : '') + d.temp.trend + '°C/hr';
                tr.style.color = d.temp.trend >= 0 ? '#f87171' : '#4ade80';
                document.getElementById('mx').innerText = d.temp.max + '°C';
                document.getElementById('mn').innerText = d.temp.min + '°C';

                document.getElementById('h').innerText = d.atmo.hum + '%';
                document.getElementById('dp').innerText = d.atmo.dew + '°C';
                document.getElementById('pr').innerText = d.atmo.press + ' hPa';

                document.getElementById('w').innerText = d.wind.speed + ' km/h';
                document.getElementById('wg').innerText = 'Gusting: ' + d.wind.gust + ' km/h (' + d.wind.card + ')';
                document.getElementById('mw').innerText = d.wind.maxS + ' km/h';
                document.getElementById('mg').innerText = d.wind.maxG + ' km/h';

                document.getElementById('r').innerText = d.rain.total + ' mm';
                document.getElementById('rr').innerText = 'Current Rate: ' + d.rain.rate + ' mm/h';
                document.getElementById('mr').innerText = d.rain.maxR + ' mm/h';
                document.getElementById('rs').innerText = d.rain.rate > 0 ? 'Raining' : 'Dry';

                document.getElementById('ts').innerText = 'LAST SYNC: ' + new Date(d.lastSync).toLocaleTimeString('en-IN');

                const lbls = d.history.map(h => new Date(h.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }));
                if (!charts.cT) {
                    charts.cT = setupChart('cT', 'Temp °C', '#38bdf8');
                    charts.cH = setupChart('cH', 'Humidity %', '#4ade80');
                    charts.cW = setupChart('cW', 'Wind km/h', '#fb923c');
                    charts.cR = setupChart('cR', 'Rain mm/h', '#818cf8');
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
