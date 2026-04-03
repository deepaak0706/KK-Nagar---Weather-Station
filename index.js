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
            state.maxTemp = saved.maxTemp ?? -999;
            state.minTemp = saved.minTemp ?? 999;
            state.maxWindSpeed = saved.maxWindSpeed ?? 0;
            state.maxGust = saved.maxGust ?? 0;
            state.maxRainRate = saved.maxRainRate ?? 0;
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

function calculateRealFeel(tempC, humidity) {
    const T = (tempC * 9/5) + 32;
    const R = humidity;
    let hi = 0.5 * (T + 61.0 + ((T - 68.0) * 1.2) + (R * 0.094));
    if (hi > 79) {
        hi = -42.379 + 2.04901523 * T + 10.14333127 * R - 0.22475541 * T * R - 0.00683783 * T * T - 0.05481717 * R * R + 0.00122874 * T * T * R + 0.00085282 * T * R * R - 0.00000199 * T * T * R * R;
    }
    return parseFloat(((hi - 32) * 5 / 9).toFixed(1));
}

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
            } else {
                if (!state.todayHistory.some(h => h.rain > 0 && new Date(h.time).getTime() >= now - 150000)) instantRR = 0;
            }
        }

        const windKmh = parseFloat((d.wind.wind_speed.value * 1.609).toFixed(1));
        const gustKmh = parseFloat((d.wind.wind_gust.value * 1.609).toFixed(1));
        const today = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });

        if (state.currentDate !== today) {
            state.currentDate = today;
            state.maxTemp = -999; state.minTemp = 999; state.maxWindSpeed = 0; state.maxGust = 0; state.maxRainRate = 0;
            state.todayHistory = [];
        }

        if (tempC > state.maxTemp || state.maxTemp === -999) state.maxTemp = tempC;
        if (tempC < state.minTemp || state.minTemp === 999) state.minTemp = tempC;
        if (windKmh > state.maxWindSpeed) state.maxWindSpeed = windKmh;
        if (gustKmh > state.maxGust) state.maxGust = gustKmh;
        if (instantRR > state.maxRainRate) state.maxRainRate = instantRR;
        saveToDisk();

        let tTrend = 0;
        if (state.todayHistory.length >= 2) {
            const first = state.todayHistory[0];
            const timeDiff = (now - new Date(first.time)) / 3600000;
            if (timeDiff > 0.02) tTrend = parseFloat(((tempC - first.temp) / timeDiff).toFixed(1));
        }

        state.todayHistory.push({ time: new Date().toISOString(), temp: tempC, hum: hum, wind: windKmh, rain: instantRR, rainTotal: dailyRain, press: pressure });
        if (state.todayHistory.length > 480) state.todayHistory.shift();

        state.cachedData = {
            temp: { current: tempC, max: state.maxTemp, min: state.minTemp, trend: tTrend, realFeel: calculateRealFeel(tempC, hum) },
            atmo: { hum: hum, dew: parseFloat(((d.outdoor.dew_point.value - 32) * 5 / 9).toFixed(1)), press: pressure },
            wind: { speed: windKmh, gust: gustKmh, maxS: state.maxWindSpeed, maxG: state.maxGust, card: getCard(d.wind.wind_direction.value), deg: d.wind.wind_direction.value },
            rain: { total: dailyRain, rate: instantRR, maxR: state.maxRainRate },
            solar: { rad: d.solar_and_uvi?.solar?.value || 0, uvi: d.solar_and_uvi?.uvi?.value || 0 },
            lastSync: new Date().toISOString(),
            history: state.todayHistory
        };
        state.lastFetchTime = now;
        return state.cachedData;
    } catch (e) { return state.cachedData || { error: "Failed" }; }
}

app.get("/weather", async (req, res) => { res.json(await syncWithEcowitt()); });

