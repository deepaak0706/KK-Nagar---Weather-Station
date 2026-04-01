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

// Persistence
const loadState = () => {
    if (fs.existsSync(DB_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            if (data.currentDate === state.currentDate) {
                state = { ...state, ...data };
            }
        } catch (e) { console.error("Load error:", e); }
    }
};

const saveState = () => {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(state, null, 2)); } 
    catch (e) { console.error("Save error:", e); }
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

        const tempC = parseFloat(((d.outdoor.temperature.value - 32) * 5 / 9).toFixed(1));
        const rainRateMm = parseFloat((d.rainfall.rain_rate.value * 25.4).toFixed(1));
        const totalRainMm = parseFloat((d.rainfall.daily.value * 25.4).toFixed(1));
        const windKmh = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));
        const gustKmh = parseFloat((d.wind.wind_gust.value * 1.60934).toFixed(1));

        if (tempC > state.maxTemp || state.maxTemp === -999) state.maxTemp = tempC;
        if (tempC < state.minTemp || state.minTemp === 999) state.minTemp = tempC;
        if (rainRateMm > state.todayMaxRainRate) state.todayMaxRainRate = rainRateMm;
        if (windKmh > state.todayMaxWindSpeed) state.todayMaxWindSpeed = windKmh;
        if (gustKmh > state.todayMaxWindGust) state.todayMaxWindGust = gustKmh;

        let rate = 0;
        if (state.todayHistory.length > 5) {
            const old = state.todayHistory[state.todayHistory.length - 5];
            rate = parseFloat((tempC - old.temp).toFixed(1));
        }

        const entry = {
            time: new Date().toISOString(),
            temp: tempC,
            hum: parseFloat(d.outdoor.humidity.value),
            windSpeed: windKmh,
            rainRate: rainRateMm
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
                totalRain: totalRainMm,
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
            history: state.todayHistory,
            lastSync: new Date().toISOString()
        };

        saveState();
        console.log(`Synced: ${tempC}°C at ${new Date().toLocaleTimeString('en-IN')}`);
    } catch (error) { console.error("Ecowitt Error:", error.message); }
}

loadState();
updateWeatherData();
setInterval(updateWeatherData, 35000); // Fetch slightly slower than UI to avoid overlap

app.get("/weather", (req, res) => res.json(state.cachedData || { error: "Loading..." }));

