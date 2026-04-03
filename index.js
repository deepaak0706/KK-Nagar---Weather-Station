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
        const data = {
            currentDate: state.currentDate,
            maxTemp: state.maxTemp,
            minTemp: state.minTemp,
            maxWindSpeed: state.maxWindSpeed,
            maxGust: state.maxGust,
            maxRainRate: state.maxRainRate
        };
        fs.writeFileSync(STORAGE_FILE, JSON.stringify(data), 'utf-8');
    } catch (e) {}
}

const getCard = (a) => {
    const directions = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
    return directions[Math.round(a / 22.5) % 16];
};

function calculateRealFeel(tempC, humidity) {
    const T = (tempC * 9/5) + 32;
    const R = humidity;
    let hi = 0.5 * (T + 61.0 + ((T - 68.0) * 1.2) + (R * 0.094));
    if (hi > 79) {
        hi = -42.379 + 2.04901523 * T + 10.14333127 * R - 0.22475541 * T * R - 
             0.00683783 * T * T - 0.05481717 * R * R + 0.00122874 * T * T * R + 
             0.00085282 * T * R * R - 0.00000199 * T * T * R * R;
    }
    return parseFloat(((hi - 32) * 5 / 9).toFixed(1));
}

async function syncWithEcowitt() {
    const now = Date.now();
    if (state.cachedData && (now - state.lastFetchTime < 40000)) return state.cachedData;

    try {
        const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}`;
        const response = await fetch(url);
        const json = await response.json();
        const d = json.data;

        const tempC = parseFloat(((d.outdoor.temperature.value - 32) * 5 / 9).toFixed(1));
        const hum = d.outdoor.humidity.value;
        const dewC = parseFloat(((d.outdoor.dew_point.value - 32) * 5 / 9).toFixed(1));
        const realFeel = calculateRealFeel(tempC, hum);
        
        const rainRate = parseFloat((d.rainfall.rain_rate.value * 25.4).toFixed(1));
        const dailyRain = parseFloat((d.rainfall.daily.value * 25.4).toFixed(1));
        const windKmh = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));
        const gustKmh = parseFloat((d.wind.wind_gust.value * 1.60934).toFixed(1));
        const solar = d.solar_and_uvi?.solar?.value || 0;
        const uvi = d.solar_and_uvi?.uvi?.value || 0;

        const today = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
        if (state.currentDate !== today) {
            state.currentDate = today;
            state.maxTemp = -999; state.minTemp = 999;
            state.maxWindSpeed = 0; state.maxGust = 0; state.maxRainRate = 0;
            state.todayHistory = [];
        }

        let changed = false;
        if (tempC > state.maxTemp || state.maxTemp === -999) { state.maxTemp = tempC; changed = true; }
        if (tempC < state.minTemp || state.minTemp === 999) { state.minTemp = tempC; changed = true; }
        if (windKmh > state.maxWindSpeed) { state.maxWindSpeed = windKmh; changed = true; }
        if (gustKmh > state.maxGust) { state.maxGust = gustKmh; changed = true; }
        if (rainRate > state.maxRainRate) { state.maxRainRate = rainRate; changed = true; }
        if (changed) saveToDisk();

        let trend = 0;
        if (state.todayHistory.length >= 60) {
            trend = parseFloat((tempC - state.todayHistory[state.todayHistory.length - 60].temp).toFixed(1));
        }

        state.todayHistory.push({ 
            time: new Date().toISOString(), temp: tempC, hum: hum, 
            wind: windKmh, rain: rainRate, solar: solar 
        });
        if (state.todayHistory.length > 300) state.todayHistory.shift();

        state.cachedData = {
            temp: { current: tempC, max: state.maxTemp, min: state.minTemp, trend: trend, realFeel: realFeel },
            atmo: { hum: hum, dew: dewC, press: (d.pressure.relative.value * 33.8639).toFixed(1) },
            wind: { speed: windKmh, gust: gustKmh, maxS: state.maxWindSpeed, maxG: state.maxGust, card: getCard(d.wind.wind_direction.value), deg: d.wind.wind_direction.value },
            rain: { total: dailyRain, rate: rainRate, maxR: state.maxRainRate },
            solar: { rad: solar, uvi: uvi },
            lastSync: new Date().toISOString(),
            history: state.todayHistory
        };
        state.lastFetchTime = now;
        return state.cachedData;
    } catch (e) {
        return state.cachedData || { error: "Update failed" };
    }
}

app.get("/weather", async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await syncWithEcowitt());
});

app.get("/", (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Kk Nagar Weather Hub</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root { 
            --bg: #030712; --card: #111827; --accent: #38bdf8; 
            --max-t: #f87171; --min-t: #60a5fa; --wind: #fbbf24; 
            --rain: #818cf8; --border: #1f2937;
        }
        * { box-sizing: border-box; -webkit-font-smoothing: antialiased; }
        body { 
            margin: 0; font-family: 'Inter', system-ui, sans-serif; 
            background-color: var(--bg); color: #f9fafb; 
            padding: 24px; display: flex; flex-direction: column; align-items: center;
        }
        .container { width: 100%; max-width: 1200px; }
        .header { margin-bottom: 30px; display: flex; justify-content: space-between; align-items: flex-end; }
        .header h1 { margin: 0; font-size: 24px; font-weight: 900; letter-spacing: -1px; }
        
        .live-container {
            display: inline-flex; align-items: center; gap: 8px;
            background: rgba(34, 197, 94, 0.1); padding: 6px 14px;
            border-radius: 100px; border: 1px solid rgba(34, 197, 94, 0.2);
        }
        .dot { width: 8px; height: 8px; background: #22c55e; border-radius: 50%; animation: pulse 2s infinite; }
        @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.3; } 100% { opacity: 1; } }
        .live-text { font-family: ui-monospace, monospace; font-size: 11px; font-weight: 800; color: #22c55e; }
        .timestamp { font-family: ui-monospace, monospace; font-size: 11px; color: #94a3b8; }

        .readings-grid, .graphs-grid { 
            display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); 
            gap: 20px; width: 100%; margin-bottom: 20px; 
        }
        .card, .graph-card { 
            background: var(--card); padding: 28px; border-radius: 28px; 
            border: 1px solid var(--border); position: relative; width: 100%;
            transition: border-color 0.3s ease;
        }
        .card:hover { border-color: #374151; }

        .label { color: #94a3b8; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 8px; }
        .main-val { font-size: 42px; font-weight: 900; margin: 4px 0; display: flex; align-items: baseline; letter-spacing: -1.5px; }
        .unit { font-size: 20px; font-weight: 600; color: #4b5563; margin-left: 6px; }
        .minor-line { font-size: 15px; font-weight: 700; margin: 4px 0 12px 0; display: flex; align-items: center; gap: 8px; }
        .trend-line { font-size: 12px; font-weight: 700; margin-bottom: 18px; display: flex; align-items: center; gap: 6px; }

        .sub-box-4 { 
            display: grid; grid-template-columns: 1fr 1fr; gap: 8px; 
            padding-top: 18px; border-top: 1px solid rgba(255, 255, 255, 0.05); 
        }
        .badge { padding: 12px; border-radius: 16px; background: rgba(255, 255, 255, 0.03); display: flex; flex-direction: column; gap: 4px; }
        .badge-label { font-size: 9px; color: #6b7280; text-transform: uppercase; font-weight: 800; }
        .badge-val { font-size: 14px; font-weight: 700; }

        .status-pill {
            padding: 4px 10px; border-radius: 6px; font-size: 10px; font-weight: 900; text-transform: uppercase;
        }

        .compass-ui { position: absolute; top: 25px; right: 25px; width: 50px; height: 50px; border: 2px solid #374151; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.2); }
        #needle { width: 3px; height: 32px; background: linear-gradient(to bottom, var(--max-t) 50%, #fff 50%); clip-path: polygon(50% 0%, 100% 100%, 0% 100%); transition: transform 1.5s cubic-bezier(0.4, 0, 0.2, 1); }

        .graph-card { height: 320px; padding: 25px 15px 15px 15px; }

        @media (max-width: 768px) { 
            body { padding: 16px; } .header { flex-direction: column; align-items: flex-start; gap: 12px; }
            .readings-grid, .graphs-grid { grid-template-columns: 1fr; } 
            .main-val { font-size: 38px; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div>
                <h1>Kk Nagar Weather Station</h1>
                <div class="live-container">
                    <div class="dot"></div><span class="live-text">LIVE</span><span class="timestamp" id="ts">SYNCING...</span>
                </div>
            </div>
        </div>

        <div class="readings-grid">
            <div class="card">
                <div class="label">Temperature & Comfort</div>
                <div class="main-val"><span id="t">--</span><span class="unit">°C</span></div>
                <div class="minor-line" style="color:var(--accent)">RealFeel: <span id="rf">--</span>°C</div>
                <div id="tr" class="trend-line">--</div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Today High</span><span id="mx" class="badge-val" style="color:var(--max-t)">--</span></div>
                    <div class="badge"><span class="badge-label">Today Low</span><span id="mn" class="badge-val" style="color:var(--min-t)">--</span></div>
                    <div class="badge"><span class="badge-label">Humidity</span><span id="h" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Dew Point</span><span id="dp" class="badge-val">--</span></div>
                </div>
            </div>

            <div class="card">
                <div class="label">Wind Dynamics</div>
                <div class="compass-ui"><div id="needle"></div></div>
                <div class="main-val"><span id="w">--</span><span class="unit">km/h</span></div>
                <div id="wg" class="minor-line" style="color:var(--wind)">--</div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Daily Peak</span><span id="mw" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Max Gust</span><span id="mg" class="badge-val">--</span></div>
                </div>
            </div>

            <div class="card">
                <div class="label">Atmospheric</div>
                <div class="main-val"><span id="sol">--</span><span class="unit">W/m²</span></div>
                <div class="minor-line" style="color:#fbbf24">UV Index: <span id="uv">--</span></div>
                <div class="sub-box-4" style="grid-template-columns: 1fr;">
                    <div class="badge"><span class="badge-label">Barometer</span><span id="pr" class="badge-val">--</span></div>
                </div>
            </div>

            <div class="card">
                <div class="label">Precipitation</div>
                <div class="main-val"><span id="r">--</span><span class="unit">mm</span></div>
                <div class="minor-line">
                    <span id="rr_main" style="color:var(--rain)">Rate: -- mm/h</span>
                    <span id="rain_status" class="status-pill">--</span>
                </div>
                <div class="sub-box-4" style="grid-template-columns: 1fr;">
                    <div class="badge"><span class="badge-label">Daily Max Intensity</span><span id="mr" class="badge-val" style="color:var(--rain)">--</span></div>
                </div>
            </div>
        </div>

        <div class="graphs-grid">
            <div class="graph-card"><canvas id="cT"></canvas></div>
            <div class="graph-card"><canvas id="cH"></canvas></div>
            <div class="graph-card"><canvas id="cW"></canvas></div>
            <div class="graph-card"><canvas id="cR"></canvas></div>
        </div>
    </div>

    <script>
        let charts = {};
        function setupChart(id, label, col, minZero = false) {
            const ctx = document.getElementById(id).getContext('2d');
            return new Chart(ctx, {
                type: 'line',
                data: { labels: [], datasets: [{ label: label, data: [], borderColor: col, tension: 0.4, pointRadius: 0, borderWidth: 3, fill: true, backgroundColor: col + '10' }]},
                options: { 
                    responsive: true, maintainAspectRatio: false, 
                    plugins: { legend: { labels: { color: '#94a3b8', font: { weight: '800', size: 12 } } } },
                    scales: { 
                        x: { ticks: { color: '#6b7280', font: { size: 10 } }, grid: { display: false } }, 
                        y: { beginAtZero: minZero, ticks: { color: '#6b7280' }, grid: { color: 'rgba(255, 255, 255, 0.05)' } } 
                    }
                }
            });
        }

        function getRainStatus(rate) {
            if (rate <= 0) return { text: 'Dry', bg: 'rgba(255,255,255,0.05)', color: '#94a3b8' };
            if (rate < 2.5) return { text: 'Light Rain', bg: 'rgba(56,189,248,0.1)', color: '#38bdf8' };
            if (rate < 7.6) return { text: 'Moderate', bg: 'rgba(129,140,248,0.15)', color: '#818cf8' };
            if (rate < 50) return { text: 'Heavy Rain', bg: 'rgba(248,113,113,0.15)', color: '#f87171' };
            return { text: 'Flood Warning', bg: '#f87171', color: '#fff' };
        }

        async function update() {
            try {
                const res = await fetch('/weather?v=' + Date.now());
                const d = await res.json();
                if (d.error) return;

                document.getElementById('t').innerText = d.temp.current;
                document.getElementById('rf').innerText = d.temp.realFeel;
                
                // Enhanced Trend Arrows
                const trendIcon = d.temp.trend > 0 ? '↗' : d.temp.trend < 0 ? '↘' : '→';
                document.getElementById('tr').innerHTML = \`<span style="color:\${d.temp.trend > 0 ? 'var(--max-t)' : d.temp.trend < 0 ? '#22c55e' : '#94a3b8'}">\${trendIcon} \${Math.abs(d.temp.trend)}°C/hr Trend</span>\`;
                
                document.getElementById('mx').innerText = d.temp.max + '°C';
                document.getElementById('mn').innerText = d.temp.min + '°C';
                document.getElementById('h').innerText = d.atmo.hum + '%';
                document.getElementById('dp').innerText = d.atmo.dew + '°C';
                
                document.getElementById('w').innerText = d.wind.speed;
                document.getElementById('wg').innerText = d.wind.card + ' | Gust ' + d.wind.gust + ' km/h';
                document.getElementById('mw').innerText = d.wind.maxS + ' km/h';
                document.getElementById('mg').innerText = d.wind.maxG + ' km/h';
                document.getElementById('needle').style.transform = \`rotate(\${d.wind.deg}deg)\`;

                document.getElementById('sol').innerText = d.solar.rad;
                document.getElementById('uv').innerText = d.solar.uvi;
                document.getElementById('pr').innerText = Math.round(d.atmo.press) + ' hPa';

                document.getElementById('r').innerText = d.rain.total;
                document.getElementById('rr_main').innerText = 'Rate: ' + d.rain.rate + ' mm/h';
                
                const rStat = getRainStatus(d.rain.rate);
                const rPill = document.getElementById('rain_status');
                rPill.innerText = rStat.text;
                rPill.style.background = rStat.bg;
                rPill.style.color = rStat.color;
                
                document.getElementById('mr').innerText = d.rain.maxR + ' mm/h';

                document.getElementById('ts').innerText = new Date(d.lastSync).toLocaleTimeString('en-IN', { hour12: false });

                const history = d.history;
                const labels = history.map(h => new Date(h.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }));
                
                if (!charts.cT) {
                    charts.cT = setupChart('cT', 'Temperature (°C)', '#38bdf8', false);
                    charts.cH = setupChart('cH', 'Humidity (%)', '#10b981', true);
                    charts.cW = setupChart('cW', 'Wind Speed (km/h)', '#fbbf24', true);
                    charts.cR = setupChart('cR', 'Rain Rate (mm/h)', '#818cf8', true);
                }

                charts.cT.data.labels = labels; charts.cT.data.datasets[0].data = history.map(h => h.temp); charts.cT.update('none');
                charts.cH.data.labels = labels; charts.cH.data.datasets[0].data = history.map(h => h.hum); charts.cH.update('none');
                charts.cW.data.labels = labels; charts.cW.data.datasets[0].data = history.map(h => h.wind); charts.cW.update('none');
                charts.cR.data.labels = labels; charts.cR.data.datasets[0].data = history.map(h => h.rain); charts.cR.update('none');

            } catch (error) {}
        }
        setInterval(update, 45000); update();
    </script>
</body>
</html>
    `);
});

module.exports = app;
