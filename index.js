const express = require("express");
const fetch = require("node-fetch");

const app = express();

const API_KEY = process.env.API_KEY;
const STATION_ID = "ICHENN63";

let cachedData = null;
let lastFetch = 0;
let history = [];

app.get("/weather", async (req, res) => {
    const now = Date.now();

    if (cachedData && (now - lastFetch < 10000)) {
        return res.json(cachedData);
    }

    try {
        const weatherRes = await fetch(
            `https://api.weather.com/v2/pws/observations/current?stationId=${STATION_ID}&format=json&units=m&apiKey=${API_KEY}`
        );
        const weatherData = await weatherRes.json();
        const obs = weatherData.observations[0];

        const sunRes = await fetch(
            `https://api.sunrise-sunset.org/json?lat=${obs.lat}&lng=${obs.lon}&formatted=0`
        );
        const sunData = await sunRes.json();

        history.push({
            time: new Date().toLocaleTimeString(),
            temp: obs.metric.temp,
            hum: obs.humidity,
            rain: obs.metric.precipTotal,
            windSpeed: obs.metric.windSpeed,
            windDir: obs.winddir
        });

        if (history.length > 30) history.shift();

        cachedData = {
            obs,
            sunrise: sunData.results.sunrise,
            sunset: sunData.results.sunset,
            history
        };

        lastFetch = now;

        res.json(cachedData);

    } catch (err) {
        res.json({ error: "Failed to fetch data" });
    }
});

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
    font-family:Arial, sans-serif;
    background:linear-gradient(135deg,#0f172a,#1e293b);
    color:white;
}

h1 {
    text-align:center;
    padding:20px;
    font-size:22px;
}

/* Sections */
.section {
    margin:15px;
    padding:20px;
    border-radius:16px;
    background:rgba(255,255,255,0.06);
    backdrop-filter: blur(10px);
}

/* Grid */
.grid {
    display:grid;
    grid-template-columns: repeat(auto-fit, minmax(130px,1fr));
    gap:16px;
}

/* Items */
.item {
    text-align:center;
}

.label {
    font-size:13px;
    opacity:0.7;
}

.value {
    font-size:22px;
    font-weight:bold;
}

/* Wind */
.wind-box {
    text-align:center;
}

.wind-arrow {
    font-size:30px;
    margin:10px 0;
}

/* Charts */
canvas {
    background:white;
    border-radius:10px;
    margin-top:15px;
}
</style>
</head>

<body>

<h1>KK Nagar Weather Station</h1>
<div id="updated" style="text-align:center; opacity:0.6;"></div>

<!-- Temperature -->
<div class="section">
<div class="grid">
    <div class="item"><div class="label">Temperature</div><div class="value" id="temp"></div></div>
    <div class="item"><div class="label">Feels Like</div><div class="value" id="feels"></div></div>
    <div class="item"><div class="label">Humidity</div><div class="value" id="hum"></div></div>
</div>
</div>

<!-- Rain -->
<div class="section">
<div class="grid">
    <div class="item"><div class="label">Rain Rate</div><div class="value" id="rain"></div></div>
    <div class="item"><div class="label">Total Rain</div><div class="value" id="totalRain"></div></div>
    <div class="item"><div class="label">Condition</div><div class="value" id="intensity"></div></div>
</div>
</div>

<!-- Wind -->
<div class="section">
<div class="wind-box">
    <div class="value" id="wind"></div>
    <div class="wind-arrow" id="arrow">⬆️</div>
    <div id="winddir" style="opacity:0.7;"></div>
</div>
</div>

<!-- Sun -->
<div class="section">
<div class="grid">
    <div class="item"><div class="label">UV</div><div class="value" id="uv"></div></div>
    <div class="item"><div class="label">Solar</div><div class="value" id="solar"></div></div>
    <div class="item"><div class="label">Sunrise</div><div class="value" id="sunrise"></div></div>
    <div class="item"><div class="label">Sunset</div><div class="value" id="sunset"></div></div>
</div>
</div>

