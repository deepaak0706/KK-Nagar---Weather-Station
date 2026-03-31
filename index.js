const express = require("express");
const fetch = require("node-fetch");
const app = express();

const APPLICATION_KEY = process.env.APPLICATION_KEY;
const API_KEY = process.env.API_KEY;
const MAC = process.env.MAC;

let cachedData = null;
let lastFetch = 0;

let todayHistory = [];
let todayMaxRainRate = 0;
let todayMaxWindSpeed = 0;
let todayMaxWindGust = 0;
let currentDate = new Date().toDateString();

let tempHistory = []; // {time: timestamp, temp: value}

app.get("/weather", async (req, res) => {
    const now = Date.now();
    const todayStr = new Date().toDateString();

    if (todayStr !== currentDate) {
        todayHistory = [];
        todayMaxRainRate = 0;
        todayMaxWindSpeed = 0;
        todayMaxWindGust = 0;
        tempHistory = [];
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

        // Convert to metric
        const tempC = ((parseFloat(d.outdoor.temperature.value) - 32) * 5 / 9).toFixed(1);
        const feelsLikeC = ((parseFloat(d.outdoor.feels_like.value) - 32) * 5 / 9).toFixed(1);
        const dewPointC = ((parseFloat(d.outdoor.dew_point.value) - 32) * 5 / 9).toFixed(1);
        const rainRateMmHr = (parseFloat(d.rainfall.rain_rate.value) * 25.4).toFixed(1);
        const totalRainMm = (parseFloat(d.rainfall.daily.value) * 25.4).toFixed(1);
        const windSpeedKmh = (parseFloat(d.wind.wind_speed.value) * 1.60934).toFixed(1);
        const windGustKmh = (parseFloat(d.wind.wind_gust.value) * 1.60934).toFixed(1);
        const pressureHpa = (parseFloat(d.pressure.relative.value) * 33.8639).toFixed(1);
        const solarWm2 = parseFloat(d.solar_and_uvi.solar.value).toFixed(1);
        const uvi = d.solar_and_uvi.uvi.value;

        // Store temp history
        tempHistory.push({ time: now, temp: parseFloat(tempC) });

        // Remove older than 24h
        tempHistory = tempHistory.filter(t => now - t.time <= 24 * 3600 * 1000);

        // Calculate temp change rate per hour based on temp 1 hour ago
        let tempChangeRate = 0;
        const oneHourAgo = now - 3600 * 1000;
        const past = tempHistory.find(t => t.time <= oneHourAgo) || tempHistory[0];
        if (past && past.time !== now) {
            const hoursDiff = (now - past.time) / (1000 * 3600);
            tempChangeRate = ((parseFloat(tempC) - past.temp) / hoursDiff).toFixed(1);
        }

        // Max values for the day
        const currentRainRate = parseFloat(rainRateMmHr);
        if (currentRainRate > todayMaxRainRate) todayMaxRainRate = currentRainRate;
        if (parseFloat(windSpeedKmh) > todayMaxWindSpeed) todayMaxWindSpeed = parseFloat(windSpeedKmh);
        if (parseFloat(windGustKmh) > todayMaxWindGust) todayMaxWindGust = parseFloat(windGustKmh);

        // Update today's history
        const istTimeStr = new Date().toLocaleTimeString('en-IN', { hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
        todayHistory.push({
            time: istTimeStr,
            temp: parseFloat(tempC),
            hum: parseFloat(d.outdoor.humidity.value),
            dewPoint: parseFloat(dewPointC),
            rainRate: currentRainRate,
            totalRain: parseFloat(totalRainMm),
            windSpeed: parseFloat(windSpeedKmh),
            windGust: parseFloat(windGustKmh),
            windDir: parseFloat(d.wind.wind_direction.value)
        });
        if (todayHistory.length > 1440) todayHistory.shift();

        cachedData = {
            outdoor: {
                temp: tempC,
                feelsLike: feelsLikeC,
                dewPoint: dewPointC,
                humidity: d.outdoor.humidity.value,
                tempChangeRate,
                tempMax: Math.max(...todayHistory.map(h => h.temp)).toFixed(1),
                tempMin: Math.min(...todayHistory.map(h => h.temp)).toFixed(1)
            },
            rainfall: {
                rainRate: rainRateMmHr,
                maxRainRate: todayMaxRainRate.toFixed(1),
                totalRain: totalRainMm
            },
            wind: {
                speed: windSpeedKmh,
                gust: windGustKmh,
                maxSpeed: todayMaxWindSpeed.toFixed(1),
                maxGust: todayMaxWindGust.toFixed(1),
                direction: d.wind.wind_direction.value
            },
            pressure: pressureHpa,
            solar: solarWm2,
            uvi: uvi,
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
.subvalue { font-size:14px; opacity:0.85; }
.wind-container { text-align:center; padding:22px 20px; }
canvas { background:rgba(15,23,42,0.95); border-radius:16px; padding:16px; margin-top:12px; }
.cool { color:#67e8f9; }
.mild { color:#fcd34d; }
.hot { color:#fb923c; }
.veryhot { color:#f87171; }
.rise { color:#4ade80; }
.fall { color:#f87171; }
.maxVal { color:#f87171; font-weight:700; }
.minVal { color:#3b82f6; font-weight:700; }
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
<div class="subvalue" id="tempRate"></div>
<div class="subvalue" id="tempMaxMin"></div>
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

<div class="card wind-container">
<div class="label">WIND</div>
<div class="value" id="wind"></div>
<div class="subvalue" id="windMax"></div>
<div class="subvalue" id="windDir"></div>
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
<canvas id="rainChart" height="140"></canvas>
</div>

</div>

<script>
let charts = {};

function format(v){return isNaN(parseFloat(v))?'--':parseFloat(v).toFixed(1);}
function getTempClass(t){if(t<=25)return "cool";if(t<35)return "mild";if(t<40)return "hot";return "veryhot";}
function getWindDir(deg){const dirs=["N","NE","E","SE","S","SW","W","NW"];return dirs[Math.round(deg/45)%8];}

function createCharts(){
const optTemp={animation:false,scales:{y:{ticks:{precision:1}}}};
charts.temp=new Chart(document.getElementById('tempChart'),{type:'line',data:{labels:[],datasets:[{label:'Temperature (°C)',data:[],borderColor:'#67e8f9',tension:0.3}]},options:optTemp});
charts.hum=new Chart(document.getElementById('humChart'),{type:'line',data:{labels:[],datasets:[{label:'Humidity (%)',data:[],borderColor:'#4ade80',tension:0.3}]},options:optTemp});
charts.wind=new Chart(document.getElementById('windChart'),{type:'line',data:{labels:[],datasets:[{label:'Wind Speed (km/h)',data:[],borderColor:'#fb923c',tension:0.3}]},options:optTemp});
charts.rain=new Chart(document.getElementById('rainChart'),{type:'line',data:{labels:[],datasets:[{label:'Rain Rate (mm/hr)',data:[],borderColor:'#facc15',tension:0.3}]},options:optTemp});
}

async function loadData(){
try{
const res=await fetch('/weather');const data=await res.json();
if(data.error){document.getElementById('status').innerHTML='⚠️ '+data.error;return;}

const o=data.outdoor,r=data.rainfall,w=data.wind;

const tempClass=getTempClass(parseFloat(o.temp));
document.getElementById('temp').innerHTML='<span class="'+tempClass+'">'+o.temp+'°C</span>';

let rateHTML='';if(o.tempChangeRate!==undefined){const rate=parseFloat(o.tempChangeRate);const sign=rate>=0?'↑':'↓';const color=rate>=0?'#4ade80':'#f87171';rateHTML='<span style="color:'+color+'; font-size:13px;">'+sign+' '+Math.abs(rate)+' °C/hr</span>';}
document.getElementById('tempRate').innerHTML=rateHTML;
document.getElementById('tempMaxMin').innerHTML='<span class="maxVal">Max: '+o.tempMax+'°C</span> | <span class="minVal">Min: '+o.tempMin+'°C</span>';

document.getElementById('dewpoint').innerText=o.dewPoint+'°C';
document.getElementById('hum').innerText=o.humidity+'%';
document.getElementById('feels').innerText=o.feelsLike+'°C';

document.getElementById('rain').innerText=r.rainRate+' mm/hr (Max: '+r.maxRainRate+')';
document.getElementById('totalRain').innerText=r.totalRain+' mm';

document.getElementById('wind').innerText=w.speed+' km/h, Gust: '+w.gust+' km/h';
document.getElementById('windMax').innerText='Max Speed: '+w.maxSpeed+' km/h | Max Gust: '+w.maxGust+' km/h';
document.getElementById('windDir').innerText=w.direction+'° ('+getWindDir(w.direction)+')';

document.getElementById('pressure').innerText=data.pressure+' hPa';
document.getElementById('uv').innerText=data.uvi || '--';
document.getElementById('solar').innerText=data.solar+' W/m²';

document.getElementById('status').innerHTML='✅ Live from Ecowitt • Updated '+new Date().toLocaleTimeString('en-IN', {timeZone:'Asia/Kolkata'});

const labels=data.history.map(h=>h.time);
charts.temp.data.labels=labels; charts.temp.data.datasets[0].data=data.history.map(h=>h.temp);
charts.hum.data.labels=labels; charts.hum.data.datasets[0].data=data.history.map(h=>h.hum);
charts.wind.data.labels=labels; charts.wind.data.datasets[0].data=data.history.map(h=>h.windSpeed);
charts.rain.data.labels=labels; charts.rain.data.datasets[0].data=data.history.map(h=>h.rainRate);

charts.temp.update(); charts.hum.update(); charts.wind.update(); charts.rain.update();

}catch(e){document.getElementById('status').innerHTML="⚠️ Using last known data";}
}

createCharts();loadData();setInterval(loadData,30000);
</script>
</body>
</html>
`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ KK Nagar Weather Station running on port ${PORT}, refresh 30 sec`));
