import express from "express";
import fetch from "node-fetch";

const app = express();

const APPLICATION_KEY = process.env.APPLICATION_KEY;
const API_KEY = process.env.API_KEY;
const MAC = process.env.MAC;

let cachedData = null;
let lastFetch = 0;

let todayHistory = [];
let todayMaxRainRate = 0;
let todayMaxTemp = null;
let todayMinTemp = null;
let todayMaxWind = 0;
let todayMaxGust = 0;

let lastTemp = null;
let lastTempTime = null;

let currentDate = new Date().toDateString();

app.get("/weather", async (req, res) => {
    const now = Date.now();
    const todayStr = new Date().toDateString();
    if (todayStr !== currentDate) {
        todayHistory = [];
        todayMaxRainRate = 0;
        todayMaxTemp = null;
        todayMinTemp = null;
        todayMaxWind = 0;
        todayMaxGust = 0;
        currentDate = todayStr;
    }

    if (cachedData && now - lastFetch < 15000) return res.json(cachedData);

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
        const pressureHpa = (parseFloat(d.pressure.relative.value) * 33.8639).toFixed(1);
        const solar = parseFloat(d.solar_and_uvi.solar.value);
        const uvi = parseFloat(d.solar_and_uvi.uvi.value);

        // Temp rate per hour (compare with exactly 1 hour ago if possible)
        let tempChangeRate = 0;
        if (lastTemp !== null) {
            const timeDiffHours = (now - lastTempTime) / (1000 * 3600);
            if (timeDiffHours > 0) tempChangeRate = ((tempC - lastTemp) / timeDiffHours).toFixed(1);
        }
        lastTemp = parseFloat(tempC);
        lastTempTime = now;

        // Max/min temps
        todayMaxTemp = todayMaxTemp === null ? tempC : Math.max(todayMaxTemp, tempC);
        todayMinTemp = todayMinTemp === null ? tempC : Math.min(todayMinTemp, tempC);

        // Max wind/gust
        todayMaxWind = Math.max(todayMaxWind, windSpeedKmh);
        todayMaxGust = Math.max(todayMaxGust, windGustKmh);

        // Max rain
        todayMaxRainRate = Math.max(todayMaxRainRate, rainRateMmHr);

        const timeStr = new Date().toLocaleTimeString("en-IN", { hour: '2-digit', minute: '2-digit', hour12: false });

        todayHistory.push({
            time: timeStr,
            temp: parseFloat(tempC),
            hum: parseFloat(d.outdoor.humidity.value),
            rainRate: parseFloat(rainRateMmHr),
            totalRain: parseFloat(totalRainMm),
            windSpeed: parseFloat(windSpeedKmh)
        });
        if (todayHistory.length > 1440) todayHistory.shift();

        cachedData = {
            outdoor: {
                temp: tempC,
                feelsLike: feelsLikeC,
                humidity: d.outdoor.humidity.value,
                dewPoint: dewPointC,
                tempChangeRate,
                maxTemp: todayMaxTemp,
                minTemp: todayMinTemp
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
                direction: d.wind.wind_direction.value
            },
            pressure: pressureHpa,
            solar: solar,
            uvi: uvi,
            history: todayHistory
        };

        lastFetch = now;
        res.json(cachedData);
    } catch (err) {
        console.error(err);
        if (cachedData) return res.json(cachedData);
        res.status(500).json({ error: "Failed to fetch data" });
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
.small { font-size:14px; opacity:0.8; }
.red { color:#f87171; } .blue { color:#60a5fa; } .green { color:#4ade80; }
canvas { background:rgba(15,23,42,0.95); border-radius:16px; padding:16px; margin-top:12px; }
</style>
</head>
<body>
<h1>KK Nagar Weather Station</h1>
<div id="status" class="status">Loading live data...</div>
<div class="container">

<div class="card">
    <div class="grid">
        <div class="item">
            <div class="label">TEMPERATURE</div>
            <div class="value" id="temp"></div>
            <div id="tempRate" class="small"></div>
            <div id="tempMaxMin" class="small"></div>
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
    </div>
</div>

<div class="card">
    <div class="grid">
        <div class="item">
            <div class="label">RAIN RATE</div>
            <div class="value" id="rain"></div>
        </div>
        <div class="item">
            <div class="label">TOTAL RAIN (Today)</div>
            <div class="value" id="totalRain"></div>
        </div>
    </div>
</div>

<div class="card">
    <div class="grid">
        <div class="item">
            <div class="label">WIND SPEED</div>
            <div class="value" id="wind"></div>
            <div class="small">Max: <span id="maxWind"></span></div>
        </div>
        <div class="item">
            <div class="label">WIND GUST</div>
            <div class="value" id="gust"></div>
            <div class="small">Max: <span id="maxGust"></span></div>
        </div>
    </div>
    <div style="text-align:center; margin-top:8px;">Direction: <span id="winddir"></span></div>
</div>

<div class="card">
    <div class="grid">
        <div class="item"><div class="label">PRESSURE</div><div class="value" id="pressure"></div></div>
        <div class="item"><div class="label">UV INDEX</div><div class="value" id="uv"></div></div>
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

function format(v){ return isNaN(v)?'--':v.toFixed(1); }

function getWindDirection(deg){
    const dirs = ["N","NE","E","SE","S","SW","W","NW"];
    return dirs[Math.round(deg/45)%8];
}

function getTempClass(temp){
    if(temp<=25) return "green";
    if(temp<35) return "blue";
    if(temp<40) return "orange";
    return "red";
}

function createCharts(){
    const opt = { animation:false, scales:{ y:{ beginAtZero:false,ticks:{ callback: v => v.toFixed(1) } }, x:{ ticks:{ callback: t=>t } } } };
    charts.temp = new Chart(document.getElementById('tempChart'),{ type:'line', data:{ labels:[], datasets:[{label:'Temperature (°C)', data:[], borderColor:'#67e8f9', tension:0.3}] }, options:opt });
    charts.hum = new Chart(document.getElementById('humChart'),{ type:'line', data:{ labels:[], datasets:[{label:'Humidity (%)', data:[], borderColor:'#4ade80', tension:0.3}] }, options:opt });
    charts.wind = new Chart(document.getElementById('windChart'),{ type:'line', data:{ labels:[], datasets:[{label:'Wind Speed (km/h)', data:[], borderColor:'#fb923c', tension:0.3}] }, options:opt });
}

async function loadData(){
    try{
        const res = await fetch('/weather');
        const data = await res.json();
        if(data.error){ document.getElementById('status').innerHTML='⚠️ '+data.error; return; }

        const o = data.outdoor;
        const r = data.rainfall;
        const w = data.wind;

        const tempClass = getTempClass(parseFloat(o.temp));

        document.getElementById('temp').innerHTML = '<span class="'+tempClass+'">'+o.temp+'°C</span>';
        const rate = parseFloat(o.tempChangeRate);
        const sign = rate>=0?'↑':'↓';
        const color = rate>=0?'#4ade80':'#f87171';
        document.getElementById('tempRate').innerHTML = '<span style="color:'+color+'; font-size:13px;">'+sign+' '+Math.abs(rate)+' °C/hr</span>';
        document.getElementById('tempMaxMin').innerHTML = 'Max: <span class="red">'+o.maxTemp+'</span> | Min: <span class="blue">'+o.minTemp+'</span>';

        document.getElementById('dewpoint').innerText = o.dewPoint+'°C';
        document.getElementById('hum').innerText = o.humidity+'%';
        document.getElementById('feels').innerText = o.feelsLike+'°C';

        document.getElementById('rain').innerText = r.rainRate+' mm/hr (Max: '+r.maxRainRate+')';
        document.getElementById('totalRain').innerText = r.totalRain+' mm';

        document.getElementById('wind').innerText = w.speed+' km/h';
        document.getElementById('gust').innerText = w.gust+' km/h';
        document.getElementById('maxWind').innerText = w.maxSpeed;
        document.getElementById('maxGust').innerText = w.maxGust;
        document.getElementById('winddir').innerText = w.direction+'° ('+getWindDirection(w.direction)+')';

        document.getElementById('pressure').innerText = data.pressure+' hPa';
        document.getElementById('uv').innerText = data.uvi||'--';
        document.getElementById('solar').innerText = data.solar+' W/m²';

        document.getElementById('status').innerHTML='✅ Live • Updated '+new Date().toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata'});

        const labels = data.history.map(h=>h.time);
        charts.temp.data.labels=labels;
        charts.temp.data.datasets[0].data=data.history.map(h=>h.temp);
        charts.hum.data.labels=labels;
        charts.hum.data.datasets[0].data=data.history.map(h=>h.hum);
        charts.wind.data.labels=labels;
        charts.wind.data.datasets[0].data=data.history.map(h=>h.windSpeed);

        charts.temp.update();
        charts.hum.update();
        charts.wind.update();
    } catch(e){ document.getElementById('status').innerHTML='⚠️ Using last known data'; }
}

createCharts();
setInterval(loadData,30000);
loadData();
</script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT,()=>console.log("✅ KK Nagar Weather Station running on port "+PORT));
