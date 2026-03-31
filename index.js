const express = require("express");
const fs = require("fs");
const app = express();

const API_KEY = process.env.API_KEY;
const STATION_ID = "ICHENN63";

let cachedData = null;
let lastFetch = 0;
const DATA_FILE = "./weatherData.json";

// Load persistent data
let persistentData = {
    history: [],
    maxTemp: -Infinity,
    minTemp: Infinity,
    maxWind: 0,
    maxGust: 0,
    maxRainRate: 0,
    lastRain: null,
    lastTime: null,
    currentDate: new Date().toDateString()
};

try {
    if (fs.existsSync(DATA_FILE)) {
        const raw = fs.readFileSync(DATA_FILE);
        persistentData = JSON.parse(raw);
    }
} catch (err) {
    console.error("Error loading persistent data:", err);
}

function savePersistentData() {
    fs.writeFile(DATA_FILE, JSON.stringify(persistentData), err => {
        if (err) console.error("Error saving data:", err);
    });
}

app.get("/weather", async (req, res) => {
    const now = Date.now();
    const todayStr = new Date().toDateString();

    if (todayStr !== persistentData.currentDate) {
        persistentData.history = [];
        persistentData.maxTemp = -Infinity;
        persistentData.minTemp = Infinity;
        persistentData.maxWind = 0;
        persistentData.maxGust = 0;
        persistentData.maxRainRate = 0;
        persistentData.lastRain = null;
        persistentData.lastTime = null;
        persistentData.currentDate = todayStr;
        savePersistentData();
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

        // Rain rate
        let rainRate = 0;
        if (persistentData.lastRain !== null) {
            const diff = rain - persistentData.lastRain;
            const t = (now - persistentData.lastTime)/1000;
            if (diff >= 0 && t > 0) rainRate = (diff * 3600)/t;
        }
        persistentData.lastRain = rain;
        persistentData.lastTime = now;
        persistentData.maxRainRate = Math.max(persistentData.maxRainRate, rainRate);

        // Max tracking
        persistentData.maxTemp = Math.max(persistentData.maxTemp, temp);
        persistentData.minTemp = Math.min(persistentData.minTemp, temp);
        persistentData.maxWind = Math.max(persistentData.maxWind, wind);
        persistentData.maxGust = Math.max(persistentData.maxGust, gust);

        persistentData.history.push({
            ts: now,
            temp,
            hum: obs.humidity,
            wind,
            gust,
            rain,
            windDir: obs.winddir || 0
        });
        if (persistentData.history.length > 1440) persistentData.history.shift();

        savePersistentData();

        cachedData = {
            obs,
            history: persistentData.history,
            maxTemp: persistentData.maxTemp,
            minTemp: persistentData.minTemp,
            maxWind: persistentData.maxWind,
            maxGust: persistentData.maxGust,
            rainRate,
            maxRainRate: persistentData.maxRainRate,
            updatedTs: now
        };

        lastFetch = now;
        res.setHeader("Cache-Control", "no-store");
        res.json(cachedData);

    } catch (err) {
        console.error("API error:", err);
        if (cachedData) return res.json(cachedData);
        res.status(500).json({ error: "API error" });
    }
});

app.get("/", (req,res)=>{
res.send(`<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>KK Nagar Weather Station</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<style>
body { font-family:Arial; background:#0f172a; color:#fff; text-align:center; }
.card { background:#1e293b; margin:10px; padding:15px; border-radius:12px; }
.big { font-size:34px; font-weight:bold; }
.small { font-size:13px; opacity:0.7; }
.status { font-size:12px; opacity:0.6; }
.wind-arrow { font-size:30px; transition:0.5s; }
canvas { background:#1e293b; margin:10px auto; border-radius:12px; max-width:95%; }
</style>
</head>
<body>

<h2>KK Nagar Weather Station</h2>
<div class="status" id="status"></div>

<div class="card">
  <div id="temp" class="big">--</div>
  <div id="range" class="small"></div>
</div>

<div class="card">
  Humidity: <span id="hum"></span>%
</div>

<div class="card">
  <div>Wind: <span id="wind"></span> km/h</div>
  <div class="wind-arrow" id="arrow">⬆️</div>
  <div class="small" id="winddir"></div>
  <div>Gust: <span id="gust"></span> km/h</div>
  <div class="small">Max Wind: <span id="maxWind"></span></div>
  <div class="small">Max Gust: <span id="maxGust"></span></div>
</div>

<div class="card">
  <div>Rain: <span id="rain"></span> mm</div>
  <div>Rain Rate: <span id="rainRate"></span> mm/hr</div>
  <div class="small">Max Rain Rate: <span id="maxRainRate"></span> mm/hr</div>
</div>

<div class="card">
  <div>UV Index: <span id="uv"></span></div>
  <div>Solar Radiation: <span id="solar"></span></div>
</div>

<canvas id="tempChart"></canvas>
<canvas id="humChart"></canvas>
<canvas id="windChart"></canvas>
<canvas id="rainChart"></canvas>

<script>
let charts = {};
function initCharts(){
charts.temp = new Chart(document.getElementById("tempChart"), {type:"line",data:{labels:[],datasets:[{label:"Temp (°C)",data:[],borderColor:'#67e8f9',tension:0.3}]},options:{animation:false}});
charts.hum = new Chart(document.getElementById("humChart"), {type:"line",data:{labels:[],datasets:[{label:"Humidity (%)",data:[],borderColor:'#4ade80',tension:0.3}]},options:{animation:false}});
charts.wind = new Chart(document.getElementById("windChart"), {type:"line",data:{labels:[],datasets:[{label:"Wind (km/h)",data:[],borderColor:'#fb923c',tension:0.3}]},options:{animation:false}});
charts.rain = new Chart(document.getElementById("rainChart"), {type:"line",data:{labels:[],datasets:[{label:"Rain (mm)",data:[],borderColor:'#f87171',tension:0.3}]},options:{animation:false}});
}

function format(v){ return (v===undefined||isNaN(v))?'--':Number(v).toFixed(1); }

function toIST(ts){
    return new Date(ts).toLocaleTimeString("en-IN",{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Kolkata'});
}

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

    document.getElementById("arrow").style.transform = "rotate("+d.winddir+"deg)";
    document.getElementById("winddir").innerText = d.winddir+"°";

    const labels = data.history.map(h=>toIST(h.ts));
    charts.temp.data.labels = labels; charts.temp.data.datasets[0].data = data.history.map(h=>h.temp);
    charts.hum.data.labels = labels; charts.hum.data.datasets[0].data = data.history.map(h=>h.hum);
    charts.wind.data.labels = labels; charts.wind.data.datasets[0].data = data.history.map(h=>h.wind);
    charts.rain.data.labels = labels; charts.rain.data.datasets[0].data = data.history.map(h=>h.rain);

    charts.temp.update(); charts.hum.update(); charts.wind.update(); charts.rain.update();
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
