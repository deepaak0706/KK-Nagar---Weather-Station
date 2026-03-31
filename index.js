const express = require("express");
const app = express();

const API_KEY = process.env.API_KEY;
const STATION_ID = "ICHENN63";

let cachedData = null;
let lastFetch = 0;

let todayHistory = [];
let todayMaxTemp = -Infinity;
let todayMinTemp = Infinity;
let todayMaxWind = 0;
let todayMaxGust = 0;
let todayMaxRainRate = 0;

let lastRain = null;
let lastTime = null;

let currentDate = new Date().toDateString();

app.get("/weather", async (req, res) => {
    const now = Date.now();
    const todayStr = new Date().toDateString();

    if (todayStr !== currentDate) {
        todayHistory = [];
        todayMaxTemp = -Infinity;
        todayMinTemp = Infinity;
        todayMaxWind = 0;
        todayMaxGust = 0;
        todayMaxRainRate = 0;
        lastRain = null;
        lastTime = null;
        currentDate = todayStr;
    }

    if (cachedData && now - lastFetch < 60000) return res.json(cachedData);

    try {
        const r = await fetch(`https://api.weather.com/v2/pws/observations/current?stationId=${STATION_ID}&format=json&units=m&apiKey=${API_KEY}`);
        const json = await r.json();
        const obs = json.observations[0];

        const temp = obs.metric.temp;
        const wind = obs.metric.windSpeed || 0;
        const gust = obs.metric.windGust || 0;
        const rain = obs.metric.precipTotal || 0;
        const uv = obs.uv ?? 0;
        const solar = obs.solarRadiation ?? 0;

        let rainRate = 0;
        if (lastRain !== null) {
            const diff = rain - lastRain;
            const t = (now - lastTime) / 1000;
            if (diff >= 0 && t > 0) rainRate = (diff * 3600) / t;
        }

        lastRain = rain;
        lastTime = now;

        todayMaxRainRate = Math.max(todayMaxRainRate, rainRate);
        todayMaxTemp = Math.max(todayMaxTemp, temp);
        todayMinTemp = Math.min(todayMinTemp, temp);
        todayMaxWind = Math.max(todayMaxWind, wind);
        todayMaxGust = Math.max(todayMaxGust, gust);

        todayHistory.push({
            ts: now,
            temp,
            hum: obs.humidity,
            wind,
            rain,
            windDir: obs.winddir || 0
        });

        if (todayHistory.length > 1440) todayHistory.shift();

        cachedData = {
            obs,
            history: todayHistory,
            maxTemp: todayMaxTemp,
            minTemp: todayMinTemp,
            maxWind: todayMaxWind,
            maxGust: todayMaxGust,
            rainRate,
            maxRainRate: todayMaxRainRate,
            uv,
            solar,
            updatedTs: now
        };

        lastFetch = now;
        res.setHeader("Cache-Control", "no-store");
        res.json(cachedData);

    } catch (err) {
        if (cachedData) return res.json(cachedData);
        res.status(500).json({ error: "API error" });
    }
});