<!-- Charts -->
<div class="section">
<h3>Trends</h3>
<canvas id="tempChart"></canvas>
<canvas id="humChart"></canvas>
<canvas id="rainChart"></canvas>
<canvas id="windSpeedChart"></canvas>
<canvas id="windDirChart"></canvas>
</div>

<script>
let lastRain=null;
let lastTime=null;

let tempChart, humChart, rainChart, windSpeedChart, windDirChart;

function format(v){ return Math.round(v); }

function getWindDirection(deg){
    const dirs=["N","NE","E","SE","S","SW","W","NW"];
    return dirs[Math.round(deg/45)%8];
}

function rainLevel(rate){
    if(rate === 0) return "None";
    if(rate < 2) return "Light";
    if(rate < 10) return "Moderate";
    return "Heavy";
}

function createCharts(){
    tempChart = new Chart(document.getElementById('tempChart'), {type:'line',data:{labels:[],datasets:[{data:[]}]},options:{animation:false}});
    humChart = new Chart(document.getElementById('humChart'), {type:'line',data:{labels:[],datasets:[{data:[]}]},options:{animation:false}});
    rainChart = new Chart(document.getElementById('rainChart'), {type:'line',data:{labels:[],datasets:[{data:[]}]},options:{animation:false}});
    windSpeedChart = new Chart(document.getElementById('windSpeedChart'), {type:'line',data:{labels:[],datasets:[{data:[]}]},options:{animation:false}});
    windDirChart = new Chart(document.getElementById('windDirChart'), {type:'line',data:{labels:[],datasets:[{data:[]}]},options:{animation:false}});
}

function updateCharts(hist){
    const labels = hist.map(h=>h.time);

    tempChart.data.labels = labels;
    tempChart.data.datasets[0].data = hist.map(h=>h.temp);

    humChart.data.labels = labels;
    humChart.data.datasets[0].data = hist.map(h=>h.hum);

    rainChart.data.labels = labels;
    rainChart.data.datasets[0].data = hist.map(h=>h.rain);

    windSpeedChart.data.labels = labels;
    windSpeedChart.data.datasets[0].data = hist.map(h=>h.windSpeed);

    windDirChart.data.labels = labels;
    windDirChart.data.datasets[0].data = hist.map(h=>h.windDir);

    tempChart.update();
    humChart.update();
    rainChart.update();
    windSpeedChart.update();
    windDirChart.update();
}

async function loadData(){
    const res = await fetch('/weather');
    const data = await res.json();

    const d = data.obs;

    const currentRain = d.metric.precipTotal;
    const now = Date.now();

    let rate = 0;

    if(lastRain !== null){
        const diff = currentRain - lastRain;
        const t = (now - lastTime)/1000;
        if(t > 0 && diff >= 0){
            rate = (diff * 3600 / t);
        }
    }

    lastRain = currentRain;
    lastTime = now;

    document.getElementById('temp').innerText = format(d.metric.temp)+"°C";
    document.getElementById('feels').innerText = format(d.metric.heatIndex)+"°C";
    document.getElementById('hum').innerText = format(d.humidity)+"%";

    document.getElementById('wind').innerText = format(d.metric.windSpeed)+" km/h";
    document.getElementById('arrow').style.transform = "rotate("+d.winddir+"deg)";
    document.getElementById('winddir').innerText = d.winddir+"° ("+getWindDirection(d.winddir)+")";

    document.getElementById('rain').innerText = format(rate)+" mm/hr";
    document.getElementById('totalRain').innerText = format(currentRain)+" mm";
    document.getElementById('intensity').innerText = rainLevel(rate);

    document.getElementById('uv').innerText = format(d.uv);
    document.getElementById('solar').innerText = format(d.solarRadiation);

    document.getElementById('sunrise').innerText = new Date(data.sunrise).toLocaleTimeString();
    document.getElementById('sunset').innerText = new Date(data.sunset).toLocaleTimeString();

    document.getElementById('updated').innerText = "Updated: " + new Date().toLocaleTimeString();

    updateCharts(data.history);
}

createCharts();
setInterval(loadData,10000);
loadData();
</script>

</body>
</html>
`);
});

app.listen(3000, () => console.log("Server running"));
