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
            --bg: #020617; --card: rgba(30, 41, 59, 0.7); --accent: #38bdf8; 
            --max-t: #fb7185; --min-t: #60a5fa; --wind: #fbbf24; 
            --rain: #818cf8; --border: rgba(255, 255, 255, 0.1);
            --grid-gap: 24px;
        }
        * { box-sizing: border-box; -webkit-font-smoothing: antialiased; }
        body { 
            margin: 0; font-family: 'Inter', -apple-system, sans-serif; 
            background: radial-gradient(circle at top left, #0f172a, #020617);
            color: #f8fafc; 
            padding: 32px 24px; display: flex; flex-direction: column; align-items: center;
            min-height: 100vh;
        }
        .container { width: 100%; max-width: 1200px; }
        
        .header { margin-bottom: 40px; display: flex; justify-content: space-between; align-items: center; width: 100%; }
        .header h1 { margin: 0; font-size: 28px; font-weight: 800; letter-spacing: -1.2px; background: linear-gradient(to right, #fff, #94a3b8); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        
        .live-container {
            display: inline-flex; align-items: center; gap: 10px;
            background: rgba(34, 197, 94, 0.05); padding: 8px 16px;
            border-radius: 100px; border: 1px solid rgba(34, 197, 94, 0.2);
            backdrop-filter: blur(8px);
        }
        .dot { width: 10px; height: 10px; background: #22c55e; border-radius: 50%; box-shadow: 0 0 12px rgba(34, 197, 94, 0.6); animation: pulse 2.5s infinite; }
        @keyframes pulse { 0% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.2); opacity: 0.5; } 100% { transform: scale(1); opacity: 1; } }
        .live-text { font-family: 'JetBrains Mono', monospace; font-size: 12px; font-weight: 800; color: #22c55e; letter-spacing: 1px; }
        .timestamp { font-family: 'JetBrains Mono', monospace; font-size: 12px; color: #64748b; }

        /* Unified Grid Alignment */
        .grid-layout { 
            display: grid; 
            grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); 
            gap: var(--grid-gap); 
            width: 100%; 
            margin-bottom: var(--grid-gap); 
        }

        .card, .graph-card { 
            background: var(--card); padding: 32px; border-radius: 32px; 
            border: 1px solid var(--border); position: relative; 
            backdrop-filter: blur(12px); box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.2);
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            width: 100%;
        }
        .card:hover { transform: translateY(-4px); border-color: rgba(255, 255, 255, 0.2); box-shadow: 0 25px 30px -5px rgba(0, 0, 0, 0.3); }

        .label { color: #94a3b8; font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 12px; }
        .main-val { font-size: 48px; font-weight: 900; margin: 4px 0; display: flex; align-items: baseline; letter-spacing: -2px; }
        .unit { font-size: 22px; font-weight: 600; color: #64748b; margin-left: 8px; }
        .minor-line { font-size: 16px; font-weight: 700; margin: 6px 0 16px 0; display: flex; align-items: center; gap: 8px; }
        .trend-line { font-size: 13px; font-weight: 700; margin-bottom: 20px; display: flex; align-items: center; gap: 8px; padding: 4px 10px; background: rgba(255,255,255,0.03); border-radius: 8px; width: fit-content; }

        .sub-box-4 { 
            display: grid; grid-template-columns: 1fr 1fr; gap: 10px; 
            padding-top: 20px; border-top: 1px solid rgba(255, 255, 255, 0.08); 
        }
        .badge { padding: 14px; border-radius: 20px; background: rgba(15, 23, 42, 0.4); display: flex; flex-direction: column; gap: 6px; border: 1px solid rgba(255,255,255,0.02); }
        .badge-label { font-size: 10px; color: #64748b; text-transform: uppercase; font-weight: 800; letter-spacing: 0.5px; }
        .badge-val { font-size: 15px; font-weight: 700; color: #f1f5f9; }

        .status-pill {
            padding: 6px 12px; border-radius: 8px; font-size: 11px; font-weight: 900; text-transform: uppercase; letter-spacing: 0.5px;
        }

        .compass-ui { position: absolute; top: 30px; right: 30px; width: 54px; height: 54px; border: 2.5px solid rgba(255,255,255,0.05); border-radius: 50%; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.3); box-shadow: inset 0 2px 4px rgba(0,0,0,0.5); }
        #needle { width: 4px; height: 34px; background: linear-gradient(to bottom, var(--max-t) 50%, #fff 50%); clip-path: polygon(50% 0%, 100% 100%, 50% 85%, 0% 100%); transition: transform 1.8s cubic-bezier(0.34, 1.56, 0.64, 1); }

        .graph-card { height: 340px; padding: 25px 20px 20px 20px; }

        @media (max-width: 768px) { 
            body { padding: 20px 16px; } 
            .header { flex-direction: column; align-items: flex-start; gap: 16px; }
            .grid-layout { grid-template-columns: 1fr; } 
            .main-val { font-size: 42px; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div>
                <h1>Kk Nagar Weather Station</h1>
                <div class="live-container">
                    <div class="dot"></div><span class="live-text">LIVE</span><span class="timestamp" id="ts">INITIALIZING...</span>
                </div>
            </div>
        </div>

        <div class="grid-layout">
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
                <div class="main-val"><span id="pr">--</span><span class="unit">hPa</span></div>
                <div class="minor-line" style="color:#64748b">Barometric Pressure</div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Solar Radiation</span><span id="sol" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">UV Index</span><span id="uv" class="badge-val" style="color:#fbbf24">--</span></div>
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
                    <div class="badge"><span class="badge-label">Daily Peak Intensity</span><span id="mr" class="badge-val" style="color:var(--rain)">--</span></div>
                </div>
            </div>
        </div>

        <div class="grid-layout">
            <div class="graph-card"><canvas id="cT"></canvas></div>
            <div class="graph-card"><canvas id="cH"></canvas></div>
            <div class="graph-card"><canvas id="cW"></canvas></div>
            <div class="graph-card"><canvas id="cR"></canvas></div>
        </div>
    </div>

    <script>
        let charts = {};
        Chart.defaults.color = '#64748b';
        Chart.defaults.font.family = "'Inter', sans-serif";

        function setupChart(id, label, col, minZero = false) {
            const ctx = document.getElementById(id).getContext('2d');
            const gradient = ctx.createLinearGradient(0, 0, 0, 300);
            gradient.addColorStop(0, col + '44');
            gradient.addColorStop(1, col + '00');

            return new Chart(ctx, {
                type: 'line',
                data: { labels: [], datasets: [{ 
                    label: label, data: [], borderColor: col, tension: 0.4, 
                    pointRadius: 0, borderWidth: 3, fill: true, 
                    backgroundColor: gradient, pointHoverRadius: 6,
                    pointHoverBackgroundColor: col, pointHoverBorderColor: '#fff', pointHoverBorderWidth: 2
                }]},
                options: { 
                    responsive: true, maintainAspectRatio: false, 
                    interaction: { intersect: false, mode: 'index' },
                    plugins: { legend: { labels: { color: '#f8fafc', font: { weight: '700', size: 12 } } } },
                    scales: { 
                        x: { ticks: { font: { size: 10 } }, grid: { display: false } }, 
                        y: { beginAtZero: minZero, ticks: { font: { size: 10 } }, grid: { color: 'rgba(255, 255, 255, 0.03)' } } 
                    }
                }
            });
        }

        function getRainStatus(rate) {
            if (rate <= 0) return { text: 'Dry', bg: 'rgba(255,255,255,0.05)', color: '#94a3b8' };
            if (rate < 2.5) return { text: 'Light Rain', bg: 'rgba(56,189,248,0.15)', color: '#38bdf8' };
            if (rate < 7.6) return { text: 'Moderate', bg: 'rgba(129,140,248,0.2)', color: '#818cf8' };
            if (rate < 50) return { text: 'Heavy Rain', bg: 'rgba(244,63,94,0.2)', color: '#f43f5e' };
            return { text: 'Flood Alert', bg: '#f43f5e', color: '#fff' };
        }

        async function update() {
            try {
                const res = await fetch('/weather?v=' + Date.now());
                const d = await res.json();
                if (d.error) return;

                document.getElementById('t').innerText = d.temp.current;
                document.getElementById('rf').innerText = d.temp.realFeel;
                
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

                document.getElementById('sol').innerText = d.solar.rad + ' W/m²';
                document.getElementById('uv').innerText = d.solar.uvi;
                document.getElementById('pr').innerText = Math.round(d.atmo.press);

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
                    charts.cT = setupChart('cT', 'Temperature Trend', '#38bdf8', false);
                    charts.cH = setupChart('cH', 'Humidity Trend', '#10b981', true);
                    charts.cW = setupChart('cW', 'Wind Speed Trend', '#fbbf24', true);
                    charts.cR = setupChart('cR', 'Rain Rate Trend', '#818cf8', true);
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
