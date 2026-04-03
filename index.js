const express = require("express");
const fetch = require("node-fetch");
const fs = require("fs");
const app = express();

const APPLICATION_KEY = process.env.APPLICATION_KEY;
const API_KEY = process.env.API_KEY;
const MAC = process.env.MAC;
const STORAGE_FILE = "/tmp/weather_stats.json";

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

if (fs.existsSync(STORAGE_FILE)) {
    try {
        const saved = JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf-8'));
        if (saved.currentDate === state.currentDate) {
            Object.assign(state, saved);
        }
    } catch (e) {}
}

function saveToDisk() {
    try {
        fs.writeFileSync(STORAGE_FILE, JSON.stringify({
            currentDate: state.currentDate,
            maxTemp: state.maxTemp, minTemp: state.minTemp,
            maxWindSpeed: state.maxWindSpeed, maxGust: state.maxGust, maxRainRate: state.maxRainRate
        }), 'utf-8');
    } catch (e) {}
}

const getCard = (a) => ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"][Math.round(a / 22.5) % 16];

async function syncWithEcowitt() {
    const now = Date.now();
    if (state.cachedData && (now - state.lastFetchTime < 35000)) return state.cachedData;

    try {
        const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}`;
        const response = await fetch(url);
        const json = await response.json();
        const d = json.data;

        const tempC = parseFloat(((d.outdoor.temperature.value - 32) * 5 / 9).toFixed(1));
        const hum = d.outdoor.humidity.value;
        const dailyRain = parseFloat((d.rainfall.daily.value * 25.4).toFixed(1));
        const pressure = parseFloat((d.pressure.relative.value * 33.8639).toFixed(1));
        
        let instantRR = 0;
        if (state.todayHistory.length > 0) {
            const oneMinAgo = now - 75000; 
            const pastRecord = state.todayHistory.find(h => new Date(h.time).getTime() >= oneMinAgo);
            if (pastRecord && dailyRain > pastRecord.rainTotal) {
                instantRR = parseFloat((((dailyRain - pastRecord.rainTotal) / ((now - new Date(pastRecord.time).getTime()) / 60000)) * 60).toFixed(1));
            }
        }

        const windKmh = parseFloat((d.wind.wind_speed.value * 1.609).toFixed(1));
        const gustKmh = parseFloat((d.wind.wind_gust.value * 1.609).toFixed(1));
        
        // Pressure Trend Logic (3-hour window)
        let pTrend = "Stable";
        if (state.todayHistory.length > 10) {
            const threeHrsAgo = now - 10800000;
            const oldP = state.todayHistory.find(h => new Date(h.time).getTime() >= threeHrsAgo);
            if (oldP) {
                const diff = pressure - oldP.press;
                if (diff >= 1) pTrend = "Rising";
                else if (diff <= -1) pTrend = "Falling";
            }
        }

        let tTrend = 0;
        if (state.todayHistory.length >= 2) {
            const first = state.todayHistory[0];
            const timeDiff = (now - new Date(first.time)) / 3600000;
            if (timeDiff > 0.05) tTrend = parseFloat(((tempC - first.temp) / timeDiff).toFixed(1));
        }

        state.todayHistory.push({ time: new Date().toISOString(), temp: tempC, hum: hum, wind: windKmh, rain: instantRR, rainTotal: dailyRain, press: pressure });
        if (state.todayHistory.length > 480) state.todayHistory.shift();

        state.cachedData = {
            temp: { current: tempC, max: state.maxTemp, min: state.minTemp, trend: tTrend },
            atmo: { hum: hum, press: pressure, pTrend: pTrend, dew: parseFloat(((d.outdoor.dew_point.value - 32) * 5 / 9).toFixed(1)) },
            wind: { speed: windKmh, gust: gustKmh, maxS: state.maxWindSpeed, maxG: state.maxGust, card: getCard(d.wind.wind_direction.value), deg: d.wind.wind_direction.value },
            rain: { total: dailyRain, rate: instantRR, maxR: state.maxRainRate },
            solar: { rad: d.solar_and_uvi?.solar?.value || 0, uvi: d.solar_and_uvi?.uvi?.value || 0 },
            lastSync: new Date().toISOString(),
            history: state.todayHistory
        };
        state.lastFetchTime = now;
        return state.cachedData;
    } catch (e) { return state.cachedData || { error: "Sync Fail" }; }
}

app.get("/weather", async (req, res) => res.json(await syncWithEcowitt()));

app.get("/", (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>KK Nagar Weather</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root { --bg: #020617; --card: rgba(15, 23, 42, 0.6); --accent: #38bdf8; --border: rgba(255, 255, 255, 0.08); }
        body { margin: 0; font-family: 'Inter', system-ui, sans-serif; background: var(--bg); color: #f8fafc; padding: 15px; }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
        .header h1 { margin: 0; font-size: 20px; font-weight: 800; }
        .status-box { text-align: right; }
        .status { font-size: 11px; color: #22c55e; font-weight: 700; display: flex; align-items: center; gap: 5px; justify-content: flex-end; }
        .dot { width: 6px; height: 6px; background: #22c55e; border-radius: 50%; box-shadow: 0 0 8px #22c55e; }
        .ts { font-size: 10px; color: #475569; font-family: monospace; }

        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin-bottom: 15px; }
        .card { background: var(--card); padding: 20px; border-radius: 24px; border: 1px solid var(--border); backdrop-filter: blur(10px); }
        .card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
        .label { color: #64748b; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 1px; }
        
        .main-val { font-size: 44px; font-weight: 900; letter-spacing: -2px; display: flex; align-items: baseline; }
        .unit { font-size: 16px; color: #475569; margin-left: 4px; }

        .trend-pill { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; border-radius: 12px; font-size: 11px; font-weight: 800; margin-bottom: 15px; }
        .trend-up { background: rgba(244, 63, 94, 0.1); color: #f43f5e; }
        .trend-down { background: rgba(56, 189, 248, 0.1); color: #38bdf8; }
        .trend-stable { background: rgba(255, 255, 255, 0.05); color: #94a3b8; }

        .sub-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 12px; }
        .badge { background: rgba(0,0,0,0.2); padding: 10px; border-radius: 14px; border: 1px solid rgba(255,255,255,0.02); }
        .b-lbl { font-size: 8px; color: #475569; text-transform: uppercase; font-weight: 800; display: block; margin-bottom: 2px; }
        .b-val { font-size: 12px; font-weight: 700; }

        .graph-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
        .graph-card { background: var(--card); border-radius: 24px; padding: 20px; border: 1px solid var(--border); height: 260px; }
        .graph-title { font-size: 10px; font-weight: 800; color: #64748b; text-transform: uppercase; margin-bottom: 15px; text-align: center; }
        #compass { width: 24px; height: 24px; transition: transform 1s ease; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>KK Nagar Weather Station</h1>
            <div class="status-box">
                <div class="status"><div class="dot"></div> LIVE</div>
                <div class="ts">Sync: <span id="ts">--:--:--</span></div>
            </div>
        </div>

        <div class="grid">
            <div class="card">
                <div class="card-head">
                    <div class="label">Temperature</div>
                    <div id="t_trend_pill" class="trend-pill trend-stable">--</div>
                </div>
                <div class="main-val"><span id="t">--</span><span class="unit">°C</span></div>
                <div class="sub-grid">
                    <div class="badge"><span class="b-lbl">High/Low</span><span class="b-val" id="hl">--</span></div>
                    <div class="badge"><span class="b-lbl">Humidity</span><span class="b-val" id="h">--</span></div>
                </div>
            </div>

            <div class="card">
                <div class="card-head">
                    <div class="label">Wind Dynamics</div>
                    <svg id="compass" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="3"><circle cx="12" cy="12" r="10"/><path d="M12 17V7M9 10l3-3 3 3"/></svg>
                </div>
                <div class="main-val"><span id="w">--</span><span class="unit">km/h</span></div>
                <div class="sub-grid">
                    <div class="badge"><span class="b-lbl">Gust</span><span class="b-val" id="wg">--</span></div>
                    <div class="badge"><span class="b-lbl">Peak Speed</span><span class="b-val" id="mw">--</span></div>
                </div>
            </div>

            <div class="card">
                <div class="card-head">
                    <div class="label">Atmospheric Conditions</div>
                    <div id="p_trend_pill" class="trend-pill trend-stable">--</div>
                </div>
                <div class="main-val"><span id="pr">--</span><span class="unit">hPa</span></div>
                <div class="sub-grid">
                    <div class="badge"><span class="b-lbl">Solar Radiation</span><span class="b-val" id="sol">--</span></div>
                    <div class="badge"><span class="b-lbl">UV Index</span><span class="b-val" id="uvi">--</span></div>
                    <div class="badge"><span class="b-lbl">Dew Point</span><span class="b-val" id="dp">--</span></div>
                    <div class="badge"><span class="b-lbl">Rain Rate</span><span class="b-val" id="rr">--</span></div>
                </div>
            </div>
        </div>

        <div class="graph-grid">
            <div class="graph-card"><div class="graph-title">Temperature Trend</div><canvas id="cT"></canvas></div>
            <div class="graph-card"><div class="graph-title">Humidity Trend</div><canvas id="cH"></canvas></div>
            <div class="graph-card"><div class="graph-title">Wind Speed</div><canvas id="cW"></canvas></div>
            <div class="graph-card"><div class="graph-title">Rain Intensity</div><canvas id="cR"></canvas></div>
        </div>
    </div>

    <script>
        let charts = {};
        function makeChart(id, col) {
            return new Chart(document.getElementById(id), {
                type: 'line',
                data: { labels: [], datasets: [{ data: [], borderColor: col, tension: 0.4, pointRadius: 0, borderWidth: 2.5, fill: true, backgroundColor: col + '10' }]},
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { color: '#475569', font: { size: 9 } } } } }
            });
        }

        async function update() {
            const res = await fetch('/weather?v=' + Date.now());
            const d = await res.json();
            
            document.getElementById('t').innerText = d.temp.current;
            document.getElementById('hl').innerText = d.temp.max + '°/' + d.temp.min + '°';
            
            // Modern Temp Trend UI
            const tPill = document.getElementById('t_trend_pill');
            tPill.className = 'trend-pill ' + (d.temp.trend > 0 ? 'trend-up' : d.temp.trend < 0 ? 'trend-down' : 'trend-stable');
            tPill.innerHTML = (d.temp.trend > 0 ? '↑ ' : d.temp.trend < 0 ? '↓ ' : '• ') + Math.abs(d.temp.trend) + '°/hr';

            document.getElementById('h').innerText = d.atmo.hum + '%';
            document.getElementById('dp').innerText = d.atmo.dew + '°';
            document.getElementById('pr').innerText = d.atmo.press;
            
            // Pressure Trend UI
            const pPill = document.getElementById('p_trend_pill');
            pPill.className = 'trend-pill ' + (d.atmo.pTrend === 'Rising' ? 'trend-up' : d.atmo.pTrend === 'Falling' ? 'trend-down' : 'trend-stable');
            pPill.innerHTML = (d.atmo.pTrend === 'Rising' ? '↗ ' : d.atmo.pTrend === 'Falling' ? '↘ ' : '• ') + d.atmo.pTrend;

            document.getElementById('w').innerText = d.wind.speed;
            document.getElementById('wg').innerText = d.wind.gust + ' km/h';
            document.getElementById('mw').innerText = d.wind.maxS + ' km/h';
            document.getElementById('compass').style.transform = 'rotate('+d.wind.deg+'deg)';

            document.getElementById('sol').innerText = d.solar.rad + ' W/m²';
            document.getElementById('uvi').innerText = d.solar.uvi;
            document.getElementById('rr').innerText = d.rain.rate + ' mm/h';
            document.getElementById('ts').innerText = new Date(d.lastSync).toLocaleTimeString('en-IN', { hour12: false });

            if (!charts.cT) {
                charts.cT = makeChart('cT', '#38bdf8'); charts.cH = makeChart('cH', '#10b981');
                charts.cW = makeChart('cW', '#f59e0b'); charts.cR = makeChart('cR', '#6366f1');
            }
            const lbls = d.history.map(h => '');
            charts.cT.data.labels = lbls; charts.cT.data.datasets[0].data = d.history.map(h => h.temp); charts.cT.update('none');
            charts.cH.data.labels = lbls; charts.cH.data.datasets[0].data = d.history.map(h => h.hum); charts.cH.update('none');
            charts.cW.data.labels = lbls; charts.cW.data.datasets[0].data = d.history.map(h => h.wind); charts.cW.update('none');
            charts.cR.data.labels = lbls; charts.cR.data.datasets[0].data = d.history.map(h => h.rain); charts.cR.update('none');
        }
        setInterval(update, 30000); update();
    </script>
</body>
</html>
    `);
});

app.listen(3000);
