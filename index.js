const express = require("express");
const fetch = require("node-fetch");
const app = express();

const APPLICATION_KEY = process.env.APPLICATION_KEY;
const API_KEY = process.env.API_KEY;
const MAC = process.env.MAC;

// In-Memory State
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

    const todayStr = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
    if (todayStr !== state.currentDate) {
        state = { todayHistory: [], maxTemp: -999, minTemp: 999, maxWindSpeed: 0, maxGust: 0, maxRainRate: 0, currentDate: todayStr, lastFetchTime: 0 };
    }

    try {
        const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}`;
        const response = await fetch(url);
        const json = await response.json();
        const d = json.data;

        // Conversions
        const tempC = parseFloat(((d.outdoor.temperature.value - 32) * 5 / 9).toFixed(1));
        const feelsC = parseFloat(((d.outdoor.feels_like.value - 32) * 5 / 9).toFixed(1));
        const rainRate = parseFloat((d.rainfall.rain_rate.value * 25.4).toFixed(1));
        const dailyRain = parseFloat((d.rainfall.daily.value * 25.4).toFixed(1));
        const windKmh = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));
        const gustKmh = parseFloat((d.wind.wind_gust.value * 1.60934).toFixed(1));

        // Update Max Records
        if (tempC > state.maxTemp || state.maxTemp === -999) state.maxTemp = tempC;
        if (tempC < state.minTemp || state.minTemp === 999) state.minTemp = tempC;
        if (windKmh > state.maxWindSpeed) state.maxWindSpeed = windKmh;
        if (gustKmh > state.maxGust) state.maxGust = gustKmh;
        if (rainRate > state.maxRainRate) state.maxRainRate = rainRate;

        // Calculate Trend (Compare current to 1 hour ago / ~80 readings ago)
        let trend = 0;
        if (state.todayHistory.length > 10) {
            const oldTemp = state.todayHistory[state.todayHistory.length - 10].temp;
            trend = parseFloat((tempC - oldTemp).toFixed(1));
        }

        state.todayHistory.push({ time: new Date().toISOString(), temp: tempC, hum: d.outdoor.humidity.value, wind: windKmh, rain: rainRate });
        if (state.todayHistory.length > 1000) state.todayHistory.shift();

        state.cachedData = {
            temp: { current: tempC, max: state.maxTemp, min: state.minTemp, feels: feelsC, trend: trend },
            wind: { speed: windKmh, gust: gustKmh, maxSpeed: state.maxWindSpeed, maxGust: state.maxGust, card: getCard(d.wind.wind_direction.value) },
            atmo: { hum: d.outdoor.humidity.value, press: (d.pressure.relative.value * 33.8639).toFixed(1), uv: d.solar_and_uvi.uvi.value, solar: d.solar_and_uvi.solar.value },
            rain: { total: dailyRain, rate: rainRate, maxRate: state.maxRainRate },
            history: state.todayHistory,
            lastSync: new Date().toISOString()
        };
        state.lastFetchTime = now;
        return state.cachedData;
    } catch (e) { return state.cachedData || { error: "Offline" }; }
}

app.get("/weather", async (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.json(await syncWithEcowitt());
});

app.get("/", (req, res) => {
    res.send(`<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>KK Nagar Weather Station Pro</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root { --bg: #0b0f1a; --card: #172035; --accent: #38bdf8; }
        body { margin:0; font-family: 'Segoe UI', sans-serif; background: var(--bg); color: #f1f5f9; padding: 15px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 15px; }
        .card { background: var(--card); padding: 20px; border-radius: 12px; border: 1px solid #ffffff10; display: flex; flex-direction: column; justify-content: space-between; }
        .label { color: var(--accent); font-size: 11px; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; }
        .val { font-size: 36px; font-weight: 800; margin: 10px 0; letter-spacing: -1px; }
        .sub-data { display: grid; grid-template-columns: 1fr 1fr; font-size: 12px; gap: 5px; border-top: 1px solid #ffffff08; padding-top: 10px; margin-top: 10px; }
        .chart-box { height: 150px; margin-top: 15px; width: 100%; }
        #status { text-align: center; font-size: 11px; margin-bottom: 15px; color: #4ade80; background: #4ade8010; padding: 5px; border-radius: 5px; }
        .trend-up { color: #f87171; } .trend-down { color: #4ade80; }
    </style>
</head>
<body>
    <div id="status">Syncing Sensors...</div>
    <div class="grid">
        <div class="card">
            <div>
                <div class="label">Temperature</div>
                <div id="t" class="val">--</div>
                <div id="trend" style="font-size:13px; font-weight:bold;">--</div>
            </div>
            <div class="sub-data">
                <span>Max: <b id="mx">--</b></span><span>Min: <b id="mn">--</b></span>
                <span>Feels: <b id="fl">--</b></span><span>Unit: <b>Celsius</b></span>
            </div>
            <div class="chart-box"><canvas id="cT"></canvas></div>
        </div>

        <div class="card">
            <div>
                <div class="label">Wind Speed</div>
                <div id="w" class="val">--</div>
                <div id="wd" style="font-size:13px; font-weight:bold; color:var(--accent);">--</div>
            </div>
            <div class="sub-data">
                <span>Gust: <b id="wg">--</b></span><span>Max Gust: <b id="mxg">--</b></span>
                <span>Max Wind: <b id="mxw">--</b></span><span>Status: <b>Live</b></span>
            </div>
            <div class="chart-box"><canvas id="cW"></canvas></div>
        </div>

        <div class="card">
            <div>
                <div class="label">Atmosphere</div>
                <div id="h" class="val">--</div>
                <div id="sol" style="font-size:13px; font-weight:bold; color:#fbbf24;">--</div>
            </div>
            <div class="sub-data">
                <span>UV Index: <b id="uv">--</b></span><span>Pressure: <b id="p">--</b></span>
                <span>Humidity: <b id="hu">--</b></span><span>Location: <b>KK Nagar</b></span>
            </div>
            <div class="chart-box"><canvas id="cH"></canvas></div>
        </div>

        <div class="card">
            <div>
                <div class="label">Precipitation</div>
                <div id="r" class="val">--</div>
                <div id="rr" style="font-size:13px; font-weight:bold; color:#818cf8;">--</div>
            </div>
            <div class="sub-data">
                <span>Daily Total: <b id="rd">--</b></span><span>Max Rate: <b id="mxr">--</b></span>
                <span>Status: <b id="rst">--</b></span><span>Type: <b>Rain</b></span>
            </div>
            <div class="chart-box"><canvas id="cR"></canvas></div>
        </div>
    </div>

    <script>
        let charts = {};
        function initChart(id, color) {
            return new Chart(document.getElementById(id), {
                type: 'line',
                data: { labels: [], datasets: [{ data: [], borderColor: color, tension: 0.4, pointRadius: 0, borderWidth: 2 }]},
                options: { 
                    responsive: true, maintainAspectRatio: false, 
                    plugins: { legend: { display: false } },
                    scales: { x: { display: false }, y: { display: false } }
                }
            });
        }

        async function update() {
            try {
                const res = await fetch('/weather?v=' + Date.now());
                const d = await res.json();
                
                // Temp
                document.getElementById('t').innerText = d.temp.current + '°C';
                document.getElementById('mx').innerText = d.temp.max + '°';
                document.getElementById('mn').innerText = d.temp.min + '°';
                document.getElementById('fl').innerText = d.temp.feels + '°';
                const trendEl = document.getElementById('trend');
                trendEl.innerText = (d.temp.trend >= 0 ? '↑ ' : '↓ ') + Math.abs(d.temp.trend) + '°C/hr';
                trendEl.className = d.temp.trend >= 0 ? 'trend-up' : 'trend-down';

                // Wind
                document.getElementById('w').innerText = d.wind.speed + ' km/h';
                document.getElementById('wd').innerText = 'Heading ' + d.wind.card;
                document.getElementById('wg').innerText = d.wind.gust + ' km/h';
                document.getElementById('mxw').innerText = d.wind.maxSpeed + ' km/h';
                document.getElementById('mxg').innerText = d.wind.maxGust + ' km/h';

                // Atmo
                document.getElementById('h').innerText = d.atmo.hum + '%';
                document.getElementById('hu').innerText = d.atmo.hum + '%';
                document.getElementById('sol').innerText = 'Solar: ' + d.atmo.solar + ' W/m²';
                document.getElementById('uv').innerText = d.atmo.uv;
                document.getElementById('p').innerText = d.atmo.press + ' hPa';

                // Rain
                document.getElementById('r').innerText = d.rain.total + ' mm';
                document.getElementById('rd').innerText = d.rain.total + ' mm';
                document.getElementById('rr').innerText = 'Rate: ' + d.rain.rate + ' mm/h';
                document.getElementById('mxr').innerText = d.rain.maxRate + ' mm/h';
                document.getElementById('rst').innerText = d.rain.rate > 0 ? 'Raining' : 'Dry';

                document.getElementById('status').innerText = '🟢 AUTO-SYNC ACTIVE: ' + new Date(d.lastSync).toLocaleTimeString('en-IN');

                const times = d.history.map(h => '');
                if (!charts.cT) {
                    charts.cT = initChart('cT', '#38bdf8');
                    charts.cW = initChart('cW', '#fb923c');
                    charts.cH = initChart('cH', '#4ade80');
                    charts.cR = initChart('cR', '#818cf8');
                }
                charts.cT.data.labels = times; charts.cT.data.datasets[0].data = d.history.map(h=>h.temp); charts.cT.update('none');
                charts.cW.data.labels = times; charts.cW.data.datasets[0].data = d.history.map(h=>h.wind); charts.cW.update('none');
                charts.cH.data.labels = times; charts.cH.data.datasets[0].data = d.history.map(h=>h.hum); charts.cH.update('none');
                charts.cR.data.labels = times; charts.cR.data.datasets[0].data = d.history.map(h=>h.rain); charts.cR.update('none');
            } catch(e) { console.log("Sync Error", e); }
        }
        setInterval(update, 45000);
        update();
    </script>
</body>
</html>`);
});

module.exports = app;
