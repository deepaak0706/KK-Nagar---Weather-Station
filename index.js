const express = require("express");
const app = express();

const API_KEY = process.env.API_KEY;        // ← Set this in Render → Environment Variables
const STATION_ID = "ICHENN63";              // ← Change to your actual Station ID

let cachedData = null;
let lastFetch = 0;
let history = [];

app.get("/weather", async (req, res) => {
    const now = Date.now();

    // Safe 60-second cache
    if (cachedData && (now - lastFetch < 60000)) {
        return res.json(cachedData);
    }

    try {
        console.log(`[${new Date().toISOString()}] Fetching data for ${STATION_ID}`);

        const weatherRes = await fetch(
            `https://api.weather.com/v2/pws/observations/current?stationId=${STATION_ID}&format=json&units=m&apiKey=${API_KEY}`
        );

        if (!weatherRes.ok) throw new Error(`API error: ${weatherRes.status}`);

        const weatherData = await weatherRes.json();
        const obs = weatherData.observations[0];

        if (!obs) throw new Error("No observations returned");

        // Sunrise / Sunset
        const sunRes = await fetch(
            `https://api.sunrise-sunset.org/json?lat=${obs.lat}&lng=${obs.lon}&formatted=0`
        );
        const sunData = await sunRes.json().catch(() => ({ results: { sunrise: null, sunset: null } }));

        // Update history
        history.push({
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            temp: obs.metric.temp,
            hum: obs.humidity,
            rain: obs.metric.precipTotal || 0,
            windSpeed: obs.metric.windSpeed || 0,
            windDir: obs.winddir || 0
        });

        if (history.length > 30) history.shift();

        cachedData = {
            obs,
            sunrise: sunData.results.sunrise,
            sunset: sunData.results.sunset,
            history
        };

        lastFetch = now;
        console.log("✅ Data updated successfully");
        res.json(cachedData);

    } catch (error) {
        console.error("❌ Weather API error:", error.message);
        if (cachedData) {
            console.log("Returning cached data");
            return res.json(cachedData);
        }
        res.status(500).json({ error: "Failed to fetch weather data" });
    }
});

