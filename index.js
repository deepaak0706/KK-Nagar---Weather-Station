const express = require("express");
const fetch = require("node-fetch");
const app = express();

const APPLICATION_KEY = process.env.APPLICATION_KEY;
const API_KEY = process.env.API_KEY;
const MAC = process.env.MAC;

let cachedData = null;
let lastFetch = 0;
let todayHistory = [];
let tempHistory = [];
let todayMaxRainRate = 0;
let todayMaxTemp = null;
let todayMinTemp = null;
let todayMaxWind = 0;
let todayMaxGust = 0;
let currentDate = new Date().toDateString();

app.get("/weather", async (req, res) => {
    const now = Date.now();
    const todayStr = new Date().toDateString();

    if (todayStr !== currentDate) {
        todayHistory = [];
        tempHistory = [];
        todayMaxRainRate = 0;
        todayMaxTemp = null;
        todayMinTemp = null;
        todayMaxWind = 0;
        todayMaxGust = 0;
        currentDate = todayStr;
    }

    if (cachedData && now - lastFetch < 30000) return res.json(cachedData);

    try {
        const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Ecowitt API error: ${response.status}`);
        const ecowitt = await response.json();
        if (ecowitt.code !== 0) throw new Error(ecowitt.msg || "API error");

        const d = ecowitt.data;

        // --- Convert units ---
        const tempC = parseFloat(((parseFloat(d.outdoor.temperature.value) - 32) * 5 / 9).toFixed(1));
        const feelsLikeC = parseFloat(((parseFloat(d.outdoor.feels_like.value) - 32) * 5 / 9).toFixed(1));
        const dewPointC = parseFloat(((parseFloat(d.outdoor.dew_point.value) - 32) * 5 / 9).toFixed(1));
        const humidity = parseFloat(d.outdoor.humidity.value);
        const rainRateMmHr = parseFloat((parseFloat(d.rainfall.rain_rate.value) * 25.4).toFixed(1));
        const totalRainMm = parseFloat((parseFloat(d.rainfall.daily.value) * 25.4).toFixed(1));
        const windSpeedKmh = parseFloat((parseFloat(d.wind.wind_speed.value) * 1.60934).toFixed(1));
        const windGustKmh = parseFloat((parseFloat(d.wind.wind_gust.value) * 1.60934).toFixed(1));
        const windDir = parseFloat(d.wind.wind_direction.value);
        const pressurehPa = parseFloat((parseFloat(d.pressure.relative.value) * 33.8639).toFixed(1));
        const solar = parseFloat(d.solar_and_uvi.solar.value);
        const uvi = d.solar_and_uvi.uvi.value;

        // --- Track max/min ---
        if (todayMaxTemp === null || tempC > todayMaxTemp) todayMaxTemp = tempC;
        if (todayMinTemp === null || tempC < todayMinTemp) todayMinTemp = tempC;
        if (windSpeedKmh > todayMaxWind) todayMaxWind = windSpeedKmh;
        if (windGustKmh > todayMaxGust) todayMaxGust = windGustKmh;
        if (rainRateMmHr > todayMaxRainRate) todayMaxRainRate = rainRateMmHr;

        // --- TEMPERATURE RATE: 1-hour difference ---
        const nowTime = Date.now();
        tempHistory.push({ temp: tempC, time: nowTime });
        while (tempHistory.length > 0 && nowTime - tempHistory[0].time > 2 * 3600 * 1000) tempHistory.shift();
        let tempChangeRate = 0;
        const oneHourAgo = tempHistory.find(h => nowTime - h.time >= 3600 * 1000);
        if (oneHourAgo) {
            const hoursDiff = (nowTime - oneHourAgo.time) / (1000 * 3600);
            tempChangeRate = parseFloat(((tempC - oneHourAgo.temp) / hoursDiff).toFixed(1));
        }

        // --- Track history for charts ---
        todayHistory.push({
            time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }),
            temp: tempC,
            hum: humidity,
            rainRate: rainRateMmHr,
            totalRain: totalRainMm,
            windSpeed: windSpeedKmh,
            windDir
        });
        if (todayHistory.length > 1440) todayHistory.shift();

        cachedData = {
            outdoor: {
                temp: tempC,
                feelsLike: feelsLikeC,
                dewPoint: dewPointC,
                humidity,
                tempChangeRate,
                maxTemp: todayMaxTemp,
                minTemp: todayMinTemp,
                solar,
                uvi
            },
            rainfall: {
                rainRate: rainRateMmHr,
                totalRain: totalRainMm,
                maxRainRate: todayMaxRainRate
            },
            wind: {
                speed: windSpeedKmh,
                gust: windGustKmh,
                maxSpeed: todayMaxWind,
                maxGust: todayMaxGust,
                direction: windDir
            },
            pressure: pressurehPa,
            history: todayHistory
        };

        lastFetch = now;
        res.json(cachedData);

    } catch (error) {
        console.error("Ecowitt API Error:", error.message);
        if (cachedData) return res.json(cachedData);
        res.status(500).json({ error: "Failed to fetch data from Ecowitt" });
    }
});

app.get("/", (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>KK Nagar Weather Station</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<style>
body { margin:0; font-family:'Segoe UI',Arial,sans-serif; background:linear-gradient(135deg,#0f172a,#1e293b); color:#e2e8f0; min-height:100vh; }
h1 { text-align:center; padding:22px 15px 15px; font-size:27px; margin:0; background:rgba(15,23,42,0.85); }
.status { text-align:center; font-size:14px; padding:8px; opacity:0.9; }
.container { max-width:1100px; margin:0 auto; padding:12px; }
.card { background:rgba(255,255,255,0.07); backdrop-filter:blur(16px); border-radius:18px; padding:20px; margin-bottom:16px; box-shadow:0 8px 25px rgba(0,0,0,0.35); }
.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:14px; }
.item { text-align:center; }
.label { font-size:13px; opacity:0.75; margin-bottom:5px; }
.value { font-size:26px; font-weight:700; }
.subvalue { font-size:13px; opacity:0.8; margin-top:3px; }
.rise { color:#4ade80; }
.fall { color:#f87171; }
canvas { background:rgba(15,23,42,0.95); border-radius:16px; padding:16px; margin-top:12px; }
</style>
</head>
<body>
<h1>KK Nagar Weather Station</h1>
<div id="status" class="status">Loading live data from Ecowitt...</div>
<div class="container">
<div class="card">
<div class="grid">
  <div class="item">
    <div class="label">TEMPERATURE</div>
    <div class="value" id="temp"></div>
    <div class="subvalue" id="tempRate"></div>
    <div class="subvalue" id="maxminTemp"></div>
  </div>
  <div class="item">
    <div class="label">DEW POINT</div>
    <div class="value" id="dewpoint"></div>
  </div>
  <div class="item">
    <div class="label">HUMIDITY</div>
    <div class="value" id="hum"></div>
  </div>
  <div class="item">
    <div class="label">FEELS LIKE</div>
    <div class="value" id="feels"></div>
  </div>
  <div class="item">
    <div class="label">RAIN RATE</div>
    <div class="value" id="rainRate"></div>
  </div>
  <div class="item">
    <div class="label">TOTAL RAIN (Today)</div>
    <div class="value" id="totalRain"></div>
  </div>
  <div class="item">
    <div class="label">WIND</div>
    <div class="value" id="wind"></div>
    <div class="subvalue" id="windMax"></div>
  </div>
  <div class="item">
    <div class="label">WIND DIRECTION</div>
    <div class="value" id="windDir"></div>
  </div>
</div>
</div>
<div class="card">
<canvas id="tempChart"></canvas>
<canvas id="humChart"></canvas>
</div>
</div>
<script>
async function fetchWeather() {
    try {
        const res = await fetch('/weather');
        const d = await res.json();
        document.getElementById('status').innerText = "Updated at " + new Date().toLocaleTimeString();
        document.getElementById('temp').innerText = d.outdoor.temp + "°C";
        const rate = d.outdoor.tempChangeRate;
        document.getElementById('tempRate').innerText = (rate>0?'↑':'↓') + " " + Math.abs(rate) + " °C/hr";
        document.getElementById('maxminTemp').innerText = "Max: " + d.outdoor.maxTemp + " | Min: " + d.outdoor.minTemp;
        document.getElementById('dewpoint').innerText = d.outdoor.dewPoint + "°C";
        document.getElementById('hum').innerText = d.outdoor.humidity + "%";
        document.getElementById('feels').innerText = d.outdoor.feelsLike + "°C";
        document.getElementById('rainRate').innerText = d.rainfall.rainRate + " mm/hr (Max: "+d.rainfall.maxRainRate+")";
        document.getElementById('totalRain').innerText = d.rainfall.totalRain + " mm";
        document.getElementById('wind').innerText = d.wind.speed + " km/h, Gust: " + d.wind.gust + " km/h";
        document.getElementById('windMax').innerText = "Max Speed: " + d.wind.maxSpeed + " km/h | Max Gust: " + d.wind.maxGust + " km/h";
        document.getElementById('windDir').innerText = d.wind.direction + "°";

        // --- Charts ---
        const labels = d.history.map(h=>h.time);
        const temps = d.history.map(h=>h.temp);
        const hums = d.history.map(h=>h.hum);

        if(window.tempChartObj) {
            window.tempChartObj.data.labels = labels;
            window.tempChartObj.data.datasets[0].data = temps;
            window.tempChartObj.update();
        } else {
            const ctx = document.getElementById('tempChart').getContext('2d');
            window.tempChartObj = new Chart(ctx, {
                type:'line',
                data:{ labels:labels, datasets:[{ label:'Temperature °C', data:temps, borderColor:'#fb923c', backgroundColor:'rgba(251,146,60,0.2)', fill:true }] },
                options:{ responsive:true, animation:false, scales:{ y:{ beginAtZero:false, ticks:{ precision:1 } } } }
            });
        }
        if(window.humChartObj) {
            window.humChartObj.data.labels = labels;
            window.humChartObj.data.datasets[0].data = hums;
            window.humChartObj.update();
        } else {
            const ctx2 = document.getElementById('humChart').getContext('2d');
            window.humChartObj = new Chart(ctx2, {
                type:'line',
                data:{ labels:labels, datasets:[{ label:'Humidity %', data:hums, borderColor:'#3b82f6', backgroundColor:'rgba(59,130,246,0.2)', fill:true }] },
                options:{ responsive:true, animation:false, scales:{ y:{ beginAtZero:false, ticks:{ precision:1 } } } }
            });
        }

    } catch(e){ console.error(e); }
}

fetchWeather();
setInterval(fetchWeather,30000);
</script>
</body>
</html>
    `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT,()=>console.log("✅ KK Nagar Weather Station running on port " + PORT));
