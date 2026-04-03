const express = require("express");
const fetch = require("node-fetch");
const fs = require("fs"); 
const app = express();

const APPLICATION_KEY = process.env.APPLICATION_KEY;
const API_KEY = process.env.API_KEY;
const MAC = process.env.MAC;
const STORAGE_FILE = "./weather_records.json"; 

let state = {
    cachedData: null,
    todayHistory: [],
    maxTemp: -999,
    minTemp: 999,
    maxWindSpeed: 0,
    maxGust: 0,
    maxRainRate: 0,
    lastFetchTime: 0
};

// --- RECORDS PERSISTENCE ---
if (fs.existsSync(STORAGE_FILE)) {
    try {
        const saved = JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf-8'));
        state.maxTemp = Number(saved.maxTemp) || -999;
        state.minTemp = Number(saved.minTemp) || 999;
        state.maxWindSpeed = Number(saved.maxWindSpeed) || 0;
        state.maxGust = Number(saved.maxGust) || 0;
        state.maxRainRate = Number(saved.maxRainRate) || 0;
    } catch (e) { console.log("Records reset."); }
}

function saveToDisk() {
    const data = {
        maxTemp: state.maxTemp, minTemp: state.minTemp,
        maxWindSpeed: state.maxWindSpeed, maxGust: state.maxGust, maxRainRate: state.maxRainRate
    };
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(data), 'utf-8');
}

const getCard = (a) => ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"][Math.round(a/22.5)%16];

async function syncWithEcowitt() {
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

        // Update Records
        let changed = false;
        if (tempC > state.maxTemp || state.maxTemp === -999) { state.maxTemp = tempC; changed = true; }
        if (tempC < state.minTemp || state.minTemp === 999) { state.minTemp = tempC; changed = true; }
        if (windKmh > state.maxWindSpeed) { state.maxWindSpeed = windKmh; changed = true; }
        if (gustKmh > state.maxGust) { state.maxGust = gustKmh; changed = true; }
        if (rainRate > state.maxRainRate) { state.maxRainRate = rainRate; changed = true; }
        if (changed) saveToDisk();

        // Trend Logic
        let trend = 0;
        if (state.todayHistory.length > 10) {
            trend = parseFloat((tempC - state.todayHistory[state.todayHistory.length - 10].temp).toFixed(1));
        }

        // History Management
        state.todayHistory.push({ 
            time: new Date().toISOString(), 
            temp: tempC, 
            hum: d.outdoor.humidity.value, 
            wind: windKmh, 
            rain: rainRate 
        });
        if (state.todayHistory.length > 300) state.todayHistory.shift();

        state.cachedData = {
            temp: { current: tempC, max: state.maxTemp, min: state.minTemp, trend: trend },
            atmo: { hum: d.outdoor.humidity.value, dew: dewC, press: (d.pressure.relative.value * 33.8639).toFixed(1) },
            wind: { speed: windKmh, gust: gustKmh, maxS: state.maxWindSpeed, maxG: state.maxGust, card: getCard(d.wind.wind_direction.value), deg: d.wind.wind_direction.value },
            rain: { total: dailyRain, rate: rainRate, maxR: state.maxRainRate },
            lastSync: new Date().toISOString(),
            history: state.todayHistory
        };
        return state.cachedData;
    } catch (e) { return state.cachedData || { error: "Offline" }; }
}

