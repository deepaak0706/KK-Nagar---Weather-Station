const express = require("express");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
const app = express();

// Configuration
const APPLICATION_KEY = process.env.APPLICATION_KEY;
const API_KEY = process.env.API_KEY;
const MAC = process.env.MAC;
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "weather_db.json");

// State Management
let state = {
    cachedData: null,
    todayHistory: [],
    todayMaxRainRate: 0,
    todayMaxWindSpeed: 0,
    todayMaxWindGust: 0,
    currentDate: new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }),
    maxTemp: -999,
    minTemp: 999
};

// --- PERSISTENCE LOGIC ---
const loadState = () => {
    if (fs.existsSync(DB_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            if (data.currentDate === state.currentDate) {
                state = { ...state, ...data };
                console.log("✅ Previous state restored from disk.");
            }
        } catch (e) { console.error("❌ Failed to load state:", e); }
    }
};

const saveState = () => {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(state, null, 2));
    } catch (e) { console.error("❌ Failed to save state:", e); }
};

// --- CORE DATA FETCHING ---
async function updateWeatherData() {
    const todayStr = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });

    // Reset daily stats at midnight
    if (todayStr !== state.currentDate) {
        state.todayHistory = [];
        state.todayMaxRainRate = 0;
        state.todayMaxWindSpeed = 0;
        state.todayMaxWindGust = 0;
        state.maxTemp = -999;
        state.minTemp = 999;
        state.currentDate = todayStr;
    }

    try {
        const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}`;
        const response = await fetch(url);
        const ecowitt = await response.json();

        if (ecowitt.code !== 0) throw new Error(ecowitt.msg);
        const d = ecowitt.data;

        // Conversions
        const tempC = parseFloat(((d.outdoor.temperature.value - 32) * 5 / 9).toFixed(1));
        const rainRateMm = parseFloat((d.rainfall.rain_rate.value * 25.4).toFixed(1));
        const windKmh = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));
        const gustKmh = parseFloat((d.wind.wind_gust.value * 1.60934).toFixed(1));

        // Update Highs/Lows
        if (tempC > state.maxTemp) state.maxTemp = tempC;
        if (tempC < state.minTemp) state.minTemp = tempC;
        if (rainRateMm > state.todayMaxRainRate) state.todayMaxRainRate = rainRateMm;
        if (windKmh > state.todayMaxWindSpeed) state.todayMaxWindSpeed = windKmh;
        if (gustKmh > state.todayMaxWindGust) state.todayMaxWindGust = gustKmh;

        // Calculate Rate of Change
        let rate = 0;
        if (state.todayHistory.length > 5) {
            const old = state.todayHistory[state.todayHistory.length - 5];
            rate = parseFloat((tempC - old.temp).toFixed(2));
        }

        const entry = {
            time: new Date().toISOString(),
            temp: tempC,
            hum: parseFloat(d.outdoor.humidity.value),
            windSpeed: windKmh
        };

        state.todayHistory.push(entry);
        if (state.todayHistory.length > 1440) state.todayHistory.shift();

        state.cachedData = {
            outdoor: {
                temp: tempC,
                feelsLike: ((d.outdoor.feels_like.value - 32) * 5 / 9).toFixed(1),
                humidity: d.outdoor.humidity.value,
                dewPoint: ((d.outdoor.dew_point.value - 32) * 5 / 9).toFixed(1),
                tempChangeRate: rate,
                maxTemp: state.maxTemp,
                minTemp: state.minTemp
            },
            rainfall: {
                rainRate: rainRateMm,
                totalRain: (d.rainfall.daily.value * 25.4).toFixed(1),
                maxRainRate: state.todayMaxRainRate
            },
            wind: {
                speed: windKmh,
                gust: gustKmh,
                maxSpeed: state.todayMaxWindSpeed,
                maxGust: state.todayMaxWindGust,
                direction: d.wind.wind_direction.value
            },
            solar_uv: { solar: d.solar_and_uvi.solar.value, uvi: d.solar_and_uvi.uvi.value },
            pressure: (d.pressure.relative.value * 33.8639).toFixed(1),
            history: state.todayHistory
        };

        saveState();
        console.log(`📡 Data Updated: ${tempC}°C at ${new Date().toLocaleTimeString()}`);
    } catch (error) {
        console.error("❌ Ecowitt Sync Error:", error.message);
    }
}

// Initial Load & Background Interval
loadState();
updateWeatherData();
setInterval(updateWeatherData, 60000); // Fetch every 1 minute

// --- ROUTES ---
app.get("/weather", (req, res) => {
    if (!state.cachedData) return res.status(503).json({ error: "Station initializing..." });
    res.json(state.cachedData);
});

app.get("/", (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>KK Nagar Weather Station</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root { --bg: #0f172a; --card: rgba(30, 41, 59, 0.7); --accent: #38bdf8; }
        body { margin:0; font-family:'Inter',system-ui,sans-serif; background:var(--bg); color:#f1f5f9; }
        .container { max-width:1000px; margin:0 auto; padding:20px; }
        h1 { text-align:center; font-weight:800; color:var(--accent); margin-bottom:5px; }
        .status { text-align:center; font-size:12px; margin-bottom:20px; opacity:0.7; }
        .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap:15px; }
        .card { background:var(--card); border:1px solid rgba(255,255,255,0.1); padding:20px; border-radius:16px; backdrop-filter:blur(10px); }
        .label { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:1px; opacity:0.6; margin-bottom:8px; }
        .value { font-size:32px; font-weight:800; }
        .sub-val { font-size:13px; margin-top:8px; opacity:0.9; }
        .temp-hot { color: #fb923c; } .temp-mild { color: #4ade80; } .temp-cool { color: #38bdf8; }
        canvas { margin-top:20px; max-height:250px; }
        @keyframes pulse { 50% { opacity: 0.3; } }
        .live-dot { color:#22c55e; animation: pulse 2s infinite; }
    </style>
</head>
<body>
    <div class="container">
        <h1>KK Nagar Station</h1>
        <div id="status" class="status">Connecting...</div>

        <div class="grid">
            <div class="card">
                <div class="label">Temperature</div>
                <div id="temp" class="value">--</div>
                <div id="tempMeta" class="sub-val"></div>
            </div>
            <div class="card">
                <div class="label">Wind & Gust</div>
                <div id="wind" class="value">--</div>
                <div id="windMeta" class="sub-val"></div>
            </div>
            <div class="card">
                <div class="label">Rainfall</div>
                <div id="rain" class="value">--</div>
                <div id="rainMeta" class="sub-val"></div>
            </div>
            <div class="card">
                <div class="label">Atmosphere</div>
                <div id="atmo" class="value">--</div>
                <div id="atmoMeta" class="sub-val"></div>
            </div>
        </div>

        <div class="card" style="margin-top:20px;">
            <div class="label">24-Hour Trends</div>
            <canvas id="mainChart"></canvas>
        </div>
    </div>

    <script>
        let chart;
        function getTempClass(t) {
            if (t > 32) return 'temp-hot';
            if (t < 24) return 'temp-cool';
            return 'temp-mild';
        }

        async function updateUI() {
            try {
                const r = await fetch('/weather');
                const d = await r.json();
                
                const o = d.outdoor, w = d.wind, rn = d.rainfall;

                // Temp
                const tEl = document.getElementById('temp');
                tEl.innerText = o.temp + '°C';
                tEl.className = 'value ' + getTempClass(o.temp);
                document.getElementById('tempMeta').innerHTML = \`Feels like \${o.feelsLike}°C • \${o.tempChangeRate > 0 ? 'Rising ↑' : 'Falling ↓'}\`;

                // Wind
                document.getElementById('wind').innerText = w.speed + ' km/h';
                document.getElementById('windMeta').innerText = \`Gusts: \${w.gust} km/h • Dir: \${w.direction}°\`;

                // Rain
                document.getElementById('rain').innerText = rn.totalRain + ' mm';
                document.getElementById('rainMeta').innerText = \`Rate: \${rn.rainRate} mm/hr\`;

                // Atmosphere
                document.getElementById('atmo').innerText = o.humidity + '%';
                document.getElementById('atmoMeta').innerText = \`Pressure: \${d.pressure} hPa • UV: \${d.solar_uv.uvi}\`;

                // Chart
                const labels = d.history.map(h => new Date(h.time).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}));
                const temps = d.history.map(h => h.temp);
                
                if(!chart) {
                    const ctx = document.getElementById('mainChart').getContext('2d');
                    chart = new Chart(ctx, {
                        type: 'line',
                        data: { labels, datasets: [{ label: 'Temp °C', data: temps, borderColor: '#38bdf8', tension: 0.3, fill:true, backgroundColor: 'rgba(56, 189, 248, 0.1)' }]},
                        options: { plugins: { legend: { display: false } }, scales: { y: { grid: { color: 'rgba(255,255,255,0.05)' } }, x: { grid: { display: false } } } }
                    });
                } else {
                    chart.data.labels = labels;
                    chart.data.datasets[0].data = temps;
                    chart.update('none');
                }

                document.getElementById('status').innerHTML = \`<span class="live-dot">●</span> LIVE • Updated \${new Date().toLocaleTimeString()}\`;
            } catch (e) {
                document.getElementById('status').innerText = '⚠️ Connection Lost';
            }
        }

        setInterval(updateUI, 30000);
        updateUI();
    </script>
</body>
</html>`);
});

app.listen(PORT, () => console.log(`🚀 Station online at http://localhost:${PORT}`));
