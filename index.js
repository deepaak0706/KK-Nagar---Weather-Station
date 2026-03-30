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

    // Reset daily
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

    // Cache 1 min
    if (cachedData && now - lastFetch < 60000) {
        return res.json(cachedData);
    }

    try {
        const weatherRes = await fetch(
            `https://api.weather.com/v2/pws/observations/current?stationId=${STATION_ID}&format=json&units=m&apiKey=${API_KEY}`
        );

        const data = await weatherRes.json();
        const obs = data.observations[0];

        const temp = obs.metric.temp;
        const wind = obs.metric.windSpeed || 0;
        const gust = obs.metric.windGust || 0;
        const rain = obs.metric.precipTotal || 0;

        // Rain rate calculation
        let rainRate = 0;
        if (lastRain !== null) {
            const diff = rain - lastRain;
            const timeDiff = (now - lastTime) / 1000;
            if (diff >= 0 && timeDiff > 0) {
                rainRate = (diff * 3600) / timeDiff;
            }
        }

        lastRain = rain;
        lastTime = now;

        todayMaxRainRate = Math.max(todayMaxRainRate, rainRate);

        // Update max/min
        todayMaxTemp = Math.max(todayMaxTemp, temp);
        todayMinTemp = Math.min(todayMinTemp, temp);
        todayMaxWind = Math.max(todayMaxWind, wind);
        todayMaxGust = Math.max(todayMaxGust, gust);

        // Store history
        todayHistory.push({
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            temp,
            hum: obs.humidity,
            wind
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
            maxRainRate: todayMaxRainRate
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
body { font-family:Arial; background:#0f172a; color:#fff; text-align:center; }
.card { background:#1e293b; margin:10px; padding:15px; border-radius:12px; }
.big { font-size:34px; font-weight:bold; }
.small { font-size:13px; opacity:0.7; }
</style>
</head>

<body>

<h2>KK Nagar Weather Station</h2>

<div class="card">
<div id="temp" class="big">--</div>
<div id="range" class="small"></div>
</div>

<div class="card">
Humidity: <span id="hum"></span>%
</div>

<div class="card">
<div>Wind: <span id="wind"></span> km/h</div>
<div>Gust: <span id="gust"></span> km/h</div>
<div class="small">Max Wind: <span id="maxWind"></span></div>
<div class="small">Max Gust: <span id="maxGust"></span></div>
</div>

<div class="card">
<div>Rain: <span id="rain"></span> mm</div>
<div>Rain Rate: <span id="rainRate"></span> mm/hr</div>
<div class="small">Max Rain Rate: <span id="maxRainRate"></span> mm/hr</div>
</div>

<canvas id="chart"></canvas>

<script>
let chart;

function initChart(){
    chart = new Chart(document.getElementById("chart"), {
        type: "line",
        data: { labels: [], datasets: [{ label: "Temp (°C)", data: [] }] },
        options: { animation:false }
    });
}

function format(v){
    return (v===undefined || isNaN(v)) ? '--' : Number(v).toFixed(1);
}

async function load(){
    const res = await fetch('/weather?ts='+Date.now());
    const data = await res.json();

    const d = data.obs;

    document.getElementById("temp").innerText = format(d.metric.temp) + "°C";

    document.getElementById("range").innerText =
        "Max: " + format(data.maxTemp) + "°C | Min: " + format(data.minTemp) + "°C";

    document.getElementById("hum").innerText = Math.round(d.humidity);

    document.getElementById("wind").innerText = format(d.metric.windSpeed);
    document.getElementById("gust").innerText = format(d.metric.windGust);

    document.getElementById("maxWind").innerText = format(data.maxWind) + " km/h";
    document.getElementById("maxGust").innerText = format(data.maxGust) + " km/h";

    document.getElementById("rain").innerText = format(d.metric.precipTotal);
    document.getElementById("rainRate").innerText = format(data.rainRate);
    document.getElementById("maxRainRate").innerText = format(data.maxRainRate);

    chart.data.labels = data.history.map(h=>h.time);
    chart.data.datasets[0].data = data.history.map(h=>h.temp);
    chart.update();
}

initChart();
load();
setInterval(load, 60000);
</script>

</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Running on port " + PORT));
