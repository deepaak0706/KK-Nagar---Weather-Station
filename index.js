const express = require("express");
const fs = require("fs");
const app = express();

const API_KEY = process.env.API_KEY;
const STATION_ID = "ICHENN63";
const DATA_FILE = "./data.json";

let todayHistory = [];
let todayMaxTemp = -Infinity;
let todayMinTemp = Infinity;
let todayMaxWind = 0;
let todayMaxGust = 0;
let todayMaxRainRate = 0;
let lastRain = null;
let lastTime = null;
let currentDate = new Date().toDateString();

// Load persisted data
try {
    const fileData = fs.readFileSync(DATA_FILE, "utf-8");
    const parsed = JSON.parse(fileData);
    if (parsed && parsed.currentDate === currentDate) {
        todayHistory = parsed.todayHistory || [];
        todayMaxTemp = parsed.todayMaxTemp || -Infinity;
        todayMinTemp = parsed.todayMinTemp || Infinity;
        todayMaxWind = parsed.todayMaxWind || 0;
        todayMaxGust = parsed.todayMaxGust || 0;
        todayMaxRainRate = parsed.todayMaxRainRate || 0;
        lastRain = parsed.lastRain || null;
        lastTime = parsed.lastTime || null;
    }
} catch (e) {
    todayHistory = [];
}

// Helper: save to file
function saveData() {
    const data = {
        currentDate,
        todayHistory,
        todayMaxTemp,
        todayMinTemp,
        todayMaxWind,
        todayMaxGust,
        todayMaxRainRate,
        lastRain,
        lastTime
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data), "utf-8");
}

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
        saveData();
    }

    try {
        const weatherRes = await fetch(
            `https://api.weather.com/v2/pws/observations/current?stationId=${STATION_ID}&format=json&units=m&apiKey=${API_KEY}`
        );
        if (!weatherRes.ok) throw new Error(`API error ${weatherRes.status}`);
        const weatherData = await weatherRes.json();
        const obs = weatherData.observations[0];
        if (!obs) throw new Error("No observations");

        const temp = obs.metric.temp;
        const wind = obs.metric.windSpeed || 0;
        const gust = obs.metric.windGust || 0;
        const rain = obs.metric.precipTotal || 0;

        // Rain rate calculation
        let rainRate = 0;
        if (lastRain !== null) {
            const diff = rain - lastRain;
            const t = (now - lastTime) / 1000;
            if (diff >= 0 && t > 0) rainRate = (diff * 3600) / t;
        }
        lastRain = rain;
        lastTime = now;

        todayMaxTemp = Math.max(todayMaxTemp, temp);
        todayMinTemp = Math.min(todayMinTemp, temp);
        todayMaxWind = Math.max(todayMaxWind, wind);
        todayMaxGust = Math.max(todayMaxGust, gust);
        todayMaxRainRate = Math.max(todayMaxRainRate, rainRate);

        todayHistory.push({
            ts: Date.now(),
            temp,
            hum: obs.humidity,
            wind,
            gust,
            rain,
            windDir: obs.winddir || 0
        });

        if (todayHistory.length > 1440) todayHistory.shift();

        saveData();

        res.json({
            obs,
            todayHistory,
            maxTemp: todayMaxTemp,
            minTemp: todayMinTemp,
            maxWind: todayMaxWind,
            maxGust: todayMaxGust,
            rainRate,
            maxRainRate: todayMaxRainRate,
            updatedTs: Date.now()
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "API fetch failed" });
    }
});