app.get("/", (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>KK Nagar Weather</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root { --bg: #0b0f1a; --card: rgba(23, 32, 53, 0.8); --accent: #38bdf8; }
        body { margin:0; font-family:'Segoe UI',sans-serif; background:var(--bg); color:#f1f5f9; padding:10px; }
        .container { max-width:1200px; margin:0 auto; }
        .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap:12px; margin-bottom:12px; }
        .card { background:var(--card); border:1px solid rgba(255,255,255,0.08); padding:18px; border-radius:12px; }
        .label { font-size:11px; font-weight:700; text-transform:uppercase; color: var(--accent); opacity:0.8; }
        .value { font-size:32px; font-weight:800; margin:8px 0; }
        .sub-grid { display:grid; grid-template-columns: 1fr 1fr; font-size:12px; gap:6px; border-top:1px solid rgba(255,255,255,0.1); padding-top:10px; }
        .stat-val { font-weight:700; text-align:right; }
        .up { color: #4ade80; } .down { color: #f87171; }
        .chart-box { height:200px; margin-top:10px; }
        #status { text-align:center; font-size:11px; padding:10px; border-radius:5px; margin-bottom:10px; }
        .status-ok { background: rgba(34, 197, 94, 0.1); color: #4ade80; }
        .status-warn { background: rgba(239, 68, 68, 0.1); color: #f87171; }
    </style>
</head>
<body>
    <div class="container">
        <h2 style="text-align:center; margin:10px 0;">KK Nagar Weather Station</h2>
        <div id="status" class="status-ok">Initializing...</div>

        <div class="grid">
            <div class="card">
                <div class="label">Temperature</div>
                <div id="temp" class="value">--</div>
                <div id="tempRate" style="font-size:13px; font-weight:bold;">--</div>
                <div class="sub-grid">
                    <span>Daily Max</span><span id="maxTemp" class="stat-val down">--</span>
                    <span>Daily Min</span><span id="minTemp" class="stat-val up">--</span>
                    <span>Feels Like</span><span id="feels" class="stat-val">--</span>
                </div>
            </div>

            <div class="card">
                <div class="label">Wind Conditions</div>
                <div id="windSpeed" class="value">--</div>
                <div id="windDirName" style="font-size:13px; font-weight:bold; color:var(--accent);">--</div>
                <div class="sub-grid">
                    <span>Max Speed</span><span id="maxWind" class="stat-val">--</span>
                    <span>Max Gust</span><span id="maxGust" class="stat-val">--</span>
                    <span>Direction</span><span id="windDeg" class="stat-val">--</span>
                </div>
            </div>

            <div class="card">
                <div class="label">Humidity & Pressure</div>
                <div id="hum" class="value">--</div>
                <div id="pressure" style="font-size:13px; font-weight:bold;">--</div>
                <div class="sub-grid">
                    <span>Dew Point</span><span id="dew" class="stat-val">--</span>
                    <span>UV Index</span><span id="uv" class="stat-val">--</span>
                    <span>Solar Rad</span><span id="solar" class="stat-val">--</span>
                </div>
            </div>

            <div class="card">
                <div class="label">Rainfall</div>
                <div id="rainTotal" class="value">--</div>
                <div id="rainRate" style="font-size:13px; font-weight:bold; color:#4ade80;">--</div>
                <div class="sub-grid">
                    <span>Daily Max Rate</span><span id="maxRain" class="stat-val">--</span>
                    <span>Rain Status</span><span id="rainStatus" class="stat-val">--</span>
                </div>
            </div>
        </div>

        <div class="grid">
            <div class="card chart-box"><canvas id="tempChart"></canvas></div>
            <div class="card chart-box"><canvas id="humChart"></canvas></div>
            <div class="card chart-box"><canvas id="windChart"></canvas></div>
            <div class="card chart-box"><canvas id="rainChart"></canvas></div>
        </div>
    </div>

    <script>
        let charts = {};

        function getCardinal(angle) {
            const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
            return directions[Math.round(angle / 22.5) % 16];
        }

        function createChart(id, label, color, minVal = null) {
            const ctx = document.getElementById(id).getContext('2d');
            return new Chart(ctx, {
                type: 'line',
                data: { labels: [], datasets: [{ label: label, data: [], borderColor: color, tension: 0.3, pointRadius: 0, borderWidth: 2 }]},
                options: { 
                    responsive: true, maintainAspectRatio: false,
                    scales: { 
                        y: { min: minVal, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#888', font: { size: 10 } } },
                        x: { ticks: { color: '#888', font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 6 } }
                    },
                    plugins: { legend: { display: false } }
                }
            });
        }

        async function updateUI() {
            try {
                const res = await fetch('/weather');
                const d = await res.json();
                if (d.error) return;

                const lastSync = new Date(d.lastSync);
                const isStale = (new Date() - lastSync) > 120000;
                const statusEl = document.getElementById('status');
                statusEl.className = isStale ? 'status-warn' : 'status-ok';
                statusEl.innerText = (isStale ? '⚠️ DATA STALE - Last Sync: ' : '🟢 LIVE - Updated: ') + lastSync.toLocaleTimeString('en-IN');

                // Update Cards
                document.getElementById('temp').innerText = d.outdoor.temp + '°C';
                document.getElementById('maxTemp').innerText = d.outdoor.maxTemp + '°C';
                document.getElementById('minTemp').innerText = d.outdoor.minTemp + '°C';
                document.getElementById('feels').innerText = d.outdoor.feelsLike + '°C';
                const r = d.outdoor.tempChangeRate;
                document.getElementById('tempRate').innerHTML = \`<span class="\${r >= 0 ? 'up' : 'down'}">\${r >= 0 ? '↑' : '↓'} \${Math.abs(r)}°C/hr</span>\`;

                document.getElementById('windSpeed').innerText = d.wind.speed + ' km/h';
                document.getElementById('windDeg').innerText = d.wind.direction + '°';
                document.getElementById('windDirName').innerText = 'Heading ' + getCardinal(d.wind.direction);
                document.getElementById('maxWind').innerText = d.wind.maxSpeed + ' km/h';
                document.getElementById('maxGust').innerText = d.wind.maxGust + ' km/h';

                document.getElementById('hum').innerText = d.outdoor.humidity + '%';
                document.getElementById('dew').innerText = d.outdoor.dewPoint + '°C';
                document.getElementById('pressure').innerText = d.pressure + ' hPa';
                document.getElementById('uv').innerText = d.solar_uv.uvi;
                document.getElementById('solar').innerText = d.solar_uv.solar + ' W/m²';

                document.getElementById('rainTotal').innerText = d.rainfall.totalRain + ' mm';
                document.getElementById('rainRate').innerText = d.rainfall.rainRate + ' mm/hr';
                document.getElementById('maxRain').innerText = d.rainfall.maxRainRate + ' mm/hr';
                document.getElementById('rainStatus').innerText = d.rainfall.rainRate > 0 ? 'Raining' : 'Dry';

                // Update Charts with IST labels
                const labels = d.history.map(h => new Date(h.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }));
                
                if (!charts.temp) {
                    charts.temp = createChart('tempChart', 'Temp °C', '#38bdf8');
                    charts.hum = createChart('humChart', 'Humidity %', '#4ade80', 0);
                    charts.wind = createChart('windChart', 'Wind Speed km/h', '#fb923c', 0);
                    charts.rain = createChart('rainChart', 'Rain Rate mm/h', '#818cf8', 0);
                }

                charts.temp.data.labels = labels;
                charts.temp.data.datasets[0].data = d.history.map(h => h.temp);
                charts.hum.data.labels = labels;
                charts.hum.data.datasets[0].data = d.history.map(h => h.hum);
                charts.wind.data.labels = labels;
                charts.wind.data.datasets[0].data = d.history.map(h => h.windSpeed);
                charts.rain.data.labels = labels;
                charts.rain.data.datasets[0].data = d.history.map(h => h.rainRate);

                Object.values(charts).forEach(c => c.update('none'));
            } catch (e) { console.error("UI Update Error", e); }
        }

        setInterval(updateUI, 30000);
        updateUI();
    </script>
</body>
</html>`);
});

app.listen(PORT, () => console.log(`🚀 Station online at port ${PORT}`));
