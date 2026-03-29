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
            rain: obs.metric.precipTotal
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

    } catch {
        res.json({ error: "Failed" });
    }
});

app.get("/", (req, res) => {
res.send(`
<!DOCTYPE html>
<html>
<head>
<title>KKNagar Weather Station</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>

<style>
body {
    margin:0;
    font-family:Arial;
    background:linear-gradient(135deg,#0f172a,#1e293b);
    color:white;
    text-align:center;
}
h1 { padding:15px; }

.container {
    display:grid;
    grid-template-columns:repeat(auto-fit,minmax(140px,1fr));
    gap:15px;
    padding:15px;
}

.card {
    background:rgba(255,255,255,0.05);
    backdrop-filter:blur(10px);
    padding:15px;
    border-radius:12px;
}

.value {
    font-size:22px;
    font-weight:bold;
}

.wind-arrow {
    font-size:30px;
    display:inline-block;
}

canvas {
    background:white;
    border-radius:10px;
    margin:10px;
}
</style>
</head>

<body>

<h1>KKNagar Weather Station</h1>

<div class="container">
<div class="card"><div>🌡 Temp</div><div class="value" id="temp"></div></div>
<div class="card"><div>🔥 Feels Like</div><div class="value" id="feels"></div></div>
<div class="card"><div>💧 Humidity</div><div class="value" id="hum"></div></div>

<div class="card">
<div>🌬 Wind</div>
<div class="value" id="wind"></div>
<div class="wind-arrow" id="arrow">⬆️</div>
</div>

<div class="card"><div>🌧 Rain Rate (Instant)</div><div class="value" id="rain"></div></div>
<div class="card"><div>🌧 Total Rain</div><div class="value" id="totalRain"></div></div>

<div class="card"><div>🌦 Intensity</div><div class="value" id="intensity"></div></div>

<div class="card"><div>☀️ UV</div><div class="value" id="uv"></div></div>
<div class="card"><div>🌞 Solar</div><div class="value" id="solar"></div></div>

<div class="card"><div>🌅 Sunrise</div><div class="value" id="sunrise"></div></div>
<div class="card"><div>🌇 Sunset</div><div class="value" id="sunset"></div></div>
</div>

<h2>📊 Trends</h2>
<canvas id="tempChart"></canvas>
<canvas id="humChart"></canvas>
<canvas id="rainChart"></canvas>

<script>
let lastRain=null;
let lastTime=null;

let tempChart, humChart, rainChart;

function format(v,d=1){ return Number(v).toFixed(d); }

function rainLevel(rate){
    if(rate < 2) return "Light";
    if(rate < 10) return "Moderate";
    return "Heavy";
}

function createCharts(){
    tempChart=new Chart(document.getElementById('tempChart'),{
        type:'line',
        data:{labels:[],datasets:[{label:'Temp',data:[]}]}
    });

    humChart=new Chart(document.getElementById('humChart'),{
        type:'line',
        data:{labels:[],datasets:[{label:'Humidity',data:[]}]}
    });

    rainChart=new Chart(document.getElementById('rainChart'),{
        type:'line',
        data:{labels:[],datasets:[{label:'Rain',data:[]}]}
    });
}

function updateCharts(hist){
    const labels=hist.map(h=>h.time);

    tempChart.data.labels=labels;
    tempChart.data.datasets[0].data=hist.map(h=>h.temp);

    humChart.data.labels=labels;
    humChart.data.datasets[0].data=hist.map(h=>h.hum);

    rainChart.data.labels=labels;
    rainChart.data.datasets[0].data=hist.map(h=>h.rain);

    tempChart.update();
    humChart.update();
    rainChart.update();
}

async function loadData(){
    const res=await fetch('/weather');
    const data=await res.json();

    const d = data.obs; // ✅ FIXED

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

    document.getElementById('temp').innerText = format(d.metric.temp) + " °C";
    document.getElementById('feels').innerText = format(d.metric.heatIndex) + " °C";
    document.getElementById('hum').innerText = format(d.humidity,0) + " %";
    document.getElementById('wind').innerText = format(d.metric.windSpeed) + " km/h";

    document.getElementById('rain').innerText = format(rate,2) + " mm/hr";
    document.getElementById('totalRain').innerText = format(currentRain,2) + " mm";

    document.getElementById('intensity').innerText = rainLevel(rate);

    document.getElementById('uv').innerText = format(d.uv,1);
    document.getElementById('solar').innerText = format(d.solarRadiation,0);

    document.getElementById('arrow').style.transform = "rotate(" + d.winddir + "deg)";

    const sunrise = new Date(data.sunrise).toLocaleTimeString();
    const sunset = new Date(data.sunset).toLocaleTimeString();

    document.getElementById('sunrise').innerText = sunrise;
    document.getElementById('sunset').innerText = sunset;

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