app.get("/", (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>KK Nagar Weather Station</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<style>
body { margin:0; font-family:Arial,sans-serif; background:linear-gradient(135deg,#0f172a,#1e293b); color:#fff; text-align:center; }
h1 { margin:10px; }
.card { background:rgba(255,255,255,0.07); border-radius:12px; padding:12px; margin:8px; }
.big { font-size:28px; font-weight:bold; }
.small { font-size:13px; opacity:0.7; }
.status { font-size:12px; opacity:0.6; margin-bottom:4px; }
.wind-arrow { font-size:28px; transition:0.5s; }
canvas { background:rgba(15,23,42,0.95); border-radius:12px; padding:8px; margin-top:12px; }
</style>
</head>
<body>
<h1>KK Nagar Weather Station</h1>
<div class="status" id="status">Loading...</div>

<div class="card">
<div id="temp" class="big">--°C</div>
<div id="range" class="small"></div>
</div>

<div class="card">
Humidity: <span id="hum"></span>%
</div>

<div class="card">
<div>Wind: <span id="wind"></span> km/h</div>
<div>Gust: <span id="gust"></span> km/h</div>
<div class="wind-arrow" id="arrow">⬆️</div>
<div class="small" id="winddir"></div>
<div class="small">Max Wind: <span id="maxWind"></span> km/h</div>
<div class="small">Max Gust: <span id="maxGust"></span> km/h</div>
</div>

<div class="card">
<div>Rain: <span id="rain"></span> mm</div>
<div>Rain Rate: <span id="rainRate"></span> mm/hr</div>
<div class="small">Max Rain Rate: <span id="maxRainRate"></span> mm/hr</div>
</div>

<canvas id="tempChart"></canvas>
<canvas id="humChart"></canvas>
<canvas id="windChart"></canvas>
<canvas id="rainChart"></canvas>

<script>
let charts = {};
function initCharts(){
    charts.temp = new Chart(document.getElementById("tempChart"), {type:"line", data:{labels:[], datasets:[{label:"Temperature (°C)", data:[], borderColor:'#67e8f9', tension:0.3}]}, options:{animation:false}});
    charts.hum = new Chart(document.getElementById("humChart"), {type:"line", data:{labels:[], datasets:[{label:"Humidity (%)", data:[], borderColor:'#4ade80', tension:0.3}]}, options:{animation:false}});
    charts.wind = new Chart(document.getElementById("windChart"), {type:"line", data:{labels:[], datasets:[{label:"Wind (km/h)", data:[], borderColor:'#fb923c', tension:0.3}]}, options:{animation:false}});
    charts.rain = new Chart(document.getElementById("rainChart"), {type:"line", data:{labels:[], datasets:[{label:"Rain (mm)", data:[], borderColor:'#f87171', tension:0.3}]}, options:{animation:false}});
}
function format(v){ return (v===undefined||isNaN(v))?'--':Number(v).toFixed(1); }
function toIST(ts){ return new Date(ts).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Kolkata'}); }

async function loadData(){
    try{
        const res = await fetch('/weather?ts='+Date.now());
        const data = await res.json();
        const d = data.obs;

        document.getElementById("status").innerText = "Last Updated: " + toIST(data.updatedTs);

        document.getElementById("temp").innerText = format(d.metric.temp)+"°C";
        document.getElementById("range").innerText = "Max: "+format(data.maxTemp)+"°C | Min: "+format(data.minTemp)+"°C";
        document.getElementById("hum").innerText = Math.round(d.humidity);
        document.getElementById("wind").innerText = format(d.metric.windSpeed);
        document.getElementById("gust").innerText = format(d.metric.windGust);
        document.getElementById("maxWind").innerText = format(data.maxWind);
        document.getElementById("maxGust").innerText = format(data.maxGust);
        document.getElementById("rain").innerText = format(d.metric.precipTotal);
        document.getElementById("rainRate").innerText = format(data.rainRate);
        document.getElementById("maxRainRate").innerText = format(data.maxRainRate);
        document.getElementById("arrow").style.transform = "rotate("+d.winddir+"deg)";
        document.getElementById("winddir").innerText = d.winddir+"°";

        const labels = data.todayHistory.map(h=>toIST(h.ts));
        charts.temp.data.labels = labels;
        charts.temp.data.datasets[0].data = data.todayHistory.map(h=>h.temp);
        charts.hum.data.labels = labels;
        charts.hum.data.datasets[0].data = data.todayHistory.map(h=>h.hum);
        charts.wind.data.labels = labels;
        charts.wind.data.datasets[0].data = data.todayHistory.map(h=>h.wind);
        charts.rain.data.labels = labels;
        charts.rain.data.datasets[0].data = data.todayHistory.map(h=>h.rain);

        charts.temp.update();
        charts.hum.update();
        charts.wind.update();
        charts.rain.update();
    }catch(e){ console.error(e); }
}

initCharts();
loadData();
setInterval(loadData,60000);
</script>

</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("✅ KK Nagar Weather Station running on port " + PORT));