// Beautiful Dashboard with Pressure & Dew Point
app.get("/", (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
<title>KK Nagar Weather Station</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<style>
    body { margin:0; font-family:Arial,sans-serif; background:linear-gradient(135deg,#0f172a,#1e293b); color:white; }
    h1 { text-align:center; padding:20px 10px; font-size:24px; margin:0; }
    .status { text-align:center; font-size:14px; margin:8px 0; opacity:0.85; }
    .section { margin:15px; padding:20px; border-radius:16px; background:rgba(255,255,255,0.06); backdrop-filter:blur(10px); }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:16px; }
    .item { text-align:center; }
    .label { font-size:13px; opacity:0.75; margin-bottom:4px; }
    .value { font-size:26px; font-weight:bold; }
    .wind-box { text-align:center; }
    .wind-arrow { font-size:42px; margin:12px 0; transition:transform 0.4s ease; }
    canvas { background:white; border-radius:12px; margin-top:15px; padding:10px; }
    .cool { color:#60a5fa; } .mild { color:#fbbf24; } .hot { color:#f97316; } .veryhot { color:#ef4444; }
</style>
</head>
<body>
<h1>KK Nagar Weather Station</h1>
<div id="status" class="status">Loading latest data...</div>

<div class="section">
<div class="grid">
    <div class="item"><div class="label">Temperature</div><div class="value" id="temp"></div></div>
    <div class="item"><div class="label">Feels Like</div><div class="value" id="feels"></div></div>
    <div class="item"><div class="label">Humidity</div><div class="value" id="hum"></div></div>
</div>
</div>

<div class="section">
<div class="grid">
    <div class="item"><div class="label">Rain Rate</div><div class="value" id="rain"></div></div>
    <div class="item"><div class="label">Total Rain</div><div class="value" id="totalRain"></div></div>
    <div class="item"><div class="label">Condition</div><div class="value" id="intensity"></div></div>
</div>
</div>

<div class="section">
<div class="wind-box">
    <div class="value" id="wind"></div>
    <div class="wind-arrow" id="arrow">⬆️</div>
    <div id="winddir"></div>
</div>
</div>

<div class="section">
<div class="grid">
    <div class="item"><div class="label">UV Index</div><div class="value" id="uv"></div></div>
    <div class="item"><div class="label">Solar Radiation</div><div class="value" id="solar"></div></div>
    <div class="item"><div class="label">Pressure</div><div class="value" id="pressure"></div></div>
    <div class="item"><div class="label">Dew Point</div><div class="value" id="dewpoint"></div></div>
</div>
</div>

<div class="section">
<div class="grid">
    <div class="item"><div class="label">Sunrise</div><div class="value" id="sunrise"></div></div>
    <div class="item"><div class="label">Sunset</div><div class="value" id="sunset"></div></div>
</div>
</div>

<div class="section">
<h3>Recent Trends</h3>
<canvas id="tempChart" height="120"></canvas>
<canvas id="humChart" height="120"></canvas>
<canvas id="windSpeedChart" height="120"></canvas>
</div>

<script>
let lastRain = null;
let lastTime = null;
let charts = {};

function format(v) { return isNaN(v) ? '--' : Math.round(v); }

function getWindDirection(deg) {
    const dirs = ["N","NE","E","SE","S","SW","W","NW"];
    return dirs[Math.round(deg / 45) % 8];
}

function rainLevel(rate) {
    if (rate === 0) return "No Rain";
    if (rate < 2) return "Light";
    if (rate < 10) return "Moderate";
    return "Heavy";
}

function getTempClass(temp) {
    if (temp <= 25) return "cool";
    if (temp < 35) return "mild";
    if (temp < 40) return "hot";
    return "veryhot";
}

function createCharts() {
    const opt = { animation: false, scales: { y: { beginAtZero: true } } };
    charts.temp = new Chart(document.getElementById('tempChart'), { type:'line', data:{labels:[], datasets:[{label:'Temp (°C)', data:[], borderColor:'#60a5fa'}]}, options:opt });
    charts.hum = new Chart(document.getElementById('humChart'), { type:'line', data:{labels:[], datasets:[{label:'Humidity (%)', data:[], borderColor:'#22c55e'}]}, options:opt });
    charts.wind = new Chart(document.getElementById('windSpeedChart'), { type:'line', data:{labels:[], datasets:[{label:'Wind (km/h)', data:[], borderColor:'#f59e0b'}]}, options:opt });
}

async function loadData() {
    try {
        const res = await fetch('/weather');
        const data = await res.json();

        if (data.error) {
            document.getElementById('status').innerHTML = \`⚠️ \${data.error}\`;
            return;
        }

        const d = data.obs;
        const currentRain = d.metric.precipTotal || 0;
        const now = Date.now();

        let rate = 0;
        if (lastRain !== null) {
            const diff = currentRain - lastRain;
            const t = (now - lastTime) / 1000;
            if (t > 0 && diff >= 0) rate = (diff * 3600 / t);
        }
        lastRain = currentRain;
        lastTime = now;

        const tempClass = getTempClass(d.metric.temp);

        document.getElementById('temp').innerHTML = \`<span class="\${tempClass}">\${format(d.metric.temp)}°C</span>\`;
        document.getElementById('feels').innerHTML = \`<span class="\${tempClass}">\${format(d.metric.heatIndex)}°C</span>\`;
        document.getElementById('hum').innerText = format(d.humidity) + "%";

        document.getElementById('wind').innerText = format(d.metric.windSpeed) + " km/h";
        document.getElementById('arrow').style.transform = \`rotate(\${d.winddir}deg)\`;
        document.getElementById('winddir').innerText = \`\${d.winddir}° (\${getWindDirection(d.winddir)})\`;

        document.getElementById('rain').innerText = format(rate) + " mm/hr";
        document.getElementById('totalRain').innerText = format(currentRain) + " mm";
        document.getElementById('intensity').innerText = rainLevel(rate);

        document.getElementById('uv').innerText = format(d.uv);
        document.getElementById('solar').innerText = format(d.solarRadiation);
        document.getElementById('pressure').innerText = format(d.metric.pressure) + " hPa";
        document.getElementById('dewpoint').innerText = format(d.metric.dewpt) + "°C";

        if (data.sunrise) document.getElementById('sunrise').innerText = new Date(data.sunrise).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
        if (data.sunset) document.getElementById('sunset').innerText = new Date(data.sunset).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});

        document.getElementById('status').innerHTML = \`✅ Updated: \${new Date().toLocaleTimeString()}\`;

        const labels = data.history.map(h => h.time);
        charts.temp.data.labels = labels; charts.temp.data.datasets[0].data = data.history.map(h => h.temp);
        charts.hum.data.labels = labels; charts.hum.data.datasets[0].data = data.history.map(h => h.hum);
        charts.wind.data.labels = labels; charts.wind.data.datasets[0].data = data.history.map(h => h.windSpeed);

        charts.temp.update();
        charts.hum.update();
        charts.wind.update();

    } catch (e) {
        document.getElementById('status').innerHTML = "⚠️ Connection issue - showing last known data";
    }
}

createCharts();
setInterval(loadData, 60000);
loadData();
</script>
</body>
</html>
`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(\`✅ KK Nagar Weather Station running on port \${PORT}\`);
    console.log(\`Station ID: \${STATION_ID}\`);
    console.log("Refresh interval: 60 seconds (API safe)");
});
