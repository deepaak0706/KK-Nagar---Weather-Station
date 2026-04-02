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
    lastFetchTime: 0,
    currentDate: new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })
};

const getCard = (a) => ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"][Math.round(a/22.5)%16];

async function syncWithEcowitt() {
    const now = Date.now();
    if (state.cachedData && (now - state.lastFetchTime < 45000)) return state.cachedData;

    try {
        const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}`;
        const response = await fetch(url);
        const json = await response.json();
        const d = json.data;

        const tempC = parseFloat(((d.outdoor.temperature.value - 32) * 5 / 9).toFixed(1));
        const rainRate = parseFloat((d.rainfall.rain_rate.value * 25.4).toFixed(1));
        const windKmh = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));

        if (tempC > state.maxTemp || state.maxTemp === -999) state.maxTemp = tempC;
        if (tempC < state.minTemp || state.minTemp === 999) state.minTemp = tempC;

        state.todayHistory.push({ time: new Date().toISOString(), temp: tempC, hum: d.outdoor.humidity.value, wind: windKmh, rain: rainRate });
        if (state.todayHistory.length > 500) state.todayHistory.shift();

        state.cachedData = {
            temp: { current: tempC, max: state.maxTemp, min: state.minTemp, feels: ((d.outdoor.feels_like.value - 32) * 5 / 9).toFixed(1) },
            wind: { speed: windKmh, deg: d.wind.wind_direction.value, card: getCard(d.wind.wind_direction.value) },
            atmo: { hum: d.outdoor.humidity.value, press: (d.pressure.relative.value * 33.8639).toFixed(1), uv: d.solar_and_uvi.uvi.value },
            rain: { total: (d.rainfall.daily.value * 25.4).toFixed(1), rate: rainRate },
            history: state.todayHistory,
            lastSync: new Date().toISOString()
        };
        state.lastFetchTime = now;
        return state.cachedData;
    } catch (e) { return state.cachedData || { error: "Offline" }; }
}

app.get("/weather", async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await syncWithEcowitt());
});

app.get("/", (req, res) => {
    res.send(`<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>KK Nagar Weather Pro</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root { --bg: #0b0f1a; --card: #172035; --accent: #38bdf8; }
        body { margin:0; font-family: sans-serif; background: var(--bg); color: #f1f5f9; padding: 15px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 15px; }
        .card { background: var(--card); padding: 20px; border-radius: 12px; border: 1px solid #ffffff10; }
        .label { color: var(--accent); font-size: 11px; font-weight: bold; text-transform: uppercase; margin-bottom: 5px; }
        .val { font-size: 32px; font-weight: 800; margin: 5px 0; }
        .sub-grid { display: grid; grid-template-columns: 1fr 1fr; font-size: 12px; opacity: 0.8; border-top: 1px solid #ffffff10; padding-top: 10px; margin-top: 5px; }
        .chart-box { height: 180px; margin-top: 15px; }
        #status { text-align: center; font-size: 12px; margin-bottom: 15px; color: #4ade80; }
    </style>
</head>
<body>
    <div id="status">Connecting...</div>
    <div class="grid">
        <div class="card"><div class="label">Temperature</div><div id="t" class="val">--</div><div class="sub-grid"><span>Max: <b id="mx">--</b></span><span>Min: <b id="mn">--</b></span></div><div class="chart-box"><canvas id="cT"></canvas></div></div>
        <div class="card"><div class="label">Wind</div><div id="w" class="val">--</div><div class="sub-grid"><span id="wd">--</span><span id="wg">--</span></div><div class="chart-box"><canvas id="cW"></canvas></div></div>
        <div class="card"><div class="label">Humidity & UV</div><div id="h" class="val">--</div><div class="sub-grid"><span>Press: <b id="p">--</b></span><span>UV: <b id="uv">--</b></span></div><div class="chart-box"><canvas id="cH"></canvas></div></div>
        <div class="card"><div class="label">Rainfall</div><div id="r" class="val">--</div><div class="sub-grid"><span>Rate: <b id="rr">--</b></span><span>Day: <b id="rd">--</b></span></div><div class="chart-box"><canvas id="cR"></canvas></div></div>
    </div>

    <script>
        let charts = {};
        function initChart(id, label, color) {
            return new Chart(document.getElementById(id), {
                type: 'line',
                data: { labels: [], datasets: [{ label: label, data: [], borderColor: color, tension: 0.3, pointRadius: 0, borderWidth: 2 }]},
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { ticks: { display: false }, grid: { display: false } } } }
            });
        }

        async function update() {
            try {
                const res = await fetch('/weather?t=' + Date.now());
                const d = await res.json();
                document.getElementById('t').innerText = d.temp.current + '°C';
                document.getElementById('mx').innerText = d.temp.max;
                document.getElementById('mn').innerText = d.temp.min;
                document.getElementById('w').innerText = d.wind.speed + ' km/h';
                document.getElementById('wd').innerText = d.wind.card;
                document.getElementById('h').innerText = d.atmo.hum + '%';
                document.getElementById('p').innerText = d.atmo.press;
                document.getElementById('uv').innerText = d.atmo.uv;
                document.getElementById('r').innerText = d.rain.total + ' mm';
                document.getElementById('rr').innerText = d.rain.rate;
                document.getElementById('status').innerText = '🟢 Live: ' + new Date(d.lastSync).toLocaleTimeString();

                const times = d.history.map(h => '');
                if (!charts.cT) {
                    charts.cT = initChart('cT', 'Temp', '#38bdf8');
                    charts.cW = initChart('cW', 'Wind', '#fb923c');
                    charts.cH = initChart('cH', 'Hum', '#4ade80');
                    charts.cR = initChart('cR', 'Rain', '#818cf8');
                }
                charts.cT.data.labels = times; charts.cT.data.datasets[0].data = d.history.map(h=>h.temp); charts.cT.update('none');
                charts.cW.data.labels = times; charts.cW.data.datasets[0].data = d.history.map(h=>h.wind); charts.cW.update('none');
                charts.cH.data.labels = times; charts.cH.data.datasets[0].data = d.history.map(h=>h.hum); charts.cH.update('none');
                charts.cR.data.labels = times; charts.cR.data.datasets[0].data = d.history.map(h=>h.rain); charts.cR.update('none');
            } catch(e) {}
        }
        setInterval(update, 45000);
        update();
    </script>
</body>
</html>`);
});

module.exports = app;
