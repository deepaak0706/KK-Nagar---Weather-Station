const express = require("express");
const app = express();

const API_KEY = process.env.API_KEY;
const STATION_ID = "ICHENN63";

let cachedData = null;
let lastFetch = 0;
let history = [];
let todayMaxRainRate = 0;
let currentDate = new Date().toDateString();

app.get("/weather", async (req, res) => {
    const now = Date.now();
    const todayStr = new Date().toDateString();

    // Reset daily max rain rate at midnight
    if (todayStr !== currentDate) {
        todayMaxRainRate = 0;
        currentDate = todayStr;
        history = [];
    }

    if (cachedData && now - lastFetch < 60000) return res.json(cachedData);

    try {
        const weatherRes = await fetch(
            `https://api.weather.com/v2/pws/observations/current?stationId=${STATION_ID}&format=json&units=m&apiKey=${API_KEY}`
        );

        if (!weatherRes.ok) throw new Error(`API error: ${weatherRes.status}`);

        const weatherData = await weatherRes.json();
        const obs = weatherData.observations?.[0];
        if (!obs) throw new Error("No observations");

        const sunRes = await fetch(
            `https://api.sunrise-sunset.org/json?lat=${obs.lat}&lng=${obs.lon}&formatted=0`
        );
        const sunData = await sunRes.json().catch(() => ({ results: { sunrise: null, sunset: null } }));

        const metric = obs.metric || {};
        const rainTotal = metric.precipTotal ?? 0;
        const windSpeed = metric.windSpeed ?? 0;

        // Calculate rain rate using ISO timestamp
        let rainRate = 0;
        if (history.length > 0) {
            const lastEntry = history[history.length - 1];
            const timeDiff = (Date.now() - new Date(lastEntry.timestamp).getTime()) / 1000;
            if (timeDiff > 0) rainRate = ((rainTotal - lastEntry.rain) * 3600) / timeDiff;
        }

        if (rainRate > todayMaxRainRate) todayMaxRainRate = rainRate;

        history.push({
            timestamp: new Date().toISOString(), // for calculations
            label: new Date().toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', hour12:false }), // X-axis
            temp: metric.temp ?? 0,
            hum: obs.humidity ?? 0,
            dewpt: metric.dewpt ?? 0,
            rain: rainTotal,
            windSpeed: windSpeed,
            windDir: obs.winddir ?? 0
        });

        if (history.length > 1440) history.shift(); // keep 1 day

        cachedData = {
            obs,
            sunrise: sunData.results.sunrise,
            sunset: sunData.results.sunset,
            history,
            maxRainRate: todayMaxRainRate
        };

        lastFetch = now;
        res.json(cachedData);

    } catch (err) {
        console.error("API Error:", err.message);
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
.wind-container { text-align:center; padding:22px 20px; }
.wind-arrow { font-size:52px; margin:15px 0; transition:transform 0.6s cubic-bezier(0.4,0,0.2,1); }
canvas { background:rgba(15,23,42,0.95); border-radius:16px; padding:16px; margin-top:12px; }
.cool { color:#67e8f9; }
.mild { color:#fcd34d; }
.hot { color:#fb923c; }
.veryhot { color:#f87171; }
</style>
</head>
<body>
<h1>KK Nagar Weather Station</h1>
<div id="status" class="status">Loading live data...</div>
<div class="container">

<div class="card">
<div class="grid">
<div class="item"><div class="label">TEMPERATURE</div><div class="value" id="temp"></div></div>
<div class="item"><div class="label">FEELS LIKE</div><div class="value" id="feels"></div></div>
<div class="item"><div class="label">HUMIDITY</div><div class="value" id="hum"></div></div>
<div class="item"><div class="label">DEW POINT</div><div class="value" id="dewpoint"></div></div>
</div>
</div>

<div class="card">
<div class="label" style="text-align:center; margin-bottom:12px; font-size:14.5px; opacity:0.9;">RAIN</div>
<div class="grid">
<div class="item"><div class="label">RAIN RATE</div><div class="value" id="rain"></div></div>
<div class="item"><div class="label">TOTAL RAIN</div><div class="value" id="totalRain"></div></div>
</div>
</div>

<div class="card wind-container">
<div class="label">WIND SPEED</div>
<div class="value" id="wind"></div>
<div class="wind-arrow" id="arrow">⬆️</div>
<div class="label" id="winddir" style="font-size:15px; margin-top:8px;"></div>
</div>

<div class="card">
<div class="grid">
<div class="item"><div class="label">PRESSURE</div><div class="value" id="pressure"></div></div>
<div class="item"><div class="label">UV INDEX</div><div class="value" id="uv"></div></div>
<div class="item"><div class="label">SOLAR RADIATION</div><div class="value" id="solar"></div></div>
<div class="item"><div class="label">SUNRISE</div><div class="value" id="sunrise"></div></div>
<div class="item"><div class="label">SUNSET</div><div class="value" id="sunset"></div></div>
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
let lastRain = null;
let lastTime = null;
let charts = {};

function format(v) { return isNaN(parseFloat(v)) ? '--' : Math.round(v); }
function getWindDirection(deg) { const dirs=["N","NE","E","SE","S","SW","W","NW"]; return dirs[Math.round(deg/45)%8]; }
function getTempClass(temp){ if(temp<=25)return"cool"; if(temp<35)return"mild"; if(temp<40)return"hot"; return"veryhot"; }

function createCharts(){
const opt={animation:false,scales:{y:{beginAtZero:true,ticks:{stepSize:5}}}};
charts.temp=new Chart(document.getElementById('tempChart'),{type:'line',data:{labels:[],datasets:[{label:'Temperature (°C)',data:[],borderColor:'#67e8f9',tension:0.3}]},options:opt});
charts.hum=new Chart(document.getElementById('humChart'),{type:'line',data:{labels:[],datasets:[{label:'Humidity (%)',data:[],borderColor:'#4ade80',tension:0.3}]},options:opt});
charts.wind=new Chart(document.getElementById('windChart'),{type:'line',data:{labels:[],datasets:[{label:'Wind Speed (km/h)',data:[],borderColor:'#fb923c',tension:0.3}]},options:opt});
}

async function loadData(){
try{
const res=await fetch('/weather');
const data=await res.json();
if(data.error){document.getElementById('status').innerHTML='⚠️ '+data.error; return;}

const d=data.obs||{};
const metric=d.metric||{};
const currentRain=metric.precipTotal??0;
const nowTime=Date.now();
let rainRate=0;
if(lastRain!==null){const diff=currentRain-lastRain; const t=(nowTime-lastTime)/1000; if(t>0 && diff>=0) rainRate=(diff*3600/t);}
lastRain=currentRain; lastTime=nowTime;

const tempClass=getTempClass(metric.temp??0);
document.getElementById('temp').innerHTML=`<span class="${tempClass}">${format(metric.temp??0)}°C</span>`;
document.getElementById('feels').innerHTML=`<span class="${tempClass}">${format(metric.heatIndex??metric.temp??0)}°C</span>`;
document.getElementById('hum').innerText=format(d.humidity??0)+'%';
document.getElementById('dewpoint').innerText=format(metric.dewpt??0)+'°C';

document.getElementById('wind').innerText=format(metric.windSpeed??0)+' km/h';
document.getElementById('arrow').style.transform='rotate('+(d.winddir??0)+'deg)';
document.getElementById('winddir').innerText=(d.winddir??0)+'° ('+getWindDirection(d.winddir??0)+')';

const maxRR=data.maxRainRate? ' (Max: '+format(data.maxRainRate)+')':'';
document.getElementById('rain').innerText=format(rainRate)+' mm/hr'+maxRR;
document.getElementById('totalRain').innerText=format(currentRain)+' mm';

document.getElementById('pressure').innerText=format(metric.pressure??0)+' hPa';
document.getElementById('uv').innerText=format(d.uv??0);
document.getElementById('solar').innerText=format(d.solarRadiation??0);

if(data.sunrise) document.getElementById('sunrise').innerText=new Date(data.sunrise).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:false});
if(data.sunset) document.getElementById('sunset').innerText=new Date(data.sunset).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:false});

document.getElementById('status').innerHTML='✅ Live • Updated '+new Date().toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:false});

const labels=data.history.map(h=>h.label);
charts.temp.data.labels=labels; charts.temp.data.datasets[0].data=data.history.map(h=>h.temp);
charts.hum.data.labels=labels; charts.hum.data.datasets[0].data=data.history.map(h=>h.hum);
charts.wind.data.labels=labels; charts.wind.data.datasets[0].data=data.history.map(h=>h.windSpeed);

charts.temp.update(); charts.hum.update(); charts.wind.update();

}catch(e){console.error(e); document.getElementById('status').innerHTML="⚠️ Using last known data";}
}

createCharts();
setInterval(loadData,60000);
loadData();

</script>
</body>
</html>`);
});

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>{console.log("✅ KK Nagar Weather Station running on port "+PORT); console.log("Station ID: "+STATION_ID); console.log("Refresh interval: 60 seconds");});