app.get("/", (req, res) => {
res.send(`<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>KK Nagar Weather</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>

<style>
body {
    margin:0;
    font-family:'Segoe UI',sans-serif;
    background:linear-gradient(135deg,#1e293b,#0f172a);
    color:#fff;
}

.container { padding:15px; }

h2 { text-align:center; margin-bottom:5px; }

.status { text-align:center; font-size:12px; opacity:0.6; margin-bottom:10px; }

/* TOP */
.top {
    display:flex;
    gap:10px;
}

.block {
    flex:1;
    background:rgba(255,255,255,0.05);
    border-radius:16px;
    padding:15px;
}

.label { opacity:0.7; font-size:14px; }
.big { font-size:42px; font-weight:600; }
.sub { font-size:14px; margin-top:6px; }

.up { color:#fb923c; }
.down { color:#60a5fa; }

/* WIND COMPASS */
.wind-card {
    margin-top:10px;
    background:rgba(255,255,255,0.05);
    border-radius:16px;
    padding:15px;
}

.compass {
    width:140px;
    height:140px;
    border-radius:50%;
    border:2px solid rgba(255,255,255,0.2);
    margin:auto;
    position:relative;
}

.arrow {
    position:absolute;
    top:50%;
    left:50%;
    transform-origin:50% 100%;
    font-size:28px;
    transform:translate(-50%,-100%) rotate(0deg);
}

.wind-info {
    text-align:center;
    margin-top:10px;
}

.wind-main {
    font-size:22px;
    font-weight:600;
}

.wind-sub {
    font-size:14px;
    opacity:0.8;
}

/* CARDS */
.card {
    margin-top:10px;
    background:rgba(255,255,255,0.05);
    border-radius:16px;
    padding:15px;
}

/* CHART */
canvas {
    background:#0f172a;
    border-radius:12px;
    margin-top:10px;
}
</style>
</head>

<body>

<div class="container">

<h2>Outdoor ☀️</h2>
<div id="status" class="status"></div>

<div class="top">
<div class="block">
<div class="label">Temperature</div>
<div id="temp" class="big">--</div>
<div id="range" class="sub"></div>
</div>

<div class="block">
<div class="label">Humidity</div>
<div id="hum" class="big">--</div>
<div id="feels" class="sub"></div>
<div id="dew" class="sub"></div>
</div>
</div>

<!-- WIND COMPASS -->
<div class="wind-card">
<div class="compass">
<div id="arrow" class="arrow">⬆️</div>
</div>

<div class="wind-info">
<div class="wind-main"><span id="wind"></span> km/h</div>
<div class="wind-sub">Dir: <span id="winddir"></span></div>
<div class="wind-sub">Gust: <span id="gust"></span> km/h</div>
<div class="wind-sub">Max: <span id="maxWind"></span> | Gust Max: <span id="maxGust"></span></div>
</div>
</div>

<div class="card">
<div>Rain: <span id="rain"></span> mm</div>
<div>Rain Rate: <span id="rainRate"></span> mm/hr</div>
<div class="sub">Max Rain Rate: <span id="maxRainRate"></span> mm/hr</div>
</div>

<div class="card">
<div>UV Index: <span id="uv"></span></div>
<div>Solar Radiation: <span id="solar"></span></div>
</div>

<canvas id="tempChart"></canvas>
<canvas id="humChart"></canvas>
<canvas id="windChart"></canvas>
<canvas id="rainChart"></canvas>

</div>

<script>
let charts={};

function initCharts(){
charts.temp=new Chart(tempChart,{type:'line',data:{labels:[],datasets:[{label:'Temp',data:[]}]},options:{animation:false}});
charts.hum=new Chart(humChart,{type:'line',data:{labels:[],datasets:[{label:'Humidity',data:[]}]},options:{animation:false}});
charts.wind=new Chart(windChart,{type:'line',data:{labels:[],datasets:[{label:'Wind',data:[]}]},options:{animation:false}});
charts.rain=new Chart(rainChart,{type:'line',data:{labels:[],datasets:[{label:'Rain',data:[]}]},options:{animation:false}});
}

function format(v){return isNaN(v)?'--':Number(v).toFixed(1);}
function toIST(ts){return new Date(ts).toLocaleTimeString("en-IN",{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Kolkata'});}

async function load(){
const res=await fetch('/weather?ts='+Date.now());
const data=await res.json();
const d=data.obs;

document.getElementById("status").innerText="Updated: "+toIST(data.updatedTs);

document.getElementById("temp").innerText=format(d.metric.temp)+"°C";
document.getElementById("range").innerHTML='<span class="up">↑ '+format(data.maxTemp)+'°C</span> <span class="down">↓ '+format(data.minTemp)+'°C</span>';

document.getElementById("hum").innerText=Math.round(d.humidity)+"%";
document.getElementById("feels").innerText="Feels "+format(d.metric.heatIndex)+"°C";
document.getElementById("dew").innerText="Dew "+format(d.metric.dewpt)+"°C";

document.getElementById("wind").innerText=format(d.metric.windSpeed);
document.getElementById("gust").innerText=format(d.metric.windGust);
document.getElementById("maxWind").innerText=format(data.maxWind)+" km/h";
document.getElementById("maxGust").innerText=format(data.maxGust)+" km/h";

document.getElementById("rain").innerText=format(d.metric.precipTotal);
document.getElementById("rainRate").innerText=format(data.rainRate);
document.getElementById("maxRainRate").innerText=format(data.maxRainRate);

document.getElementById("uv").innerText=format(data.uv);
document.getElementById("solar").innerText=format(data.solar);

document.getElementById("arrow").style.transform="translate(-50%,-100%) rotate("+d.winddir+"deg)";
document.getElementById("winddir").innerText=d.winddir+"°";

const labels=data.history.map(h=>toIST(h.ts));

charts.temp.data.labels=labels;
charts.temp.data.datasets[0].data=data.history.map(h=>h.temp);

charts.hum.data.labels=labels;
charts.hum.data.datasets[0].data=data.history.map(h=>h.hum);

charts.wind.data.labels=labels;
charts.wind.data.datasets[0].data=data.history.map(h=>h.wind);

charts.rain.data.labels=labels;
charts.rain.data.datasets[0].data=data.history.map(h=>h.rain);

charts.temp.update();
charts.hum.update();
charts.wind.update();
charts.rain.update();
}

initCharts();
load();
setInterval(load,60000);
</script>

</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Running on port "+PORT));
