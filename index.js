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

// Persistence Logic
const loadState = () => {
    if (fs.existsSync(DB_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            if (data.currentDate === state.currentDate) {
                state = { ...state, ...data };
                console.log("✅ State restored.");
            }
        } catch (e) { console.error("❌ Load error:", e); }
    }
};

const saveState = () => {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(state, null, 2)); } 
    catch (e) { console.error("❌ Save error:", e); }
};

async function updateWeatherData() {
    const todayStr = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });

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

        // Highs/Lows logic
        if (tempC > state.maxTemp || state.maxTemp === -999) state.maxTemp = tempC;
        if (tempC < state.minTemp || state.minTemp === 999) state.minTemp = tempC;
        if (rainRateMm > state.todayMaxRainRate) state.todayMaxRainRate = rainRateMm;
        if (windKmh > state.todayMaxWindSpeed) state.todayMaxWindSpeed = windKmh;
        if (gustKmh > state.todayMaxWindGust) state.todayMaxWindGust = gustKmh;

        // Rate of Change (last 10 mins)
        let rate = 0;
        if (state.todayHistory.length > 10) {
            const old = state.todayHistory[state.todayHistory.length - 10];
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
    } catch (error) { console.error("Sync Error:", error.message); }
}

loadState();
updateWeatherData();
setInterval(updateWeatherData, 60000);

app.get("/weather", (req, res) => {
    if (!state.cachedData) return res.status(503).json({ error: "Initializing..." });
    res.json(state.cachedData);
});