app.get("/weather", async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
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
        :root { --bg: #06080e; --card: #111827; --accent: #0ea5e9; --max-t: #f87171; --min-t: #60a5fa; --wind: #fbbf24; --rain: #818cf8; }
        body { margin:0; font-family: 'Inter', system-ui, sans-serif; background: var(--bg); color: #f1f5f9; padding: 20px; }
        
        .header { text-align: center; margin-bottom: 25px; }
        .header h1 { margin: 0; font-size: 20px; letter-spacing: 2px; font-weight: 900; }
        .live-indicator { display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 8px; font-family: monospace; font-size: 18px; color: #64748b; }
        .dot { width: 10px; height: 10px; background: #22c55e; border-radius: 50%; box-shadow: 0 0 15px #22c55e; animation: pulse 2s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

        .readings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 30px; }
        .card { background: var(--card); padding: 22px; border-radius: 20px; border: 1px solid #1e293b; position: relative; overflow: hidden; }
        
        .label { color: var(--accent); font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 5px; }
        .main-val { font-size: 38px; font-weight: 900; margin: 2px 0; letter-spacing: -1.5px; }
        .trend-line { font-size: 14px; font-weight: 600; margin-bottom: 15px; display: flex; align-items: center; gap: 6px; }
        
        .sub-box { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 15px; border-top: 1px solid #1e293b; }
        .badge { padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 700; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05); }

        .compass-ui { position: absolute; top: 15px; right: 15px; width: 60px; height: 60px; border: 2px solid #1e293b; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.2); }
        .compass-ui::after { content: 'N'; position: absolute; top: -2px; font-size: 8px; font-weight: 900; color: var(--max-t); }
        #needle { width: 4px; height: 35px; background: linear-gradient(to bottom, var(--max-t) 50%, #f1f5f9 50%); clip-path: polygon(50% 0%, 100% 100%, 0% 100%); transition: transform 1.5s cubic-bezier(0.4, 0, 0.2, 1); }

        .graphs-title { font-size: 14px; font-weight: 800; color: #475569; margin-bottom: 20px; text-transform: uppercase; letter-spacing: 2px; text-align: center; border-bottom: 1px solid #1e293b; padding-bottom: 10px; }
        .graphs-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(450px, 1fr)); gap: 20px; }
        .graph-card { background: var(--card); padding: 15px; border-radius: 20px; height: 260px; border: 1px solid #1e293b; }

        @media (max-width: 650px) { .readings-grid { grid-template-columns: 1fr; } .graphs-grid { grid-template-columns: 1fr; } }
    </style>
</head>
<body>

    <div class="header">
        <h1>KK NAGAR WEATHER STATION LIVE</h1>
        <div class="live-indicator"><div class="dot"></div> <span id="ts">00:00:00</span></div>
    </div>

    <div class="readings-grid">
        <div class="card">
            <div class="label">Temperature</div>
            <div id="t" class="main-val">--</div>
            <div id="tr" class="trend-line">--</div>
            <div class="sub-box">
                <div class="badge" style="color:var(--max-t)">Max Today: <span id="mx">--</span></div>
                <div class="badge" style="color:var(--min-t)">Min Today: <span id="mn">--</span></div>
            </div>
        </div>

        <div class="card">
            <div class="label">Humidity & Pressure</div>
            <div id="h" class="main-val">--</div>
            <div class="trend-line" style="color:#22c55e">● Stable Conditions</div>
            <div class="sub-box">
                <div class="badge" style="color:#94a3b8">Dew Point: <span id="dp">--</span></div>
                <div class="badge" style="color:#94a3b8">Press: <span id="pr">--</span></div>
            </div>
        </div>

        <div class="card">
            <div class="label">Wind Conditions</div>
            <div class="compass-ui"><div id="needle"></div></div>
            <div id="w" class="main-val">--</div>
            <div id="wg" class="trend-line" style="color:var(--accent)">--</div>
            <div class="sub-box">
                <div class="badge" style="color:var(--wind)">Max Speed: <span id="mw">--</span></div>
                <div class="badge" style="color:var(--wind)">Peak Gust: <span id="mg">--</span></div>
            </div>
        </div>

        <div class="card">
            <div class="label">Rainfall (24h)</div>
            <div id="r" class="main-val">--</div>
            <div id="rr" class="trend-line" style="color:var(--rain)">--</div>
            <div class="sub-box">
                <div class="badge" style="color:var(--rain)">Peak Rate: <span id="mr">--</span></div>
                <div class="badge" style="color:#94a3b8">Status: <span id="rs">--</span></div>
            </div>
        </div>
    </div>

    <div class="graphs-title">Live Trend Analytics</div>
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
            const gradient = ctx.createLinearGradient(0, 0, 0, 250);
            gradient.addColorStop(0, col + '44');
            gradient.addColorStop(1, col + '00');

            return new Chart(ctx, {
                type: 'line',
                data: { labels: [], datasets: [{ label: label, data: [], borderColor: col, tension: 0.4, pointRadius: 0, borderWidth: 3, fill: true, backgroundColor: gradient }]},
                options: { 
                    responsive: true, maintainAspectRatio: false, 
                    plugins: { legend: { display: true, labels: {color: '#94a3b8', font: {size: 11, weight: 'bold'}} } },
                    scales: { 
                        x: { ticks: { color: '#475569', font: { size: 10 }, autoSkip: true, maxTicksLimit: 6 }, grid: { display: false } }, 
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
                document.getElementById('t').innerText = d.temp.current + '°C';
                const symb = d.temp.trend > 0 ? '▲' : d.temp.trend < 0 ? '▼' : '●';
                document.getElementById('tr').innerHTML = 'Trend: <span style="color:' + (d.temp.trend >= 0 ? 'var(--max-t)' : '#22c55e') + '">' + symb + ' ' + Math.abs(d.temp.trend) + '°C/hr</span>';
                document.getElementById('mx').innerText = d.temp.max + '°';
                document.getElementById('mn').innerText = d.temp.min + '°';

                // Humidity
                document.getElementById('h').innerText = d.atmo.hum + '%';
                document.getElementById('dp').innerText = d.atmo.dew + '°';
                document.getElementById('pr').innerText = d.atmo.press + ' hPa';

                // Wind
                document.getElementById('w').innerText = d.wind.speed + ' km/h';
                document.getElementById('wg').innerText = 'Direction: ' + d.wind.card + ' (' + d.wind.deg + '°) | Gust: ' + d.wind.gust + ' km/h';
                document.getElementById('mw').innerText = d.wind.maxS + ' km/h';
                document.getElementById('mg').innerText = d.wind.maxG + ' km/h';
                document.getElementById('needle').style.transform = 'rotate(' + d.wind.deg + 'deg)';

                // Rain
                document.getElementById('r').innerText = d.rain.total + ' mm';
                document.getElementById('rr').innerText = 'Intensity: ' + d.rain.rate + ' mm/h';
                document.getElementById('mr').innerText = d.rain.maxR + ' mm/h';
                document.getElementById('rs').innerText = d.rain.rate > 0 ? 'Raining' : 'Dry';

                document.getElementById('ts').innerText = new Date(d.lastSync).toLocaleTimeString('en-IN', {hour12: false});

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
            setTimeout(update, 45000); 
        }
        update();
    </script>
</body>
</html>`);
});

app.listen(3000, () => console.log("Station fully active."));
