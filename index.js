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
        const rainRate = parseFloat((d.rainfall.rain_rate.value * 25.4).toFixed(1));
        const windKmh = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));
        const gustKmh = parseFloat((d.wind.wind_gust.value * 1.60934).toFixed(1));

        if (tempC > state.maxTemp || state.maxTemp === -999) state.maxTemp = tempC;
        if (tempC < state.minTemp || state.minTemp === 999) state.minTemp = tempC;
        if (windKmh > state.maxWindSpeed) state.maxWindSpeed = windKmh;
        if (gustKmh > state.maxGust) state.maxGust = gustKmh;
        if (rainRate > state.maxRainRate) state.maxRainRate = rainRate;

        state.todayHistory.push({ 
            time: new Date().toISOString(), 
            temp: tempC, 
            hum: d.outdoor.humidity.value, 
            wind: windKmh, 
            rain: rainRate 
        });
        if (state.todayHistory.length > 150) state.todayHistory.shift();

        state.cachedData = {
            temp: { current: tempC, max: state.maxTemp, min: state.minTemp, feels: ((d.outdoor.feels_like.value - 32) * 5 / 9).toFixed(1) },
            wind: { speed: windKmh, gust: gustKmh, maxSpeed: state.maxWindSpeed, maxGust: state.maxGust, card: getCard(d.wind.wind_direction.value) },
            atmo: { hum: d.outdoor.humidity.value, press: (d.pressure.relative.value * 33.8639).toFixed(1), uv: d.solar_and_uvi.uvi.value, solar: d.solar_and_uvi.solar.value },
            rain: { total: (d.rainfall.daily.value * 25.4).toFixed(1), rate: rainRate, maxRate: state.maxRainRate },
            history: state.todayHistory,
            lastSync: new Date().toISOString()
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
        :root { --bg: #0b0f1a; --card: #161e31; --accent: #38bdf8; }
        body { margin:0; font-family: 'Inter', sans-serif; background: var(--bg); color: #f1f5f9; padding: 15px; }
        .header { display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 20px; }
        .dot { width: 10px; height: 10px; background: #4ade80; border-radius: 50%; box-shadow: 0 0 8px #4ade80; animation: blink 2s infinite; }
        @keyframes blink { 0% { opacity: 1; } 50% { opacity: 0.4; } 100% { opacity: 1; } }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 15px; max-width: 1400px; margin: 0 auto; }
        .card { background: var(--card); padding: 18px; border-radius: 14px; border: 1px solid #ffffff0a; height: 340px; display: flex; flex-direction: column; }
        .label { color: var(--accent); font-size: 11px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px; }
        .val { font-size: 34px; font-weight: 800; margin: 8px 0; }
        .sub-grid { display: grid; grid-template-columns: 1fr 1fr; font-size: 12px; opacity: 0.7; border-bottom: 1px solid #ffffff10; padding-bottom: 10px; margin-bottom: 10px; }
        .chart-box { flex-grow: 1; position: relative; }
        #timestamp { font-size: 13px; opacity: 0.8; }
    </style>
</head>
<body>
    <div class="header">
        <div class="dot"></div>
        <div id="timestamp">Syncing...</div>
    </div>

    <div class="grid">
        <div class="card">
            <div class="label">Temperature</div>
            <div id="t" class="val">--</div>
            <div class="sub-grid"><span>High: <b id="mx">--</b></span><span>Low: <b id="mn">--</b></span><span>Feels: <b id="fl">--</b></span></div>
            <div class="chart-box"><canvas id="cT"></canvas></div>
        </div>
        <div class="card">
            <div class="label">Wind Speed</div>
            <div id="w" class="val">--</div>
            <div class="sub-grid"><span>Gust: <b id="wg">--</b></span><span>Max: <b id="mxw">--</b></span><span id="wd">--</span></div>
            <div class="chart-box"><canvas id="cW"></canvas></div>
        </div>
        <div class="card">
            <div class="label">Atmosphere</div>
            <div id="h" class="val">--</div>
            <div class="sub-grid"><span>UV: <b id="uv">--</b></span><span>Solar: <b id="sol">--</b></span><span>Press: <b id="p">--</b></span></div>
            <div class="chart-box"><canvas id="cH"></canvas></div>
        </div>
        <div class="card">
            <div class="label">Rainfall</div>
            <div id="r" class="val">--</div>
            <div class="sub-grid"><span>Rate: <b id="rr">--</b></span><span>Peak: <b id="mxr">--</b></span><span id="rst">--</span></div>
            <div class="chart-box"><canvas id="cR"></canvas></div>
        </div>
    </div>

    <script>
        let charts = {};
        function makeChart(id, color) {
            return new Chart(document.getElementById(id), {
                type: 'line',
                data: { labels: [], datasets: [{ data: [], borderColor: color, tension: 0.4, pointRadius: 0, borderWidth: 2, fill: true, backgroundColor: color + '08' }]},
                options: { 
                    responsive: true, maintainAspectRatio: false, 
                    plugins: { legend: { display: false } },
                    scales: { 
                        x: { ticks: { color: '#64748b', font: { size: 9 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 5 }, grid: { display: false } }, 
                        y: { ticks: { display: false }, grid: { color: '#ffffff05' } } 
                    }
                }
            });
        }

        async function update() {
            try {
                const res = await fetch('/weather?v=' + Date.now());
                const d = await res.json();
                
                document.getElementById('t').innerText = d.temp.current + '°C';
                document.getElementById('mx').innerText = d.temp.max + '°';
                document.getElementById('mn').innerText = d.temp.min + '°';
                document.getElementById('fl').innerText = d.temp.feels + '°';
                document.getElementById('w').innerText = d.wind.speed + ' km/h';
                document.getElementById('mxw').innerText = d.wind.maxSpeed;
                document.getElementById('wg').innerText = d.wind.gust;
                document.getElementById('wd').innerText = d.wind.card;
                document.getElementById('h').innerText = d.atmo.hum + '%';
                document.getElementById('uv').innerText = d.atmo.uv;
                document.getElementById('sol').innerText = d.atmo.solar + ' W/m²';
                document.getElementById('p').innerText = d.atmo.press + ' hPa';
                document.getElementById('r').innerText = d.rain.total + ' mm';
                document.getElementById('rr').innerText = d.rain.rate + ' mm/h';
                document.getElementById('mxr').innerText = d.rain.maxRate;
                document.getElementById('rst').innerText = d.rain.rate > 0 ? 'Raining' : 'Dry';
                document.getElementById('timestamp').innerText = new Date(d.lastSync).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

                if (!charts.cT) {
                    charts.cT = makeChart('cT', '#38bdf8');
                    charts.cW = makeChart('cW', '#fb923c');
                    charts.cH = makeChart('cH', '#4ade80');
                    charts.cR = makeChart('cR', '#818cf8');
                }

                // Restore Timings on X-Axis
                const lbls = d.history.map(h => new Date(h.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }));
                charts.cT.data.labels = lbls; charts.cT.data.datasets[0].data = d.history.map(h=>h.temp); charts.cT.update('none');
                charts.cW.data.labels = lbls; charts.cW.data.datasets[0].data = d.history.map(h=>h.wind); charts.cW.update('none');
                charts.cH.data.labels = lbls; charts.cH.data.datasets[0].data = d.history.map(h=>h.hum); charts.cH.update('none');
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
