const express = require("express");
const fetch = require("node-fetch");
const fs = require("fs");
const app = express();

const APPLICATION_KEY = process.env.APPLICATION_KEY;
const API_KEY = process.env.API_KEY;
const MAC = process.env.MAC;

/**
 * DATA PERSISTENCE CONFIGURATION
 * Vercel allows writing to the /tmp directory during the execution of a function.
 */
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

// Initialization: Load existing records from disk if they exist
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
    } catch (e) {
        console.log("Persistence: No valid previous data found, starting fresh.");
    }
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
    } catch (e) {
        // Fail silently - common in serverless environments
    }
}

const getCard = (a) => {
    const directions = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
    return directions[Math.round(a / 22.5) % 16];
};

async function syncWithEcowitt() {
    const now = Date.now();
    
    // Cache management: Refresh every 40 seconds
    if (state.cachedData && (now - state.lastFetchTime < 40000)) {
        return state.cachedData;
    }

    try {
        const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}`;
        const response = await fetch(url);
        const json = await response.json();
        const d = json.data;

        // Metric Unit Conversions
        const tempC = parseFloat(((d.outdoor.temperature.value - 32) * 5 / 9).toFixed(1));
        const dewC = parseFloat(((d.outdoor.dew_point.value - 32) * 5 / 9).toFixed(1));
        const rainRate = parseFloat((d.rainfall.rain_rate.value * 25.4).toFixed(1));
        const dailyRain = parseFloat((d.rainfall.daily.value * 25.4).toFixed(1));
        const windKmh = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));
        const gustKmh = parseFloat((d.wind.wind_gust.value * 1.60934).toFixed(1));
        const solar = d.solar_and_uvi?.solar?.value || 0;
        const uvi = d.solar_and_uvi?.uvi?.value || 0;

        // Daily Reset Check
        const today = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
        if (state.currentDate !== today) {
            state.currentDate = today;
            state.maxTemp = -999;
            state.minTemp = 999;
            state.maxWindSpeed = 0;
            state.maxGust = 0;
            state.maxRainRate = 0;
            state.todayHistory = [];
        }

        // Extreme Records Update
        let changed = false;
        if (tempC > state.maxTemp || state.maxTemp === -999) { state.maxTemp = tempC; changed = true; }
        if (tempC < state.minTemp || state.minTemp === 999) { state.minTemp = tempC; changed = true; }
        if (windKmh > state.maxWindSpeed) { state.maxWindSpeed = windKmh; changed = true; }
        if (gustKmh > state.maxGust) { state.maxGust = gustKmh; changed = true; }
        if (rainRate > state.maxRainRate) { state.maxRainRate = rainRate; changed = true; }
        
        if (changed) {
            saveToDisk();
        }

        // Trend Calculation
        let trend = 0;
        if (state.todayHistory.length >= 60) {
            trend = parseFloat((tempC - state.todayHistory[state.todayHistory.length - 60].temp).toFixed(1));
        } else if (state.todayHistory.length > 2) {
            const first = state.todayHistory[0];
            const hoursPassed = (now - new Date(first.time).getTime()) / 3600000;
            trend = parseFloat(((tempC - first.temp) / hoursPassed).toFixed(1));
        }

        // Update History Buffer
        state.todayHistory.push({ 
            time: new Date().toISOString(), 
            temp: tempC, 
            hum: d.outdoor.humidity.value, 
            wind: windKmh, 
            rain: rainRate,
            solar: solar
        });
        
        if (state.todayHistory.length > 300) {
            state.todayHistory.shift();
        }

        state.cachedData = {
            temp: { current: tempC, max: state.maxTemp, min: state.minTemp, trend: trend },
            atmo: { hum: d.outdoor.humidity.value, dew: dewC, press: (d.pressure.relative.value * 33.8639).toFixed(1) },
            wind: { speed: windKmh, gust: gustKmh, maxS: state.maxWindSpeed, maxG: state.maxGust, card: getCard(d.wind.wind_direction.value), deg: d.wind.wind_direction.value },
            rain: { total: dailyRain, rate: rainRate, maxR: state.maxRainRate },
            solar: { rad: solar, uvi: uvi },
            lastSync: new Date().toISOString(),
            history: state.todayHistory
        };
        
        state.lastFetchTime = now;
        return state.cachedData;
    } catch (e) {
        return state.cachedData || { error: "Station data temporarily unavailable" };
    }
}

app.get("/weather", async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const data = await syncWithEcowitt();
    res.json(data);
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
            --bg: #06080e; 
            --card: #111827; 
            --accent: #38bdf8; 
            --max-t: #f87171; 
            --min-t: #60a5fa; 
            --wind: #fbbf24; 
            --rain: #818cf8; 
            --border: #1e293b;
        }

        body { 
            margin: 0; 
            font-family: 'Inter', -apple-system, sans-serif; 
            background-color: var(--bg); 
            color: #f1f5f9; 
            padding: 20px; 
            overflow-x: hidden; 
        }

        .header { 
            margin-bottom: 30px; 
            padding-left: 5px;
        }

        .header h1 { 
            margin: 0; 
            font-size: 24px; 
            font-weight: 800; 
            letter-spacing: -0.5px; 
            color: #ffffff; 
        }

        .live-container {
            display: inline-flex;
            align-items: center;
            gap: 10px;
            margin-top: 12px;
            background: rgba(34, 197, 94, 0.08);
            padding: 6px 14px;
            border-radius: 100px;
            border: 1px solid rgba(34, 197, 94, 0.15);
        }

        .dot { 
            width: 8px; 
            height: 8px; 
            background-color: #22c55e; 
            border-radius: 50%; 
            box-shadow: 0 0 12px #22c55e; 
            animation: pulse-animation 2s infinite; 
        }

        @keyframes pulse-animation {
            0% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.4; transform: scale(0.9); }
            100% { opacity: 1; transform: scale(1); }
        }

        .live-text { 
            font-family: 'JetBrains Mono', monospace; 
            font-size: 12px; 
            font-weight: 800; 
            color: #22c55e; 
            letter-spacing: 1.5px; 
        }

        .timestamp { 
            font-family: 'JetBrains Mono', monospace; 
            font-size: 12px; 
            color: #64748b; 
        }

        .readings-grid { 
            display: grid; 
            grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); 
            gap: 20px; 
            margin-bottom: 40px; 
        }

        .card { 
            background-color: var(--card); 
            padding: 28px; 
            border-radius: 28px; 
            border: 1px solid var(--border); 
            position: relative; 
            overflow: hidden;
            transition: transform 0.2s ease, border-color 0.2s ease;
        }

        .card:hover {
            border-color: var(--accent);
        }

        .label { 
            color: #94a3b8; 
            font-size: 11px; 
            font-weight: 800; 
            text-transform: uppercase; 
            letter-spacing: 2px; 
            margin-bottom: 12px; 
        }

        .main-val { 
            font-size: 40px; 
            font-weight: 900; 
            margin: 4px 0; 
            letter-spacing: -1.5px; 
            display: flex;
            align-items: baseline;
        }

        .unit { 
            font-size: 20px; 
            font-weight: 600; 
            color: #475569; 
            margin-left: 6px; 
        }

        .trend-line { 
            font-size: 13px; 
            font-weight: 700; 
            margin-bottom: 20px; 
            display: flex; 
            align-items: center; 
            gap: 8px; 
        }

        .sub-box { 
            display: grid; 
            grid-template-columns: 1fr 1fr; 
            gap: 12px; 
            padding-top: 20px; 
            border-top: 1px solid rgba(255, 255, 255, 0.05); 
            margin-top: 5px; 
        }

        .badge { 
            padding: 10px; 
            border-radius: 14px; 
            font-size: 11px; 
            font-weight: 700; 
            background: rgba(0, 0, 0, 0.2); 
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .badge-label {
            font-size: 9px;
            color: #475569;
            text-transform: uppercase;
        }

        .compass-ui { 
            position: absolute; 
            top: 25px; 
            right: 25px; 
            width: 54px; 
            height: 54px; 
            border: 2px solid #1e293b; 
            border-radius: 50%; 
            display: flex; 
            align-items: center; 
            justify-content: center; 
            background: rgba(0,0,0,0.1);
        }

        #needle { 
            width: 3px; 
            height: 32px; 
            background: linear-gradient(to bottom, var(--max-t) 50%, #ffffff 50%); 
            clip-path: polygon(50% 0%, 100% 100%, 0% 100%); 
            transition: transform 1.8s cubic-bezier(0.17, 0.67, 0.83, 0.67); 
        }

        .graphs-grid { 
            display: grid; 
            grid-template-columns: repeat(auto-fit, minmax(450px, 1fr)); 
            gap: 20px; 
        }

        .graph-card { 
            background-color: var(--card); 
            padding: 20px; 
            border-radius: 28px; 
            height: 300px; 
            border: 1px solid var(--border); 
        }

        @media (max-width: 768px) { 
            body { padding: 15px; } 
            .readings-grid { grid-template-columns: 1fr; } 
            .graphs-grid { grid-template-columns: 1fr; } 
            .graph-card { height: 240px; }
            .main-val { font-size: 34px; }
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>Kk Nagar Weather Station</h1>
        <div class="live-container">
            <div class="dot"></div>
            <span class="live-text">LIVE</span>
            <span class="timestamp" id="ts">CONNECTING...</span>
        </div>
    </div>

    <div class="readings-grid">
        <div class="card">
            <div class="label">Temperature</div>
            <div class="main-val">
                <span id="t">--</span><span class="unit">°C</span>
            </div>
            <div id="tr" class="trend-line">--</div>
            <div class="sub-box">
                <div class="badge">
                    <span class="badge-label">Daily High</span>
                    <span id="mx" style="color:var(--max-t); font-size: 14px;">--</span>
                </div>
                <div class="badge">
                    <span class="badge-label">Daily Low</span>
                    <span id="mn" style="color:var(--min-t); font-size: 14px;">--</span>
                </div>
            </div>
        </div>

        <div class="card">
            <div class="label">Wind Speed</div>
            <div class="compass-ui"><div id="needle"></div></div>
            <div class="main-val">
                <span id="w">--</span><span class="unit">km/h</span>
            </div>
            <div id="wg" class="trend-line" style="color:var(--accent)">--</div>
            <div class="sub-box">
                <div class="badge">
                    <span class="badge-label">Today Max</span>
                    <span id="mw" style="color:var(--wind); font-size: 14px;">--</span>
                </div>
                <div class="badge">
                    <span class="badge-label">Peak Gust</span>
                    <span id="mg" style="color:var(--wind); font-size: 14px;">--</span>
                </div>
            </div>
        </div>

        <div class="card">
            <div class="label">Solar Radiation</div>
            <div class="main-val">
                <span id="sol">--</span><span class="unit">W/m²</span>
            </div>
            <div id="uvl" class="trend-line" style="color:#fbbf24">UV Index: <span id="uv">--</span></div>
            <div class="sub-box">
                <div class="badge">
                    <span class="badge-label">Dew Point</span>
                    <span id="dp" style="font-size: 14px;">--</span>
                </div>
                <div class="badge">
                    <span class="badge-label">Humidity</span>
                    <span id="h" style="font-size: 14px;">--</span>
                </div>
            </div>
        </div>

        <div class="card">
            <div class="label">Precipitation</div>
            <div class="main-val">
                <span id="r">--</span><span class="unit">mm</span>
            </div>
            <div id="rr" class="trend-line" style="color:var(--rain)">--</div>
            <div class="sub-box">
                <div class="badge">
                    <span class="badge-label">Max Rate</span>
                    <span id="mr" style="color:var(--rain); font-size: 14px;">--</span>
                </div>
                <div class="badge">
                    <span class="badge-label">Pressure</span>
                    <span id="pr" style="font-size: 14px;">--</span>
                </div>
            </div>
        </div>
    </div>

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
            return new Chart(ctx, {
                type: 'line',
                data: { 
                    labels: [], 
                    datasets: [{ 
                        label: label, 
                        data: [], 
                        borderColor: col, 
                        tension: 0.4, 
                        pointRadius: 0, 
                        borderWidth: 3, 
                        fill: true, 
                        backgroundColor: col + '15' 
                    }]
                },
                options: { 
                    responsive: true, 
                    maintainAspectRatio: false, 
                    plugins: { 
                        legend: { 
                            display: true, 
                            labels: { color: '#94a3b8', font: { size: 11, weight: 'bold' } } 
                        } 
                    },
                    scales: { 
                        x: { 
                            ticks: { color: '#475569', font: { size: 10 }, autoSkip: true, maxTicksLimit: 6 }, 
                            grid: { display: false } 
                        }, 
                        y: { 
                            beginAtZero: minZero, 
                            ticks: { color: '#475569' }, 
                            grid: { color: 'rgba(255, 255, 255, 0.05)' } 
                        } 
                    }
                }
            });
        }

        async function update() {
            try {
                const res = await fetch('/weather?v=' + Date.now());
                const d = await res.json();
                
                if (d.error) return;

                // UI Elements Update
                document.getElementById('t').innerText = d.temp.current;
                
                const trendIcon = d.temp.trend > 0 ? '▲' : d.temp.trend < 0 ? '▼' : '●';
                const trendColor = d.temp.trend >= 0 ? 'var(--max-t)' : '#22c55e';
                document.getElementById('tr').innerHTML = \`<span style="color:\${trendColor}">\${trendIcon} \${Math.abs(d.temp.trend)}°C/hr Trend</span>\`;
                
                document.getElementById('mx').innerText = d.temp.max + '°C';
                document.getElementById('mn').innerText = d.temp.min + '°C';
                
                document.getElementById('w').innerText = d.wind.speed;
                document.getElementById('wg').innerText = \`\${d.wind.card} | Gust \${d.wind.gust} km/h\`;
                document.getElementById('needle').style.transform = \`rotate(\${d.wind.deg}deg)\`;
                document.getElementById('mw').innerText = d.wind.maxS + ' km/h';
                document.getElementById('mg').innerText = d.wind.maxG + ' km/h';

                document.getElementById('sol').innerText = d.solar.rad;
                document.getElementById('uv').innerText = d.solar.uvi;
                document.getElementById('dp').innerText = d.atmo.dew + '°C';
                document.getElementById('h').innerText = d.atmo.hum + '%';

                document.getElementById('r').innerText = d.rain.total;
                document.getElementById('rr').innerText = 'Current Rate: ' + d.rain.rate + ' mm/h';
                document.getElementById('mr').innerText = d.rain.maxR + ' mm/h';
                document.getElementById('pr').innerText = Math.round(d.atmo.press) + ' hPa';

                document.getElementById('ts').innerText = new Date(d.lastSync).toLocaleTimeString('en-IN', { hour12: false });

                // Charts History Sync
                const history = d.history;
                const labels = history.map(h => new Date(h.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }));
                
                if (!charts.cT) {
                    charts.cT = setupChart('cT', 'Temperature (°C)', '#0ea5e9', false);
                    charts.cH = setupChart('cH', 'Humidity (%)', '#10b981', true);
                    charts.cW = setupChart('cW', 'Wind Speed (km/h)', '#fbbf24', true);
                    charts.cR = setupChart('cR', 'Rain Rate (mm/h)', '#818cf8', true);
                }

                charts.cT.data.labels = labels;
                charts.cT.data.datasets[0].data = history.map(h => h.temp);
                charts.cT.update('none');

                charts.cH.data.labels = labels;
                charts.cH.data.datasets[0].data = history.map(h => h.hum);
                charts.cH.update('none');

                charts.cW.data.labels = labels;
                charts.cW.data.datasets[0].data = history.map(h => h.wind);
                charts.cW.update('none');

                charts.cR.data.labels = labels;
                charts.cR.data.datasets[0].data = history.map(h => h.rain);
                charts.cR.update('none');

            } catch (error) {
                console.error("Fetch failed:", error);
            }
        }

        // Auto-refresh every 45 seconds
        setInterval(update, 45000);
        update();
    </script>
</body>
</html>
    `);
});

// Vercel handles the listener automatically
module.exports = app;
