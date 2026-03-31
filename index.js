const express = require("express");
const app = express();

const APPLICATION_KEY = process.env.APPLICATION_KEY;
const API_KEY = process.env.API_KEY;
const MAC = process.env.MAC;

let cachedData = null;
let lastFetch = 0;
let todayHistory = [];
let todayMaxRainRate = 0;
let currentDate = new Date().toDateString();
let lastTemp = null;
let lastTempTime = null;

app.get("/weather", async (req, res) => {
    const now = Date.now();

    const todayStr = new Date().toDateString();
    if (todayStr !== currentDate) {
        todayHistory = [];
        todayMaxRainRate = 0;
        currentDate = todayStr;
    }

    if (cachedData && (now - lastFetch < 15000)) {
        return res.json(cachedData);
    }

    try {
        const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}`;
        const response = await fetch(url);
        
        if (!response.ok) throw new Error(`Ecowitt API error: ${response.status}`);

        const ecowitt = await response.json();

        if (ecowitt.code !== 0) throw new Error(ecowitt.msg || "API error");

        const d = ecowitt.data;

        const tempC = ((parseFloat(d.outdoor.temperature.value) - 32) * 5 / 9).toFixed(1);
        const feelsLikeC = ((parseFloat(d.outdoor.feels_like.value) - 32) * 5 / 9).toFixed(1);
        const dewPointC = ((parseFloat(d.outdoor.dew_point.value) - 32) * 5 / 9).toFixed(1);
        const rainRateMmHr = (parseFloat(d.rainfall.rain_rate.value) * 25.4).toFixed(1);
        const totalRainMm = (parseFloat(d.rainfall.daily.value) * 25.4).toFixed(1);
        const windSpeedKmh = (parseFloat(d.wind.wind_speed.value) * 1.60934).toFixed(1);
        const windGustKmh = (parseFloat(d.wind.wind_gust.value) * 1.60934).toFixed(1);

        const tempNum = parseFloat(tempC);
        const feelsLikeNum = parseFloat(feelsLikeC);
        const dewPointNum = parseFloat(dewPointC);

        let tempChangeRate = 0;
        if (lastTemp !== null) {
            const timeDiffHours = (Date.now() - lastTempTime) / (1000 * 3600);
            if (timeDiffHours >= 0.01) {
                tempChangeRate = (tempNum - lastTemp) / timeDiffHours;
            }
        }
        lastTemp = tempNum;
        lastTempTime = Date.now();

        const currentRainRate = parseFloat(rainRateMmHr);
        if (currentRainRate > todayMaxRainRate) todayMaxRainRate = currentRainRate;

        todayHistory.push({
            time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }),
            temp: tempNum,
            hum: parseFloat(d.outdoor.humidity.value),
            rainRate: currentRainRate,
            totalRain: parseFloat(totalRainMm),
            windSpeed: parseFloat(windSpeedKmh),
            windDir: parseFloat(d.wind.wind_direction.value)
        });

        if (todayHistory.length > 1440) todayHistory.shift();

        cachedData = {
            outdoor: {
                temp: tempNum,
                feelsLike: feelsLikeNum,
                humidity: d.outdoor.humidity.value,
                dewPoint: dewPointNum,
                solar: d.solar_and_uvi.solar.value,
                uvi: d.solar_and_uvi.uvi.value,
                tempChangeRate: tempChangeRate.toFixed(1)
            },
            rainfall: {
                rainRate: rainRateMmHr,
                totalRain: totalRainMm
            },
            wind: {
                speed: windSpeedKmh,
                gust: windGustKmh,
                direction: d.wind.wind_direction.value
            },
            pressure: (parseFloat(d.pressure.relative.value) * 33.8639).toFixed(1),
            history: todayHistory,
            maxRainRate: todayMaxRainRate.toFixed(1)
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
    res.send(`<!DOCTYPE html>
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
.wind-container { text-align:center; padding:22px 20px; }
.wind-arrow { font-size:28px; margin:0 auto; display:block; transition:transform 0.6s cubic-bezier(0.4,0,0.2,1); position:absolute; top:50%; left:50%; transform:translate(-50%, -50%); }
.wind-circle { width:60px; height:60px; margin:0 auto; border:2px solid rgba(255,255,255,0.3); border-radius:50%; position:relative; }
canvas { background:rgba(15,23,42,0.95); border-radius:16px; padding:16px; margin-top:12px; }
.cool { color:#67e8f9; }
.mild { color:#fcd34d; }
.hot { color:#fb923c; }
.veryhot { color:#f87171; }
.rise { color:#4ade80; }
.fall { color:#f87171; }

/* NEW: small subtle rain values */
.rain-value { font-size:16px; font-weight:500; color:#e2e8f0; opacity:0.85; }
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
            <div id="tempRate" style="font-size:13px; margin-top:4px;"></div>
        </div>
        <div class="item">
            <div class="label">FEELS LIKE</div>
            <div class="value" id="feels"></div>
        </div>
        <div class="item">
            <div class="label">HUMIDITY</div>
            <div class="value" id="hum"></div>
        </div>
    </div>
</div>

<div class="card">
    <div class="label" style="text-align:center; margin-bottom:12px; font-size:14.5px; opacity:0.9;">RAIN</div>
    <div class="grid">
        <div class="item">
            <div class="label">RAIN RATE</div>
            <div class="rain-value" id="rain"></div>
        </div>
        <div class="item">
            <div class="label">TOTAL RAIN (Today)</div>
            <div class="rain-value" id="totalRain"></div>
        </div>
    </div>
</div>

<div class="card wind-container">
    <div class="label">WIND SPEED</div>
    <div class="value" id="wind"></div>
    <div class="label" style="font-size:14px; margin-top:4px;">Gust: <span id="gust"></span> km/h</div>
    <div class="wind-circle">
        <div class="wind-arrow" id="arrow">⬆️</div>
    </div>
    <div class="label" id="winddir" style="font-size:15px; margin-top:4px;"></div>
</div>

<div class="card">
    <div class="grid">
        <div class="item"><div class="label">DEW POINT</div><div class="value" id="dewpoint"></div></div>
        <div class="item"><div class="label">PRESSURE</div><div class="value" id="pressure"></div></div>
        <div class="item"><div class="label">UV INDEX</div><div class="value" id="uv"></div></div>
    </div>
</div>

<div class="card">
    <div class="grid">
        <div class="item"><div class="label">SOLAR RADIATION</div><div class="value" id="solar"></div></div>
    </div>
</div>

<div class="card">
    <h3 style="margin:0 0 16px 0; text-align:center; opacity:0.9;">Recent Trends</h3>
    <canvas id="tempChart" height="140"></canvas>
    <canvas id="humChart" height="140"></canvas>
    <canvas id="windChart" height="140"></canvas>
</div>
</div>

<script>
let charts = {};

function getWindDirection(deg) {
    const dirs = ["N","NE","E","SE","S","SW","W","NW"];
    return dirs[Math.round(deg / 45) % 8];
}

function getTempClass(temp) {
    if (temp <= 25) return "cool";
    if (temp < 35) return "mild";
    if (temp < 40) return "hot";
    return "veryhot";
}

function createCharts() {
    const opt = { animation: false, scales: { y: { beginAtZero: true, ticks: { stepSize: 5 } } } };
    charts.temp = new Chart(document.getElementById('tempChart'), { type:'line', data:{labels:[], datasets:[{label:'Temperature (°C)', data:[], borderColor:'#67e8f9', tension:0.3}]}, options:opt });
    charts.hum = new Chart(document.getElementById('humChart'), { type:'line', data:{labels:[], datasets:[{label:'Humidity (%)', data:[], borderColor:'#4ade80', tension:0.3}]}, options:opt });
    charts.wind = new Chart(document.getElementById('windChart'), { type:'line', data:{labels:[], datasets:[{label:'Wind Speed (km/h)', data:[], borderColor:'#fb923c', tension:0.3}]}, options:opt });
}

async function loadData() {
    try {
        const res = await fetch('/weather');
        const data = await res.json();
        if (data.error) {
            document.getElementById('status').innerHTML = '⚠️ ' + data.error;
            return;
        }
        const o = data.outdoor || {};
        const r = data.rainfall || {};
        const w = data.wind || {};

        const tempClass = getTempClass(parseFloat(o.temp));
        document.getElementById('temp').innerHTML = '<span class="' + tempClass + '">' + o.temp + '°C</span>';
        let rateHTML = '';
        if (o.tempChangeRate !== undefined) {
            const rate = parseFloat(o.tempChangeRate);
            const sign = rate >= 0 ? '↑' : '↓';
            const color = rate >= 0 ? '#4ade80' : '#f87171';
            rateHTML = '<span style="color:' + color + '; font-size:13px;">' + sign + ' ' + Math.abs(rate) + ' °C/hr</span>';
        }
        document.getElementById('tempRate').innerHTML = rateHTML;
        document.getElementById('feels').innerHTML = '<span class="' + tempClass + '">' + o.feelsLike + '°C</span>';
        document.getElementById('hum').innerText = o.humidity + "%";

        document.getElementById('wind').innerText = w.speed + " km/h";
        document.getElementById('gust').innerText = w.gust + " km/h";
        document.getElementById('arrow').style.transform = 'translate(-50%,-50%) rotate(' + w.direction + 'deg)';
        document.getElementById('winddir').innerText = w.direction + '° (' + getWindDirection(w.direction) + ')';

        const maxRR = data.maxRainRate ? ' (Max: ' + data.maxRainRate + ')' : '';
        document.getElementById('rain').innerText = r.rainRate + " mm/hr" + maxRR;
        document.getElementById('totalRain').innerText = r.totalRain + " mm";

        document.getElementById('dewpoint').innerText = o.dewPoint + "°C";
        document.getElementById('pressure').innerText = data.pressure + " hPa";
        document.getElementById('uv').innerText = o.uvi || '--';
        document.getElementById('solar').innerText = o.solar + " W/m²";

        document.getElementById('status').innerHTML = '✅ Live from Ecowitt • Updated ' + new Date().toLocaleTimeString('en-IN', {timeZone: 'Asia/Kolkata'});

        const labels = data.history.map(h => h.time);
        charts.temp.data.labels = labels; charts.temp.data.datasets[0].data = data.history.map(h => h.temp);
        charts.hum.data.labels = labels; charts.hum.data.datasets[0].data = data.history.map(h => h.hum);
        charts.wind.data.labels = labels; charts.wind.data.datasets[0].data = data.history.map(h => h.windSpeed);

        charts.temp.update();
        charts.hum.update();
        charts.wind.update();

    } catch (e) {
        document.getElementById('status').innerHTML = "⚠️ Using last known data";
    }
}

createCharts();
setInterval(loadData, 15000);
loadData();
</script>
</body>
</html>
`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("✅ KK Nagar Weather Station (Ecowitt) running on port " + PORT);
    console.log("Refresh interval: 15 seconds");
});
