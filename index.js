
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

    } catch (e) {
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
}

h1 {
    text-align:center;
    padding:15px;
}

.section {
    margin:15px;
    padding:15px;
    border-radius:15px;
    background:rgba(255,255,255,0.08);
    border:1px solid rgba(255,255,255,0.1);
    backdrop-filter: blur(12px);
    box-shadow:0 8px 32px rgba(0,0,0,0.3);
}

.section h2 {
    margin-bottom:10px;
    font-size:18px;
    border-bottom:1px solid rgba(255,255,255,0.2);
    padding-bottom:5px;
}

.grid {
    display:grid;
    grid-template-columns: repeat(auto-fit, minmax(120px,1fr));
    gap:12px;
}

.item {
    text-align:center;
    padding:8px;
}

.label {
    font-size:13px;
    opacity:0.7;
}

.value {
    font-size:20px;
    font-weight:bold;
}

.wind-arrow {
    font-size:18px;
}

canvas {
    background:white;
    border-radius:10px;
    margin-top:10px;
}
</style>
</head>

<body>

<h1>KKNagar Weather Station</h1>

<div id="updated" style="text-align:center; opacity:0.6;"></div>

<div class="section">
<h2>🌡 Temperature</h2>
<div class="grid">
    <div class="item"><div class="label">Temp</div><div class="value" id="temp"></div></div>
    <div class="item"><div class="label">Feels Like</div><div class="value" id="feels"></div></div>
    <div class="item"><div class="label">Humidity</div><div class="value" id="hum"></div></div>
</div>
</div>

<div class="section">
<h2>🌧 Rain</h2>
<div class="grid">
    <div class="item"><div class="label">Rain Rate</div><div class="value" id="rain"></div></div>
    <div class="item"><div class="label">Total Rain</div><div class="value" id="totalRain"></div></div>
    <div class="item"><div class="label">Intensity</div><div class="value" id="intensity"></div></div>
</div>
</div>

<div class="section">
<h2>🌬 Wind</h2>
<div class="grid">
    <div class="item">
        <div class="label">Wind</div>
        <div class="value" id="wind"></div>
        <div class="wind-arrow" id="arrow"></div>
    </div>
</div>
</div>

<div class="section">
<h2>☀️ Solar & Sun</h2>
<div class="grid">
    <div class="item"><div class="label">UV</div><div class="value" id="uv"></div></div>
    <div class="item"><div class="label">Solar</div><div class="value" id="solar"></div></div>
    <div class="item"><div class="label">Sunrise</div><div class="value" id="sunrise"></div></div>
    <div class="item"><div class="label">Sunset</div><div class="value" id="sunset"></div></div>
</div>
</div>

<div class="section">
<h2>📊 Trends</h2>
<canvas id="tempChart"></canvas>
<canvas id="humChart"></canvas>
<canvas id="rainChart"></canvas>
</div>

<script>
let lastRain=null;
let lastTime=null;

let tempChart, humChart, rainChart;

function format(v){
    return Math.round(v);
}

function getWindDirection(deg){
    const dirs = ["N","NE","E","SE","S","SW","W","NW"];
    return dirs[Math.round(deg / 45) % 8];
}

function rainLevel(rate){
    if(rate < 2) return "Light";
    if(rate < 10) return "Moderate";
    return "Heavy";
}

function rainEmoji(rate){
    if(rate < 2) return "🌦️";
    if(rate < 10) return "🌧️";
    return "⛈️";
}

function formatTime(t){
    return new Date(t).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
}

function setTheme(temp){
    if(temp < 25){
        document.body.style.background="linear-gradient(135deg,#1e3a8a,#0f172a)";
    } else if(temp < 35){
        document.body.style.background="linear-gradient(135deg,#0f766e,#1e293b)";
    } else {
        document.body.style.background="linear-gradient(135deg,#7f1d1d,#1e293b)";
    }
}

function createCharts(){
    tempChart=new Chart(document.getElementById('tempChart'),{
        type:'line',
        data:{labels:[],datasets:[{label:'Temp',data:[]}]},
        options:{animation:false,elements:{line:{tension:0.4}}}
    });

    humChart=new Chart(document.getElementById('humChart'),{
        type:'line',
        data:{labels:[],datasets:[{label:'Humidity',data:[]}]},
        options:{animation:false,elements:{line:{tension:0.4}}}
    });

    rainChart=new Chart(document.getElementById('rainChart'),{
        type:'line',
        data:{labels:[],datasets:[{label:'Rain',data:[]}]},
        options:{animation:false,elements:{line:{tension:0.4}}}
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

    setTheme(d.metric.temp);

    const diff = d.metric.heatIndex - d.metric.temp;

    document.getElementById('temp').innerText = format(d.metric.temp) + "°C";
    document.getElementById('feels').innerText =
        format(d.metric.heatIndex) + "°C (" + (diff>0?"+":"") + format(diff) + ")";
    document.getElementById('hum').innerText = format(d.humidity) + "%";

    document.getElementById('wind').innerText = format(d.metric.windSpeed) + " km/h";
    document.getElementById('arrow').innerHTML =
        format(d.winddir) + "° (" + getWindDirection(d.winddir) + ") ⬆️";
    document.getElementById('arrow').style.transform = "rotate(" + d.winddir + "deg)";

    document.getElementById('rain').innerText =
        rainEmoji(rate) + " " + format(rate) + " mm/hr";
    document.getElementById('totalRain').innerText = format(currentRain) + " mm";
    document.getElementById('intensity').innerText = rainLevel(rate);

    document.getElementById('uv').innerText = format(d.uv);
    document.getElementById('solar').innerText = format(d.solarRadiation);

    document.getElementById('sunrise').innerText = formatTime(data.sunrise);
    document.getElementById('sunset').innerText = formatTime(data.sunset);

    document.getElementById('updated').innerText =
        "Updated: " + new Date().toLocaleTimeString();

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
