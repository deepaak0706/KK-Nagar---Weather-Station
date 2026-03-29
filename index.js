const express = require("express");
const app = express();

const API_KEY = process.env.API_KEY;        // Set this in Render Environment Variables
const STATION_ID = "ICHENN63";              // ← Change if your Station ID is different

let cachedData = null;
let lastFetch = 0;
let history = [];

app.get("/weather", async (req, res) => {
    const now = Date.now();

    // Cache for 60 seconds (safe for WU API limits)
    if (cachedData && (now - lastFetch < 60000)) {
        return res.json(cachedData);
    }

    try {
        console.log(`Fetching weather data for station ${STATION_ID}...`);

        const weatherRes = await fetch(
            `https://api.weather.com/v2/pws/observations/current?stationId=${STATION_ID}&format=json&units=m&apiKey=${API_KEY}`
        );

        if (!weatherRes.ok) {
            throw new Error(`API responded with status ${weatherRes.status}`);
        }

        const weatherData = await weatherRes.json();
        const obs = weatherData.observations[0];

        if (!obs) {
            throw new Error("No observations returned from API");
        }

        // Get sunrise/sunset
        const sunRes = await fetch(
            `https://api.sunrise-sunset.org/json?lat=${obs.lat}&lng=${obs.lon}&formatted=0`
        );
        const sunData = await sunRes.json().catch(() => ({ results: { sunrise: null, sunset: null } }));

        // Update history
        history.push({
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            temp: obs.metric.temp,
            hum: obs.humidity,
            rain: obs.metric.precipTotal,
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
        console.log("Weather data updated successfully");
        res.json(cachedData);

    } catch (error) {
        console.error("Weather API error:", error.message);
        
        // Fallback to cached data if available
        if (cachedData) {
            console.log("Returning cached data due to API error");
            return res.json(cachedData);
        }
        
        res.status(500).json({ 
            error: "Failed to fetch latest weather data",
            message: error.message 
        });
    }
});

// Your original beautiful dashboard (unchanged UI)
app.get("/", (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
<title>KK Nagar Weather Station</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>

<style>
body {
    margin:0;
    font-family:Arial;
    background:linear-gradient(135deg,#0f172a,#1e293b);
    color:white;
}
h1 {
    text-align:center;
    padding:20px;
    font-size:22px;
}
.section {
    margin:15px;
    padding:20px;
    border-radius:16px;
    background:rgba(255,255,255,0.06);
    backdrop-filter: blur(10px);
}
.grid {
    display:grid;
    grid-template-columns: repeat(auto-fit, minmax(130px,1fr));
    gap:16px;
}
.item { text-align:center; }
.label {
    font-size:13px;
    opacity:0.7;
}
.value {
    font-size:22px;
    font-weight:bold;
}
.wind-box {
    text-align:center;
}
.wind-arrow {
    font-size:30px;
    margin:10px 0;
}
canvas {
    background:white;
    border-radius:10px;
    margin-top:15px;
}
.cool { color:#60a5fa; }
.mild { color:#f59e0b; }
.hot { color:#f97316; }
.veryhot { color:#ef4444; }
</style>
</head>

<body>
<h1>KK Nagar Weather Station</h1>
<div id="updated" style="text-align:center; opacity:0.6; margin-bottom:10px;"></div>

<div class="section">
<div class="grid">
    <div class="item">
        <div class="label">Temperature</div>
        <div class="value" id="temp"></div>
    </div>
    <div class="item">
        <div class="label">Feels Like</div>
        <div class="value" id="feels"></div>
    </div>
    <div class="item">
        <div class="label">Humidity</div>
        <div class="value" id="hum"></div>
    </div>
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
    <div class="item"><div class="label">UV</div><div class="value" id="uv"></div></div>
    <div class="item"><div class="label">Solar</div><div class="value" id="solar"></div></div>
    <div class="item"><div class="label">Sunrise</div><div class="value" id="sunrise"></div></div>
    <div class="item"><div class="label">Sunset</div><div class="value" id="sunset"></div></div>
</div>
</div>

<div class="section">
<h3>Trends (Last 30 points)</h3>
<canvas id="tempChart"></canvas>
<canvas id="humChart"></canvas>
<canvas id="rainChart"></canvas>
<canvas id="windSpeedChart"></canvas>
<canvas id="windDirChart"></canvas>
</div>

<script>
let lastRain = null;
let lastTime = null;
let tempChart, humChart, rainChart, windSpeedChart, windDirChart;

function format(v){ return Math.round(v); }

function getWindDirection(deg){
    const dirs = ["N","NE","E","SE","S","SW","W","NW"];
    return dirs[Math.round(deg/45) % 8];
}

function rainLevel(rate){
    if(rate === 0) return "None";
    if(rate < 2) return "Light";
    if(rate < 10) return "Moderate";
    return "Heavy";
}

function getTempClass(temp){
    if(temp <= 25) return "cool";
    if(temp < 35) return "mild";
    if(temp < 40) return "hot";
    return "veryhot";
}

function createCharts(){
    const options = { animation: false, scales: { y: { beginAtZero: true } } };

    tempChart = new Chart(document.getElementById('tempChart'), { type:'line', data:{labels:[], datasets:[{label:'Temperature (°C)', data:[], borderColor:'#60a5fa'}]}, options });
    humChart = new Chart(document.getElementById('humChart'), { type:'line', data:{labels:[], datasets:[{label:'Humidity (%)', data:[], borderColor:'#22c55e'}]}, options });
    rainChart = new Chart(document.getElementById('rainChart'), { type:'line', data:{labels:[], datasets:[{label:'Rain (mm)', data:[], borderColor:'#3b82f6'}]}, options });
    windSpeedChart = new Chart(document.getElementById('windSpeedChart'), { type:'line', data:{labels:[], datasets:[{label:'Wind Speed (km/h)', data:[], borderColor:'#f59e0b'}]}, options });
    windDirChart = new Chart(document.getElementById('windDirChart'), { type:'line', data:{labels:[], datasets:[{label:'Wind Direction (°)', data:[], borderColor:'#8b5cf6'}]}, options });
}

function updateCharts(hist){
    const labels = hist.map(h => h.time);
    tempChart.data.labels = labels; tempChart.data.datasets[0].data = hist.map(h => h.temp);
    humChart.data.labels = labels; humChart.data.datasets[0].data = hist.map(h => h.hum);
    rainChart.data.labels = labels; rainChart.data.datasets[0].data = hist.map(h => h.rain);
    windSpeedChart.data.labels = labels; windSpeedChart.data.datasets[0].data = hist.map(h => h.windSpeed);
    windDirChart.data.labels = labels; windDirChart.data.datasets[0].data = hist.map(h => h.windDir);

    tempChart.update();
    humChart.update();
    rainChart.update();
    windSpeedChart.update();
    windDirChart.update();
}

async function loadData(){
    try {
        const res = await fetch('/weather');
        const data = await res.json();
        
        if (data.error) {
            document.getElementById('updated').innerText = "Error: " + data.error;
            return;
        }

        const d = data.obs;
        const currentRain = d.metric.precipTotal;
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

        document.getElementById('temp').innerHTML = '<span class="'+tempClass+'">'+format(d.metric.temp)+'°C</span>';
        document.getElementById('feels').innerHTML = '<span class="'+tempClass+'">'+format(d.metric.heatIndex)+'°C</span>';
        document.getElementById('hum').innerText = format(d.humidity)+"%";

        document.getElementById('wind').innerText = format(d.metric.windSpeed)+" km/h";
        document.getElementById('arrow').style.transform = "rotate("+d.winddir+"deg)";
        document.getElementById('winddir').innerText = d.winddir+"° ("+getWindDirection(d.winddir)+")";

        document.getElementById('rain').innerText = format(rate)+" mm/hr";
        document.getElementById('totalRain').innerText = format(currentRain)+" mm";
        document.getElementById('intensity').innerText = rainLevel(rate);

        document.getElementById('uv').innerText = format(d.uv);
        document.getElementById('solar').innerText = format(d.solarRadiation);

        if (data.sunrise) document.getElementById('sunrise').innerText = new Date(data.sunrise).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
        if (data.sunset) document.getElementById('sunset').innerText = new Date(data.sunset).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});

        document.getElementById('updated').innerText = "Updated: " + new Date().toLocaleTimeString();

        updateCharts(data.history);
    } catch (e) {
        console.error("Frontend fetch error", e);
        document.getElementById('updated').innerText = "Connection error - using last known data";
    }
}

createCharts();
setInterval(loadData, 60000);   // Updated to 60 seconds
loadData();
</script>
</body>
</html>
`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ KK Nagar Weather Station running on port ${PORT}`);
    console.log(`Station ID: ${STATION_ID}`);
});
