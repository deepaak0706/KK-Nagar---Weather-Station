const express = require("express");
const app = express();

const API_KEY = process.env.API_KEY; // Wunderground API Key
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

    // 1 min cache
    if (cachedData && now - lastFetch < 60000) {
        return res.json(cachedData);
    }

    try {
        const r = await fetch(
            `https://api.weather.com/v2/pws/observations/current?stationId=${STATION_ID}&format=json&units=m&apiKey=${API_KEY}`
        );

        const json = await r.json();
        const obs = json.observations[0];

        const temp = obs.metric.temp;
        const wind = obs.metric.windSpeed || 0;
        const gust = obs.metric.windGust || 0;
        const rain = obs.metric.precipTotal || 0;
        const uv = obs.uv || 0;
        const solar = obs.solarRadiation || 0;

        // Rain rate calculation
        let rainRate = 0;
        if (lastRain !== null) {
            const diff = rain - lastRain;
            const t = (now - lastTime) / 1000;
            if (diff >= 0 && t > 0) rainRate = (diff * 3600) / t;
        }
        lastRain = rain;
        lastTime = now;
        todayMaxRainRate = Math.max(todayMaxRainRate, rainRate);

        // Max/Min tracking
        todayMaxTemp = Math.max(todayMaxTemp, temp);
        todayMinTemp = Math.min(todayMinTemp, temp);
        todayMaxWind = Math.max(todayMaxWind, wind);
        todayMaxGust = Math.max(todayMaxGust, gust);

        // Store RAW timestamp (for 24h graphs)
        todayHistory.push({
            ts: Date.now(),
            temp,
            hum: obs.humidity,
            wind,
            gust,
            rain,
            windDir: obs.winddir || 0,
            uv,
            solar
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
            updatedTs: Date.now()
        };

        lastFetch = now;
        res.setHeader("Cache-Control", "no-store");
        res.json(cachedData);

    } catch (err) {
        console.error("API Error:", err.message);
        if (cachedData) return res.json(cachedData);
        res.status(500).json({ error: "API error" });
    }
});

app.get("/", (req, res) => {
    res.send(`<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>KK Nagar Weather Station</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<style>
body { font-family:Arial,sans-serif; background:#0f172a; color:#fff; text-align:center; margin:0; padding:0;}
.card { background:#1e293b; margin:10px; padding:15px; border-radius:12px; }
.big { font-size:34px; font-weight:bold; }
.small { font-size:13px; opacity:0.7; }
.status { font-size:12px; opacity:0.6; margin-bottom:5px; }
.wind-arrow { font-size:30px; transition:0.5s; }
canvas { background:#0f172a; border-radius:10px; margin:10px; }
</style>
</head>
<body>

<h2>KK Nagar Weather Station</h2>
<div class="status" id="status">Loading...</div>

<div class="card">
  <div id="temp" class="big">--</div>
  <div id="range" class="small"></div>
</div>

<div class="card">
  Humidity: <span id="hum">--</span>%
</div>

<div class="card">
  <div>Wind: <span id="wind">--</span> km/h</div>
  <div class="wind-arrow" id="arrow">⬆️</div>
  <div class="small" id="winddir"></div>
  <div>Gust: <span id="gust">--</span> km/h</div>
  <div class="small">Max Wind: <span id="maxWind">--</span> km/h</div>
  <div class="small">Max Gust: <span id="maxGust">--</span> km/h</div>
</div>

<div class="card">
  <div>Rain: <span id="rain">--</span> mm</div>
  <div>Rain Rate: <span id="rainRate">--</span> mm/hr</div>
  <div class="small">Max Rain Rate: <span id="maxRainRate">--</span> mm/hr</div>
</div>

<div class="card">
  <div>UV Index: <span id="uv">--</span></div>
  <div>Solar Radiation: <span id="solar">--</span></div>
</div>

<canvas id="tempChart" height="100"></canvas>
<canvas id="humChart" height="100"></canvas>
<canvas id="windChart" height="100"></canvas>
<canvas id="rainChart" height="100"></canvas>

<script>
let charts = {};

function initCharts(){
    charts.temp = new Chart(document.getElementById("tempChart"), {type:"line", data:{labels:[], datasets:[{label:"Temp",data:[],borderColor:"#67e8f9",tension:0.3}]}, options:{animation:false}});
    charts.hum = new Chart(document.getElementById("humChart"), {type:"line", data:{labels:[], datasets:[{label:"Humidity",data:[],borderColor:"#4ade80",tension:0.3}]}, options:{animation:false}});
    charts.wind = new Chart(document.getElementById("windChart"), {type:"line", data:{labels:[], datasets:[{label:"Wind",data:[],borderColor:"#fb923c",tension:0.3}]}, options:{animation:false}});
    charts.rain = new Chart(document.getElementById("rainChart"), {type:"line", data:{labels:[], datasets:[{label:"Rain",data:[],borderColor:"#facc15",tension:0.3}]}, options:{animation:false}});
}

function format(v){ return (v===undefined||isNaN(v))?'--':Number(v).toFixed(1); }
function toIST(ts){ return new Date(ts).toLocaleTimeString("en-IN",{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Kolkata'}); }
function getWindDirection(deg){ const dirs=["N","NE","E","SE","S","SW","W","NW"]; return dirs[Math.round(deg/45)%8]; }

async function load(){
    const res = await fetch('/weather?ts='+Date.now());
    const data = await res.json();
    const d = data.obs;

    document.getElementById("status").innerText = "Last Updated: " + toIST(data.updatedTs);

    document.getElementById("temp").innerText = format(d.metric.temp)+"°C";
    document.getElementById("range").innerText = "Max: "+format(data.maxTemp)+"°C | Min: "+format(data.minTemp)+"°C";

    document.getElementById("hum").innerText = Math.round(d.humidity);

    document.getElementById("wind").innerText = format(d.metric.windSpeed);
    document.getElementById("gust").innerText = format(d.metric.windGust);

    document.getElementById("maxWind").innerText = format(data.maxWind)+" km/h";
    document.getElementById("maxGust").innerText = format(data.maxGust)+" km/h";

    document.getElementById("rain").innerText = format(d.metric.precipTotal);
    document.getElementById("rainRate").innerText = format(data.rainRate);
    document.getElementById("maxRainRate").innerText = format(data.maxRainRate);

    document.getElementById("uv").innerText = format(data.uv);
    document.getElementById("solar").innerText = format(data.solar);

    document.getElementById("arrow").style.transform = "rotate("+d.winddir+"deg)";
    document.getElementById("winddir").innerText = d.winddir+"° ("+getWindDirection(d.winddir)+")";

    const labels = data.history.map(h=>toIST(h.ts));

    charts.temp.data.labels = labels;
    charts.temp.data.datasets[0].data = data.history.map(h=>h.temp);

    charts.hum.data.labels = labels;
    charts.hum.data.datasets[0].data = data.history.map(h=>h.hum);

    charts.wind.data.labels = labels;
    charts.wind.data.datasets[0].data = data.history.map(h=>h.wind);

    charts.rain.data.labels = labels;
    charts.rain.data.datasets[0].data = data.history.map(h=>h.rain);

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
app.listen(PORT, () => console.log("✅ KK Nagar Weather Station running on port " + PORT));