app.get("/", (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>KK Nagar Weather</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root { --bg: #0f172a; --card: rgba(30, 41, 59, 0.7); --accent: #38bdf8; }
        body { margin:0; font-family:sans-serif; background:var(--bg); color:#f1f5f9; padding:15px; }
        .container { max-width:1100px; margin:0 auto; }
        .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap:15px; margin-bottom:20px; }
        .card { background:var(--card); border:1px solid rgba(255,255,255,0.1); padding:20px; border-radius:16px; backdrop-filter:blur(10px); }
        .label { font-size:12px; font-weight:700; text-transform:uppercase; opacity:0.6; margin-bottom:10px; color: var(--accent); }
        .value { font-size:36px; font-weight:800; margin-bottom:10px; }
        .sub-grid { display:grid; grid-template-columns: 1fr 1fr; font-size:13px; gap:8px; border-top:1px solid rgba(255,255,255,0.1); pt:10px; margin-top:10px; padding-top:10px;}
        .stat-label { opacity:0.7; }
        .stat-val { font-weight:700; }
        .up { color: #4ade80; } .down { color: #f87171; }
        .chart-container { margin-top:20px; }
        #status { text-align:center; font-size:12px; opacity:0.6; margin-bottom:15px; }
    </style>
</head>
<body>
    <div class="container">
        <h2 style="text-align:center; margin-bottom:5px;">KK Nagar Weather Station</h2>
        <div id="status">Connecting to sensors...</div>

        <div class="grid">
            <div class="card">
                <div class="label">Temperature</div>
                <div id="temp" class="value">--</div>
                <div id="tempRate" style="font-size:14px; margin-bottom:10px;">--</div>
                <div class="sub-grid">
                    <span class="stat-label">Daily Max:</span><span id="maxTemp" class="stat-val down">--</span>
                    <span class="stat-label">Daily Min:</span><span id="minTemp" class="stat-val up">--</span>
                    <span class="stat-label">Feels Like:</span><span id="feels" class="stat-val">--</span>
                </div>
            </div>

            <div class="card">
                <div class="label">Wind Speed</div>
                <div id="windSpeed" class="value">--</div>
                <div id="windDir" style="font-size:14px; margin-bottom:10px;">--</div>
                <div class="sub-grid">
                    <span class="stat-label">Max Speed:</span><span id="maxWind" class="stat-val">--</span>
                    <span class="stat-label">Max Gust:</span><span id="maxGust" class="stat-val">--</span>
                    <span class="stat-label">Current Gust:</span><span id="gust" class="stat-val">--</span>
                </div>
            </div>

            <div class="card">
                <div class="label">Rain & Humidity</div>
                <div id="hum" class="value">--</div>
                <div id="rainTotal" style="font-size:14px; margin-bottom:10px;">--</div>
                <div class="sub-grid">
                    <span class="stat-label">Rain Rate:</span><span id="rainRate" class="stat-val">--</span>
                    <span class="stat-label">Max Rate:</span><span id="maxRain" class="stat-val">--</span>
                    <span class="stat-label">Dew Point:</span><span id="dew" class="stat-val">--</span>
                </div>
            </div>
        </div>

        <div class="grid">
             <div class="card chart-container"><canvas id="tempChart"></canvas></div>
             <div class="card chart-container"><canvas id="humChart"></canvas></div>
             <div class="card chart-container"><canvas id="windChart"></canvas></div>
        </div>
    </div>

    <script>
        let charts = {};

        function createChart(id, label, color) {
            const ctx = document.getElementById(id).getContext('2d');
            return new Chart(ctx, {
                type: 'line',
                data: { labels: [], datasets: [{ label: label, data: [], borderColor: color, tension: 0.3, fill: false }]},
                options: { 
                    responsive: true, 
                    maintainAspectRatio: false,
                    plugins: { legend: { display: true, labels: { color: '#fff' } } },
                    scales: { 
                        x: { display: false }, 
                        y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#aaa' } } 
                    }
                }
            });
        }

        async function updateUI() {
            try {
                const res = await fetch('/weather');
                const d = await res.json();
                
                // Temp Section
                document.getElementById('temp').innerText = d.outdoor.temp + '°C';
                document.getElementById('maxTemp').innerText = d.outdoor.maxTemp + '°C';
                document.getElementById('minTemp').innerText = d.outdoor.minTemp + '°C';
                document.getElementById('feels').innerText = d.outdoor.feelsLike + '°C';
                const rate = d.outdoor.tempChangeRate;
                document.getElementById('tempRate').innerHTML = \`<span class="\${rate >= 0 ? 'up' : 'down'}">\${rate >= 0 ? '↑' : '↓'} \${Math.abs(rate)}°C/hr</span>\`;

                // Wind Section
                document.getElementById('windSpeed').innerText = d.wind.speed + ' km/h';
                document.getElementById('maxWind').innerText = d.wind.maxSpeed + ' km/h';
                document.getElementById('maxGust').innerText = d.wind.maxGust + ' km/h';
                document.getElementById('gust').innerText = d.wind.gust + ' km/h';
                document.getElementById('windDir').innerText = 'Direction: ' + d.wind.direction + '°';

                // Rain/Hum Section
                document.getElementById('hum').innerText = d.outdoor.humidity + '% Hum';
                document.getElementById('rainTotal').innerText = 'Today: ' + d.rainfall.totalRain + ' mm Rain';
                document.getElementById('rainRate').innerText = d.rainfall.rainRate + ' mm/h';
                document.getElementById('maxRain').innerText = d.rainfall.maxRainRate + ' mm/h';
                document.getElementById('dew').innerText = d.outdoor.dewPoint + '°C';

                // Charts
                const labels = d.history.map(h => new Date(h.time).toLocaleTimeString());
                if (!charts.temp) {
                    charts.temp = createChart('tempChart', 'Temp °C', '#38bdf8');
                    charts.hum = createChart('humChart', 'Humidity %', '#4ade80');
                    charts.wind = createChart('windChart', 'Wind km/h', '#fb923c');
                }

                charts.temp.data.labels = labels;
                charts.temp.data.datasets[0].data = d.history.map(h => h.temp);
                charts.hum.data.labels = labels;
                charts.hum.data.datasets[0].data = d.history.map(h => h.hum);
                charts.wind.data.labels = labels;
                charts.wind.data.datasets[0].data = d.history.map(h => h.windSpeed);

                Object.values(charts).forEach(c => c.update('none'));
                document.getElementById('status').innerText = '🟢 Live Update: ' + new Date().toLocaleTimeString();

            } catch (e) { console.error(e); }
        }

        setInterval(updateUI, 30000);
        updateUI();
    </script>
</body>
</html>`);
});

app.listen(PORT, () => console.log(`🚀 Station running on http://localhost:${PORT}`));
