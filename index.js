const express = require("express");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
const app = express();

const APPLICATION_KEY = process.env.APPLICATION_KEY;
const API_KEY = process.env.API_KEY;
const MAC = process.env.MAC;
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "weather_db.json");

let state = {
    cachedData: null,
    todayHistory: [],
    todayMaxRainRate: 0,
    todayMaxWindSpeed: 0,
    todayMaxWindGust: 0,
    currentDate: new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }),
    maxTemp: -999,
    minTemp: 999
};

// Load persisted data
if (fs.existsSync(DB_FILE)) {
    try {
        const saved = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        if (saved.currentDate === state.currentDate) state = { ...state, ...saved };
    } catch (e) {}
}

async function syncWithEcowitt() {
    const todayStr = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });

    if (todayStr !== state.currentDate) {
        state = { ...state, todayHistory: [], todayMaxRainRate: 0, todayMaxWindSpeed: 0, todayMaxWindGust: 0, maxTemp: -999, minTemp: 999, currentDate: todayStr };
    }

    try {
        const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}`;
        const response = await fetch(url);
        const ecowitt = await response.json();
        if (ecowitt.code !== 0) throw new Error(ecowitt.msg);

        const d = ecowitt.data;

        const tempC = parseFloat(((d.outdoor.temperature.value - 32) * 5 / 9).toFixed(1));
        const rainRate = parseFloat((d.rainfall.rain_rate.value * 25.4).toFixed(1));
        const totalRain = parseFloat((d.rainfall.daily.value * 25.4).toFixed(1));
        const windKmh = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));
        const gustKmh = parseFloat((d.wind.wind_gust.value * 1.60934).toFixed(1));

        if (tempC > state.maxTemp || state.maxTemp === -999) state.maxTemp = tempC;
        if (tempC < state.minTemp || state.minTemp === 999) state.minTemp = tempC;
        if (rainRate > state.todayMaxRainRate) state.todayMaxRainRate = rainRate;
        if (windKmh > state.todayMaxWindSpeed) state.todayMaxWindSpeed = windKmh;
        if (gustKmh > state.todayMaxWindGust) state.todayMaxWindGust = gustKmh;

        let trend = 0;
        if (state.todayHistory.length > 10) {
            trend = parseFloat((tempC - state.todayHistory[state.todayHistory.length - 10].temp).toFixed(1));
        }

        state.todayHistory.push({
            time: new Date().toISOString(),
            temp: tempC,
            hum: d.outdoor.humidity.value,
            wind: windKmh,
            rain: rainRate
        });

        if (state.todayHistory.length > 1440) state.todayHistory.shift();

        state.cachedData = {
            temp: { current: tempC, max: state.maxTemp, min: state.minTemp, trend, feels: ((d.outdoor.feels_like.value - 32) * 5 / 9).toFixed(1) },
            wind: { speed: windKmh, gust: gustKmh, maxSpeed: state.todayMaxWindSpeed, maxGust: state.todayMaxWindGust, deg: d.wind.wind_direction.value },
            atmo: { hum: d.outdoor.humidity.value, dew: ((d.outdoor.dew_point.value - 32) * 5 / 9).toFixed(1), press: (d.pressure.relative.value * 33.8639).toFixed(1), uv: d.solar_and_uvi.uvi.value, solar: d.solar_and_uvi.solar.value },
            rain: { total: totalRain, rate: rainRate, maxRate: state.todayMaxRainRate },
            history: state.todayHistory,
            lastSync: new Date().toISOString()
        };

        fs.writeFileSync(DB_FILE, JSON.stringify(state));
    } catch (e) {
        console.error("Sync Failed:", e.message);
    }
}

setInterval(syncWithEcowitt, 45000);
syncWithEcowitt();

app.get("/weather", (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(state.cachedData || { error: "Station Booting..." });
});

app.get("/", (req, res) => {
res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>KK Nagar Weather</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>

<style>
:root { --bg:#0b0f1a; --card:rgba(23,32,53,0.9); --accent:#38bdf8; }
body { margin:0; font-family:'Segoe UI'; background:var(--bg); color:#fff; padding:15px; }
.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:15px; }
.card { background:var(--card); padding:20px; border-radius:15px; }
.value { font-size:34px; font-weight:800; }
.chart-box { height:220px; }
</style>
</head>

<body>

<h2 style="text-align:center">KK Nagar Weather</h2>
<div id="status">Loading...</div>

<div class="grid">
<div class="card"><div id="temp" class="value">--</div></div>
<div class="card"><div id="wSpeed" class="value">--</div></div>
<div class="card"><div id="hum" class="value">--</div></div>
<div class="card"><div id="rTotal" class="value">--</div></div>
</div>

<div class="grid">
<div class="card chart-box"><canvas id="cTemp"></canvas></div>
<div class="card chart-box"><canvas id="cHum"></canvas></div>
<div class="card chart-box"><canvas id="cWind"></canvas></div>
<div class="card chart-box"><canvas id="cRain"></canvas></div>
</div>

<script>
let charts = {};
let isUpdating = false;

function makeChart(id, col){
return new Chart(document.getElementById(id), {
type:'line',
data:{labels:[],datasets:[{data:[],borderColor:col}]},
options:{animation:false,responsive:true}
});
}

async function updateUI(){
if(isUpdating) return;
isUpdating=true;

try{
const res=await fetch('/weather?cb='+Date.now());
const d=await res.json();
if(!d||d.error) return;

document.getElementById('temp').innerText=d.temp.current+'°C';
document.getElementById('wSpeed').innerText=d.wind.speed+' km/h';
document.getElementById('hum').innerText=d.atmo.hum+'%';
document.getElementById('rTotal').innerText=d.rain.total+' mm';

document.getElementById('status').innerText='Updated '+new Date(d.lastSync).toLocaleTimeString('en-IN');

const labels=d.history.map(x=>new Date(x.time).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}));

if(!charts.temp){
charts.temp=makeChart('cTemp','#38bdf8');
charts.hum=makeChart('cHum','#4ade80');
charts.wind=makeChart('cWind','#fb923c');
charts.rain=makeChart('cRain','#818cf8');
}

charts.temp.data={labels,datasets:[{data:d.history.map(x=>x.temp),borderColor:'#38bdf8'}]};
charts.hum.data={labels,datasets:[{data:d.history.map(x=>x.hum),borderColor:'#4ade80'}]};
charts.wind.data={labels,datasets:[{data:d.history.map(x=>x.wind),borderColor:'#fb923c'}]};
charts.rain.data={labels,datasets:[{data:d.history.map(x=>x.rain),borderColor:'#818cf8'}]};

Object.values(charts).forEach(c=>c.update());

}catch(e){console.error(e);}
finally{isUpdating=false;}
}

async function loop(){
while(true){
await updateUI();
await new Promise(r=>setTimeout(r,45000));
}
}

document.addEventListener("visibilitychange",()=>{
if(document.visibilityState==="visible") updateUI();
});

loop();
</script>

</body>
</html>`);
});

app.listen(PORT, () => console.log("🚀 Live on " + PORT));
