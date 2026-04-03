const express = require("express");
const fetch = require("node-fetch");
const fs = require("fs");
const app = express();

// Configuration
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

// --- PERSISTENCE LOGIC ---
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
    } catch (e) { console.error("Load Error", e); }
}

function saveToDisk() {
    try {
        const data = {
            currentDate: state.currentDate,
            maxTemp: state.maxTemp,
            minTemp: state.minTemp,
            maxWindSpeed: state.maxWindSpeed,
            maxGust: state.maxGust,
            maxRainRate: state.maxRainRate
        };
        fs.writeFileSync(STORAGE_FILE, JSON.stringify(data), 'utf-8');
    } catch (e) { console.error("Save Error", e); }
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
        
        // Instant Rain Rate Logic
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

        const windKmh = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));
        const gustKmh = parseFloat((d.wind.wind_gust.value * 1.60934).toFixed(1));
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
        let pTrend = "Stable";
        if (state.todayHistory.length >= 2) {
            const first = state.todayHistory[0];
            const timeDiff = (now - new Date(first.time)) / 3600000;
            if (timeDiff > 0.02) tTrend = parseFloat(((tempC - first.temp) / timeDiff).toFixed(1));

            const threeHrsAgo = now - 10800000;
            const pBase = state.todayHistory.find(h => new Date(h.time).getTime() >= threeHrsAgo);
            if (pBase) {
                const pDiff = pressure - pBase.press;
                pTrend = pDiff >= 1 ? "Rising" : pDiff <= -1 ? "Falling" : "Stable";
            }
        }

        state.todayHistory.push({ time: new Date().toISOString(), temp: tempC, hum: hum, wind: windKmh, rain: instantRR, rainTotal: dailyRain, press: pressure });
        if (state.todayHistory.length > 480) state.todayHistory.shift();

        state.cachedData = {
            temp: { current: tempC, max: state.maxTemp, min: state.minTemp, trend: tTrend, realFeel: calculateRealFeel(tempC, hum) },
            atmo: { hum: hum, dew: parseFloat(((d.outdoor.dew_point.value - 32) * 5 / 9).toFixed(1)), press: pressure, pTrend: pTrend },
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
    <title>KK Nagar Weather Hub Pro</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root { --bg: #020617; --card: rgba(15, 23, 42, 0.7); --accent: #38bdf8; --border: rgba(255, 255, 255, 0.08); }
        * { box-sizing: border-box; -webkit-font-smoothing: antialiased; }
        body { margin: 0; font-family: 'Inter', sans-serif; background: var(--bg); color: #f8fafc; padding: 20px; }
        .container { max-width: 1200px; margin: 0 auto; }
        
        .header { margin-bottom: 30px; display: flex; justify-content: space-between; align-items: flex-end; }
        .header h1 { margin: 0; font-size: 28px; font-weight: 900; letter-spacing: -1.5px; }
        .status { font-family: monospace; font-size: 11px; color: #475569; display: flex; align-items: center; gap: 8px; }
        .dot { width: 8px; height: 8px; background: #22c55e; border-radius: 50%; box-shadow: 0 0 10px #22c55e; animation: blink 2s infinite; }
        @keyframes blink { 50% { opacity: 0.3; } }

        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; margin-bottom: 16px; }
        .card { background: var(--card); padding: 24px; border-radius: 32px; border: 1px solid var(--border); backdrop-filter: blur(24px); }
        
        .card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
        .label { color: #64748b; font-size: 11px; font-weight: 900; text-transform: uppercase; letter-spacing: 1.5px; }
        .icon { width: 28px; height: 28px; fill: none; stroke-width: 2.5; }

        .main-val { font-size: 56px; font-weight: 900; margin: 5px 0; letter-spacing: -3px; display: flex; align-items: baseline; }
        .unit { font-size: 20px; color: #475569; margin-left: 5px; }
        
        .trend-info { font-size: 14px; font-weight: 700; margin-bottom: 15px; display: flex; flex-direction: column; gap: 4px; }
        
        .sub-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 20px; }
        .badge { background: rgba(0,0,0,0.2); padding: 12px; border-radius: 16px; border: 1px solid rgba(255,255,255,0.03); }
        .b-lbl { font-size: 9px; color: #475569; text-transform: uppercase; font-weight: 800; display: block; margin-bottom: 4px; }
        .b-val { font-size: 14px; font-weight: 700; }

        .graph-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 16px; }
        .graph-card { background: var(--card); border-radius: 32px; padding: 25px; border: 1px solid var(--border); height: 320px; }
        .graph-title { font-size: 11px; font-weight: 900; color: #64748b; text-transform: uppercase; margin-bottom: 15px; text-align: center; letter-spacing: 1px; }

        #compass { width: 35px; height: 35px; transition: transform 0.8s cubic-bezier(0.4, 0, 0.2, 1); }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div>
                <p style="color:var(--accent); font-weight: 800; font-size: 12px; margin-bottom: 4px; text-transform: uppercase;">Live Weather Station</p>
                <h1>KK Nagar <span style="font-weight: 300; color:#475569;">Digital</span></h1>
            </div>
            <div class="status">
                <div class="dot"></div> POLLING ACTIVE <br> <span id="ts">--:--:--</span>
            </div>
        </div>

        <div class="grid">
            <div class="card">
                <div class="card-head">
                    <div class="label">Temperature</div>
                    <svg class="icon" style="stroke:#f43f5e" viewBox="0 0 24 24"><path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/></svg>
                </div>
                <div class="main-val"><span id="t">--</span><span class="unit">°C</span></div>
                <div class="trend-info">
                    <span id="tr" style="color:var(--accent)">--</span>
                    <span style="color:#94a3b8">RealFeel: <span id="rf">--</span>°</span>
                </div>
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
                    <svg id="compass" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 17V7M9 10l3-3 3 3"/></svg>
                </div>
                <div class="main-val"><span id="w">--</span><span class="unit">km/h</span></div>
                <div class="trend-info" style="color:#f59e0b" id="wg">--</div>
                <div class="sub-grid">
                    <div class="badge"><span class="b-lbl">Peak Speed</span><span class="b-val" id="mw">--</span></div>
                    <div class="badge"><span class="b-lbl">Max Gust</span><span class="b-val" id="mg">--</span></div>
                    <div class="badge"><span class="b-lbl">Direction</span><span class="b-val" id="wd">--</span></div>
                    <div class="badge"><span class="b-lbl">Barometer</span><span class="b-val" id="pt">--</span></div>
                </div>
            </div>

            <div class="card">
                <div class="card-head">
                    <div class="label">Precipitation</div>
                    <svg class="icon" style="stroke:#6366f1" viewBox="0 0 24 24"><path d="M4 14.89c0-4 5-9 5-9s5 5 5 9a5 5 0 1 1-10 0Z"/></svg>
                </div>
                <div class="main-val"><span id="r">--</span><span class="unit">mm</span></div>
                <div class="trend-info" style="color:#6366f1" id="rr">Rate: 0.0 mm/h</div>
                <div class="sub-grid">
                    <div class="badge"><span class="b-lbl">Max Rate</span><span class="b-val" id="mr">--</span></div>
                    <div class="badge"><span class="b-lbl">Solar Rad</span><span class="b-val" id="sol">--</span></div>
                    <div class="badge"><span class="b-lbl">UV Index</span><span class="b-val" id="uvi">--</span></div>
                    <div class="badge"><span class="b-lbl">Status</span><span class="b-val" id="rst">Dry</span></div>
                </div>
            </div>
        </div>

        <div class="graph-grid">
            <div class="graph-card"><div class="graph-title">Temperature Trend (°C)</div><canvas id="cT"></canvas></div>
            <div class="graph-card"><div class="graph-title">Humidity Trend (%)</div><canvas id="cH"></canvas></div>
            <div class="graph-card"><div class="graph-title">Wind Speed (km/h)</div><canvas id="cW"></canvas></div>
            <div class="graph-card"><div class="graph-title">Rain Intensity (mm/h)</div><canvas id="cR"></canvas></div>
        </div>
    </div>

    <script>
        let charts = {};
        function initChart(id, label, col) {
            const ctx = document.getElementById(id).getContext('2d');
            const grad = ctx.createLinearGradient(0, 0, 0, 300);
            grad.addColorStop(0, col + '22'); grad.addColorStop(1, col + '00');
            return new Chart(ctx, {
                type: 'line',
                data: { labels: [], datasets: [{ label: label, data: [], borderColor: col, tension: 0.4, pointRadius: 0, borderWidth: 3, fill: true, backgroundColor: grad }]},
                options: { 
                    responsive: true, maintainAspectRatio: false, 
                    plugins: { legend: { display: false } },
                    scales: { 
                        x: { display: false }, 
                        y: { grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { color: '#475569', font: { size: 10 } } } 
                    }
                }
            });
        }

        async function update() {
            try {
                const res = await fetch('/weather?v=' + Date.now());
                const d = await res.json();
                
                document.getElementById('t').innerText = d.temp.current;
                document.getElementById('rf').innerText = d.temp.realFeel;
                document.getElementById('hl').innerText = d.temp.max + '° / ' + d.temp.min + '°';
                document.getElementById('tr').innerText = (d.temp.trend >= 0 ? '↗ ' : '↘ ') + Math.abs(d.temp.trend) + '°C/hr Trend';
                
                document.getElementById('h').innerText = d.atmo.hum + '%';
                document.getElementById('dp').innerText = d.atmo.dew + '°';
                document.getElementById('pr').innerText = d.atmo.press + ' hPa';
                document.getElementById('pt').innerText = d.atmo.pTrend;

                document.getElementById('w').innerText = d.wind.speed;
                document.getElementById('wg').innerText = d.wind.card + ' • GUST ' + d.wind.gust + ' km/h';
                document.getElementById('mw').innerText = d.wind.maxS + ' km/h';
                document.getElementById('mg').innerText = d.wind.maxG + ' km/h';
                document.getElementById('wd').innerText = d.wind.deg + '° ' + d.wind.card;
                document.getElementById('compass').style.transform = 'rotate(' + d.wind.deg + 'deg)';

                document.getElementById('r').innerText = d.rain.total;
                document.getElementById('rr').innerText = 'Rate: ' + d.rain.rate + ' mm/h';
                document.getElementById('mr').innerText = d.rain.maxR + ' mm/h';
                document.getElementById('sol').innerText = d.solar.rad + ' W/m²';
                document.getElementById('uvi').innerText = d.solar.uvi;
                document.getElementById('rst').innerText = d.rain.rate > 0 ? 'RAINING' : 'DRY';

                document.getElementById('ts').innerText = new Date(d.lastSync).toLocaleTimeString('en-IN', { hour12: false });

                if (!charts.cT) {
                    charts.cT = initChart('cT', 'Temp', '#38bdf8');
                    charts.cH = initChart('cH', 'Humidity', '#10b981');
                    charts.cW = initChart('cW', 'Wind', '#f59e0b');
                    charts.cR = initChart('cR', 'Rain', '#6366f1');
                }
                const lbls = d.history.map(h => '');
                charts.cT.data.labels = lbls; charts.cT.data.datasets[0].data = d.history.map(h => h.temp); charts.cT.update('none');
                charts.cH.data.labels = lbls; charts.cH.data.datasets[0].data = d.history.map(h => h.hum); charts.cH.update('none');
                charts.cW.data.labels = lbls; charts.cW.data.datasets[0].data = d.history.map(h => h.wind); charts.cW.update('none');
                charts.cR.data.labels = lbls; charts.cR.data.datasets[0].data = d.history.map(h => h.rain); charts.cR.update('none');
            } catch (e) { console.error(e); }
        }
        setInterval(update, 30000); update();
    </script>
</body>
</html>
    `);
});

app.listen(3000);
