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

// --- BACKEND LOGIC (UNTOUCHED) ---
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
                const lastRainCheck = now - 150000;
                if (!state.todayHistory.some(h => h.rain > 0 && new Date(h.time).getTime() >= lastRainCheck)) instantRR = 0;
            }
        }

        const today = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
        if (state.currentDate !== today) {
            state.currentDate = today;
            state.maxTemp = -999; state.minTemp = 999; state.maxWindSpeed = 0; state.maxGust = 0; state.maxRainRate = 0;
            state.todayHistory = [];
        }

        if (tempC > state.maxTemp || state.maxTemp === -999) state.maxTemp = tempC;
        if (tempC < state.minTemp || state.minTemp === 999) state.minTemp = tempC;
        if (instantRR > state.maxRainRate) state.maxRainRate = instantRR;
        saveToDisk();

        let tTrend = 0;
        if (state.todayHistory.length >= 2) {
            const last = state.todayHistory[state.todayHistory.length - 1];
            const timeDiff = (now - new Date(state.todayHistory[0].time)) / 3600000;
            if (timeDiff > 0.02) tTrend = parseFloat(((tempC - state.todayHistory[0].temp) / timeDiff).toFixed(1));
        }

        state.todayHistory.push({ time: new Date().toISOString(), temp: tempC, hum: hum, rain: instantRR, rainTotal: dailyRain, press: pressure });
        if (state.todayHistory.length > 480) state.todayHistory.shift();

        state.cachedData = {
            temp: { current: tempC, max: state.maxTemp, min: state.minTemp, realFeel: calculateRealFeel(tempC, hum), trend: tTrend },
            atmo: { hum: hum, press: pressure },
            wind: { speed: (d.wind.wind_speed.value * 1.609).toFixed(1), gust: (d.wind.wind_gust.value * 1.609).toFixed(1), card: getCard(d.wind.wind_direction.value), deg: d.wind.wind_direction.value },
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
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>KK Nagar Weather Pro</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root { --bg: #0b0f1a; --glass: rgba(30, 41, 59, 0.6); --border: rgba(255,255,255,0.1); --accent: #38bdf8; }
        body { margin: 0; font-family: 'Inter', sans-serif; background: var(--bg); color: #fff; padding: 20px; }
        .container { max-width: 1100px; margin: 0 auto; }
        
        .header { text-align: center; margin-bottom: 30px; }
        .header h1 { font-size: 24px; margin: 0; letter-spacing: -0.5px; font-weight: 700; opacity: 0.9; }
        .status-pill { display: inline-flex; align-items: center; gap: 8px; background: rgba(34,197,94,0.1); padding: 4px 12px; border-radius: 20px; border: 1px solid rgba(34,197,94,0.2); margin-top: 8px; font-size: 11px; font-family: monospace; color: #4ade80; }
        .dot { width: 6px; height: 6px; background: #22c55e; border-radius: 50%; animation: blink 2s infinite; }
        @keyframes blink { 50% { opacity: 0.3; } }

        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 15px; margin-bottom: 15px; }
        .card { background: var(--glass); border: 1px solid var(--border); padding: 20px; border-radius: 24px; backdrop-filter: blur(10px); }
        
        .label { font-size: 10px; font-weight: 800; text-transform: uppercase; color: #64748b; letter-spacing: 1px; }
        .main-val { font-size: 44px; font-weight: 800; margin: 5px 0; letter-spacing: -1.5px; }
        .unit { font-size: 18px; color: #475569; font-weight: 600; margin-left: 4px; }
        
        /* THE TWEAK: RATE/TREND MOVED UP */
        .priority-metric { font-size: 13px; font-weight: 700; color: var(--accent); display: flex; align-items: center; gap: 5px; margin-bottom: 15px; }
        
        .sub-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 15px; }
        .stat { background: rgba(0,0,0,0.2); padding: 10px; border-radius: 12px; }
        .s-label { font-size: 9px; color: #475569; text-transform: uppercase; font-weight: 800; display: block; }
        .s-val { font-size: 13px; font-weight: 700; }

        .graph-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; }
        .graph-card { background: var(--glass); border: 1px solid var(--border); border-radius: 24px; padding: 15px; height: 240px; }
        
        #compass { transition: transform 1.5s ease; width: 40px; float: right; margin-top: -35px; }
        @media (max-width: 700px) { .graph-grid { grid-template-columns: 1fr; } }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>KK Nagar Weather Hub</h1>
            <div class="status-pill"><div class="dot"></div> POLLING ACTIVE <span id="ts">--:--</span></div>
        </div>

        <div class="grid">
            <div class="card">
                <div class="label">Temperature</div>
                <div class="main-val"><span id="t">--</span><span class="unit">°C</span></div>
                <div class="priority-metric" id="tr">Trend: --</div>
                <div class="sub-grid">
                    <div class="stat"><span class="s-label">RealFeel</span><span class="s-val" id="rf">--</span></div>
                    <div class="stat"><span class="s-label">Max/Min</span><span class="s-val" id="hl">--</span></div>
                </div>
            </div>

            <div class="card">
                <div class="label">Wind Speed</div>
                <div class="main-val"><span id="w">--</span><span class="unit">km/h</span></div>
                <div class="priority-metric" id="wg" style="color:#fbbf24">--</div>
                <svg id="compass" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 17V7M9 10l3-3 3 3"/></svg>
                <div class="sub-grid">
                    <div class="stat"><span class="s-label">Peak Speed</span><span class="s-val" id="mw">--</span></div>
                    <div class="stat"><span class="s-label">Pressure</span><span class="s-val" id="pr">--</span></div>
                </div>
            </div>

            <div class="card" id="rcard">
                <div class="label">Precipitation</div>
                <div class="main-val"><span id="r">--</span><span class="unit">mm</span></div>
                <div class="priority-metric" id="rr" style="color:#818cf8">Rate: 0.0 mm/h</div>
                <div class="sub-grid">
                    <div class="stat"><span class="s-label">Max Rate</span><span class="s-val" id="mr">--</span></div>
                    <div class="stat"><span class="s-label">Solar Rad</span><span class="s-val" id="sol">--</span></div>
                </div>
            </div>
        </div>

        <div class="graph-grid">
            <div class="graph-card"><canvas id="cT"></canvas></div>
            <div class="graph-card"><canvas id="cR"></canvas></div>
        </div>
    </div>

    <script>
        let charts = {};
        async function update() {
            const res = await fetch('/weather?v=' + Date.now());
            const d = await res.json();
            document.getElementById('t').innerText = d.temp.current;
            document.getElementById('rf').innerText = d.temp.realFeel + '°';
            document.getElementById('hl').innerText = d.temp.max + '°/' + d.temp.min + '°';
            document.getElementById('tr').innerText = (d.temp.trend >= 0 ? '↗ ' : '↘ ') + Math.abs(d.temp.trend) + '°C/hr';
            document.getElementById('w').innerText = d.wind.speed;
            document.getElementById('wg').innerText = d.wind.card + ' • GUST ' + d.wind.gust;
            document.getElementById('pr').innerText = d.atmo.press + ' hPa';
            document.getElementById('mw').innerText = d.wind.maxS + ' km/h';
            document.getElementById('r').innerText = d.rain.total;
            document.getElementById('rr').innerText = 'Rate: ' + d.rain.rate + ' mm/h';
            document.getElementById('mr').innerText = d.rain.maxR + ' mm/h';
            document.getElementById('sol').innerText = d.solar.rad + ' W/m²';
            document.getElementById('ts').innerText = new Date(d.lastSync).toLocaleTimeString('en-IN', {hour12:false});
            document.getElementById('compass').style.transform = 'rotate(' + d.wind.deg + 'deg)';
            document.getElementById('rcard').style.borderColor = d.rain.rate > 0 ? '#818cf8' : 'rgba(255,255,255,0.1)';
            
            if(!charts.cT) {
                const cfg = (id, label, col) => new Chart(document.getElementById(id), {type:'line', data:{labels:[], datasets:[{label:label, data:[], borderColor:col, tension:0.4, fill:true, backgroundColor:col+'11', pointRadius:0}]}, options:{maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{x:{display:false},y:{grid:{color:'rgba(255,255,255,0.05)'},ticks:{color:'#475569', font:{size:9}}}}}});
                charts.cT = cfg('cT', 'Temp', '#38bdf8');
                charts.cR = cfg('cR', 'Rain', '#818cf8');
            }
            const lbls = d.history.map(h => '');
            charts.cT.data.labels = lbls; charts.cT.data.datasets[0].data = d.history.map(h => h.temp); charts.cT.update();
            charts.cR.data.labels = lbls; charts.cR.data.datasets[0].data = d.history.map(h => h.rain); charts.cR.update();
        }
        setInterval(update, 30000); update();
    </script>
</body>
</html>
    `);
});

app.listen(3000);