app.get("/", (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>KK Nagar Weather</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root { --bg: #020617; --card: rgba(15, 23, 42, 0.7); --accent: #38bdf8; --border: rgba(255, 255, 255, 0.08); }
        body { margin: 0; font-family: 'Inter', sans-serif; background: var(--bg); color: #f8fafc; padding: 15px; }
        .container { max-width: 1200px; margin: 0 auto; }
        
        .header { margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; }
        .header h1 { margin: 0; font-size: 22px; font-weight: 800; letter-spacing: -0.5px; }
        .status { font-size: 11px; font-weight: 700; color: #22c55e; display: flex; align-items: center; gap: 6px; background: rgba(34, 197, 94, 0.1); padding: 4px 10px; border-radius: 20px; }
        .dot { width: 6px; height: 6px; background: #22c55e; border-radius: 50%; box-shadow: 0 0 8px #22c55e; }

        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin-bottom: 12px; }
        .card { background: var(--card); padding: 20px; border-radius: 24px; border: 1px solid var(--border); backdrop-filter: blur(20px); position: relative; }
        
        .card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
        .icon { width: 22px; height: 22px; stroke-width: 2.5; fill: none; }
        
        .label { color: #64748b; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 1px; }
        .main-val { font-size: 48px; font-weight: 900; letter-spacing: -2px; margin: 2px 0; }
        .unit { font-size: 16px; color: #475569; margin-left: 2px; }
        
        .trend-pill { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 800; background: rgba(255,255,255,0.05); margin-bottom: 10px; }
        .realfeel-text { font-size: 12px; font-weight: 600; color: #94a3b8; margin-bottom: 12px; }

        .sub-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 12px; }
        .badge { background: rgba(0,0,0,0.2); padding: 8px; border-radius: 12px; }
        .b-lbl { font-size: 8px; color: #475569; text-transform: uppercase; display: block; margin-bottom: 2px; }
        .b-val { font-size: 12px; font-weight: 700; }

        .graph-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
        .graph-card { background: var(--card); border-radius: 24px; padding: 15px; border: 1px solid var(--border); height: 250px; }
        .graph-title { font-size: 10px; font-weight: 800; color: #64748b; text-transform: uppercase; margin-bottom: 10px; text-align: center; }

        #compass-ui { width: 30px; height: 30px; transition: transform 0.5s ease; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>KK Nagar Weather Station</h1>
            <div class="status"><div class="dot"></div> LIVE</div>
        </div>

        <div class="grid">
            <div class="card">
                <div class="card-head">
                    <div class="label">Temperature</div>
                    <svg class="icon" style="stroke:#f43f5e" viewBox="0 0 24 24"><path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/></svg>
                </div>
                <div class="main-val"><span id="t">--</span><span class="unit">°C</span></div>
                <div class="trend-pill" id="tr_pill">--</div>
                <div class="realfeel-text">RealFeel: <span id="rf">--</span>°</div>
                <div class="sub-grid">
                    <div class="badge"><span class="b-lbl">High/Low</span><span class="b-val" id="hl">--</span></div>
                    <div class="badge"><span class="b-lbl">Humidity</span><span class="b-val" id="h">--</span></div>
                    <div class="badge"><span class="b-lbl">Dew Point</span><span class="b-val" id="dp">--</span></div>
                    <div class="badge"><span class="b-lbl">Pressure</span><span class="b-val" id="pr">--</span></div>
                </div>
            </div>

            <div class="card">
                <div class="card-head">
                    <div class="label">Wind Dynamics</div>
                    <svg id="compass-ui" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 17V7M9 10l3-3 3 3"/></svg>
                </div>
                <div class="main-val"><span id="w">--</span><span class="unit">km/h</span></div>
                <div class="trend-pill" id="wg" style="color:#f59e0b">--</div>
                <div class="sub-grid">
                    <div class="badge"><span class="b-lbl">Peak Speed</span><span class="b-val" id="mw">--</span></div>
                    <div class="badge"><span class="b-lbl">Max Gust</span><span class="b-val" id="mg">--</span></div>
                </div>
            </div>

            <div class="card">
                <div class="card-head">
                    <div class="label">Precipitation</div>
                    <svg class="icon" style="stroke:#6366f1" viewBox="0 0 24 24"><path d="M4 14.89c0-4 5-9 5-9s5 5 5 9a5 5 0 1 1-10 0Z"/></svg>
                </div>
                <div class="main-val"><span id="r">--</span><span class="unit">mm</span></div>
                <div class="trend-pill" id="rr" style="color:#6366f1">Rate: 0.0 mm/h</div>
                <div class="sub-grid">
                    <div class="badge"><span class="b-lbl">Max Rate</span><span class="b-val" id="mr">--</span></div>
                    <div class="badge"><span class="b-lbl">Status</span><span class="b-val" id="rst">Dry</span></div>
                </div>
            </div>

            <div class="card">
                <div class="card-head">
                    <div class="label">Solar & UV</div>
                    <svg class="icon" style="stroke:#facc15" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
                </div>
                <div class="main-val"><span id="uvi">--</span><span class="unit">UVI</span></div>
                <div class="trend-pill" style="color:#facc15">Index Level</div>
                <div class="sub-grid">
                    <div class="badge"><span class="b-lbl">Radiation</span><span class="b-val" id="sol">--</span></div>
                    <div class="badge"><span class="b-lbl">Sync Time</span><span class="b-val" id="ts">--</span></div>
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
                data: { labels: [], datasets: [{ data: [], borderColor: col, tension: 0.4, pointRadius: 0, borderWidth: 2, fill: true, backgroundColor: col + '11' }]},
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { color: '#475569', font: { size: 9 } } } } }
            });
        }

        async function update() {
            const res = await fetch('/weather?v=' + Date.now());
            const d = await res.json();
            document.getElementById('t').innerText = d.temp.current;
            document.getElementById('rf').innerText = d.temp.realFeel;
            document.getElementById('hl').innerText = d.temp.max + '°/' + d.temp.min + '°';
            
            const trPill = document.getElementById('tr_pill');
            trPill.innerHTML = (d.temp.trend >= 0 ? '↗ ' : '↘ ') + Math.abs(d.temp.trend) + '°/hr';
            trPill.style.color = d.temp.trend >= 0 ? '#f43f5e' : '#38bdf8';

            document.getElementById('h').innerText = d.atmo.hum + '%';
            document.getElementById('dp').innerText = d.atmo.dew + '°';
            document.getElementById('pr').innerText = d.atmo.press;
            document.getElementById('w').innerText = d.wind.speed;
            document.getElementById('wg').innerText = d.wind.card + ' • GUST ' + d.wind.gust;
            document.getElementById('mw').innerText = d.wind.maxS + ' km/h';
            document.getElementById('mg').innerText = d.wind.maxG + ' km/h';
            document.getElementById('r').innerText = d.rain.total;
            document.getElementById('rr').innerText = 'Rate: ' + d.rain.rate + ' mm/h';
            document.getElementById('mr').innerText = d.rain.maxR + ' mm/h';
            document.getElementById('rst').innerText = d.rain.rate > 0 ? 'Raining' : 'Dry';
            document.getElementById('sol').innerText = d.solar.rad + ' W';
            document.getElementById('uvi').innerText = d.solar.uvi;
            document.getElementById('ts').innerText = new Date(d.lastSync).toLocaleTimeString('en-IN', { hour12: false });
            document.getElementById('compass-ui').style.transform = 'rotate(' + d.wind.deg + 'deg)';

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
