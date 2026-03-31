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
let todayMaxWind = 0;
let todayMaxGust = 0;
let todayMaxTemp = null;
let todayMinTemp = null;
let currentDate = new Date().toDateString();
let lastTemp = null;
let lastTempTime = null;

app.get("/weather", async (req, res) => {
    const now = Date.now();
    const todayStr = new Date().toDateString();

    if (todayStr !== currentDate) {
        todayHistory = [];
        todayMaxRainRate = 0;
        todayMaxWind = 0;
        todayMaxGust = 0;
        todayMaxTemp = null;
        todayMinTemp = null;
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
        const humidity = parseFloat(d.outdoor.humidity.value);

        const rainRateMmHr = (parseFloat(d.rainfall.rain_rate.value) * 25.4).toFixed(1);
        const totalRainMm = (parseFloat(d.rainfall.daily.value) * 25.4).toFixed(1);

        const windSpeedKmh = (parseFloat(d.wind.wind_speed.value) * 1.60934).toFixed(1);
        const windGustKmh = (parseFloat(d.wind.wind_gust.value) * 1.60934).toFixed(1);
        const windDir = parseFloat(d.wind.wind_direction.value);

        const pressureHPa = (parseFloat(d.pressure.relative.value) * 33.8639).toFixed(1);
        const solarRadiation = d.solar_and_uvi?.solar?.value ?? 0;
        const uvIndex = d.solar_and_uvi?.uvi?.value ?? '--';

        // Temp rate °C/hr, realistic
        const MIN_INTERVAL_MS = 5 * 60 * 1000;
        let tempChangeRate = 0;
        if (lastTemp !== null && lastTempTime && now - lastTempTime >= MIN_INTERVAL_MS) {
            const diffHours = (now - lastTempTime) / (1000 * 3600);
            tempChangeRate = (parseFloat(tempC) - lastTemp) / diffHours;
            if (Math.abs(tempChangeRate) > 5) tempChangeRate = 0; // ignore unrealistic spikes
        }
        lastTemp = parseFloat(tempC);
        lastTempTime = now;

        // Daily max/min temp
        if (todayMaxTemp === null || tempC > todayMaxTemp) todayMaxTemp = parseFloat(tempC);
        if (todayMinTemp === null || tempC < todayMinTemp) todayMinTemp = parseFloat(tempC);

        // Max rain/wind/gust
        if (parseFloat(rainRateMmHr) > todayMaxRainRate) todayMaxRainRate = parseFloat(rainRateMmHr);
        if (parseFloat(windSpeedKmh) > todayMaxWind) todayMaxWind = parseFloat(windSpeedKmh);
        if (parseFloat(windGustKmh) > todayMaxGust) todayMaxGust = parseFloat(windGustKmh);

        todayHistory.push({
            time: new Date().toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', hour12:false, timeZone:'Asia/Kolkata' }),
            temp: parseFloat(tempC),
            hum: humidity,
            dewPoint: parseFloat(dewPointC),
            rainRate: parseFloat(rainRateMmHr),
            totalRain: parseFloat(totalRainMm),
            windSpeed: parseFloat(windSpeedKmh),
            windDir
        });

        if (todayHistory.length > 1440) todayHistory.shift();

        cachedData = {
            outdoor: {
                temp: tempC,
                feelsLike: feelsLikeC,
                humidity,
                dewPoint: dewPointC,
                tempChangeRate: tempChangeRate.toFixed(1),
                maxTemp: todayMaxTemp,
                minTemp: todayMinTemp,
                solar: solarRadiation,
                uvi: uvIndex
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
            pressure: pressureHPa,
            history: todayHistory
        };

        lastFetch = now;
        res.json(cachedData);
    } catch (err) {
        console.error(err.message);
        if (cachedData) return res.json(cachedData);
        res.status(500).json({ error: "Failed to fetch data from Ecowitt" });
    }
});

app.get("/", (req,res)=>{
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
h1 { text-align:center; padding:22px 15px 15px; font-size:28px; margin:0; background:rgba(15,23,42,0.85); }
.status { text-align:center; font-size:14px; padding:8px; opacity:0.9; }
.container { max-width:1100px; margin:0 auto; padding:12px; }
.card { background:rgba(255,255,255,0.07); backdrop-filter:blur(18px); border-radius:20px; padding:22px; margin-bottom:18px; box-shadow:0 10px 30px rgba(0,0,0,0.35); }
.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:14px; }
.item { text-align:center; }
.label { font-size:13px; opacity:0.75; margin-bottom:5px; }
.value { font-size:28px; font-weight:700; }
.small-value { font-size:16px; font-weight:400; color:#cbd5e1; margin-top:2px; }
.cool { color:#67e8f9; } .mild { color:#fcd34d; } .hot { color:#fb923c; } .veryhot { color:#f87171; }
.red { color:#f87171; } .blue { color:#3b82f6; } .orange { color:#fb923c; }
.chart-container { height:200px; margin-top:12px; }
</style>
</head>
<body>
<h1>KK Nagar Weather Station</h1>
<div id="status" class="status">Loading live data...</div>
<div class="container">

<div class="card">
<div class="grid">
<div class="item">
<div class="label">TEMP</div>
<div class="value" id="temp"></div>
<div id="tempRate" class="small-value"></div>
<div class="small-value" id="maxMinTemp"></div>
</div>
<div class="item"><div class="label">FEELS LIKE</div><div class="value" id="feels"></div></div>
<div class="item"><div class="label">DEW POINT</div><div class="value" id="dewpoint"></div></div>
<div class="item"><div class="label">HUMIDITY</div><div class="value" id="hum"></div></div>
</div></div>

<div class="card">
<div class="grid">
<div class="item"><div class="label">RAIN RATE</div><div class="small-value" id="rain"></div></div>
<div class="item"><div class="label">TOTAL RAIN</div><div class="small-value" id="totalRain"></div></div>
<div class="item"><div class="small-value" id="maxRain"></div></div>
</div></div>

<div class="card">
<div class="grid">
<div class="item"><div class="label">WIND SPEED</div><div class="value" id="wind"></div></div>
<div class="item"><div class="label">GUST</div><div class="value" id="gust"></div></div>
<div class="item"><div class="small-value red" id="maxWind"></div></div>
<div class="item"><div class="small-value orange" id="maxGust"></div></div>
<div class="item"><div class="small-value" id="winddir"></div></div>
</div></div>

<div class="card">
<div class="grid">
<div class="item"><div class="label">SOLAR RADIATION</div><div class="small-value" id="solar"></div></div>
<div class="item"><div class="label">UV INDEX</div><div class="small-value" id="uv"></div></div>
</div></div>

<div class="card">
<h3 style="text-align:center; opacity:0.9;">Recent Trends (IST)</h3>
<div class="chart-container"><canvas id="tempChart"></canvas></div>
<div class="chart-container"><canvas id="humChart"></canvas></div>
<div class="chart-container"><canvas id="windChart"></canvas></div>
</div>

</div>

<script>
document.addEventListener("DOMContentLoaded", function(){
let charts={};

function getTempClass(temp){ if(temp<=25) return 'cool'; if(temp<35) return 'mild'; if(temp<40) return 'hot'; return 'veryhot'; }
function getWindDir(deg){ const dirs=["N","NE","E","SE","S","SW","W","NW"]; return dirs[Math.round(deg/45)%8]; }

function createCharts(){
    const options = {
        animation:false, responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{ labels:{ color:'#e2e8f0' } } },
        scales:{
            x:{ ticks:{ color:'#e2e8f0' }, grid:{ color:'rgba(255,255,255,0.1)' } },
            y:{ ticks:{ color:'#e2e8f0' }, grid:{ color:'rgba(255,255,255,0.1)' } }
        }
    };
    charts.temp = new Chart(document.getElementById('tempChart'),{
        type:'line', data:{ labels:[], datasets:[{label:'Temp (°C)', data:[], borderColor:'#67e8f9', backgroundColor:'rgba(103,232,249,0.2)', tension:0.4, fill:true, pointRadius:2}] }, options
    });
    charts.hum = new Chart(document.getElementById('humChart'),{
        type:'line', data:{ labels:[], datasets:[{label:'Humidity (%)', data:[], borderColor:'#4ade80', backgroundColor:'rgba(74,222,128,0.2)', tension:0.4, fill:true, pointRadius:2}] }, options
    });
    charts.wind = new Chart(document.getElementById('windChart'),{
        type:'line', data:{ labels:[], datasets:[{label:'Wind km/h', data:[], borderColor:'#fb923c', backgroundColor:'rgba(251,146,60,0.2)', tension:0.4, fill:true, pointRadius:2}] }, options
    });
}

async function loadData(){
    try{
        const res=await fetch('/weather');
        const data=await res.json();
        if(data.error){ document.getElementById('status').innerText=data.error; return; }
        const o=data.outdoor,r=data.rainfall,w=data.wind;
        const tempClass=getTempClass(parseFloat(o.temp));
        document.getElementById('temp').innerHTML=\`<span class="\${tempClass}">\${o.temp}°C</span>\`;
        document.getElementById('feels').innerHTML=\`<span class="\${tempClass}">\${o.feelsLike}°C</span>\`;
        document.getElementById('dewpoint').innerText=o.dewPoint+"°C";
        document.getElementById('hum').innerText=o.humidity+"%";

        let rateHTML=''; if(o.tempChangeRate){ const r=parseFloat(o.tempChangeRate); const sign=r>=0?'↑':'↓'; const color=r>=0?'#4ade80':'#f87171'; rateHTML=\`<span style="color:\${color}; font-size:13px;">\${sign} \${Math.abs(r)} °C/hr</span>\`; }
        document.getElementById('tempRate').innerHTML=rateHTML;
        document.getElementById('maxMinTemp').innerHTML=\`<span class="red">Max: \${o.maxTemp}°C</span> | <span class="blue">Min: \${o.minTemp}°C</span>\`;

        document.getElementById('rain').innerText=r.rainRate+" mm/hr";
        document.getElementById('totalRain').innerText=r.totalRain+" mm";
        document.getElementById('maxRain').innerText=r.maxRainRate?"Max Rain Rate: "+r.maxRainRate+" mm/hr":'';

        document.getElementById('wind').innerText=w.speed+" km/h";
        document.getElementById('gust').innerText=w.gust+" km/h";
        document.getElementById('maxWind').innerHTML=\`<span class="red">Max Speed: \${w.maxSpeed} km/h</span>\`;
        document.getElementById('maxGust').innerHTML=\`<span class="orange">Max Gust: \${w.maxGust} km/h</span>\`;
        document.getElementById('winddir').innerText=w.direction+"° ("+getWindDir(w.direction)+")";

        document.getElementById('solar').innerText=o.solar+" W/m²";
        document.getElementById('uv').innerText=o.uvi;

        document.getElementById('status').innerText='✅ Live • Updated '+new Date().toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata'});

        const labels=data.history.map(h=>h.time);
        const tempData=data.history.map(h=>h.temp);
        const humData=data.history.map(h=>h.hum);
        const windData=data.history.map(h=>h.windSpeed);

        charts.temp.options.scales.y.min=Math.min(...tempData)-1;
        charts.temp.options.scales.y.max=Math.max(...tempData)+1;
        charts.temp.data.labels=labels; charts.temp.data.datasets[0].data=tempData; charts.temp.update();

        charts.hum.options.scales.y.min=0; charts.hum.options.scales.y.max=100;
        charts.hum.data.labels=labels; charts.hum.data.datasets[0].data=humData; charts.hum.update();

        charts.wind.options.scales.y.min=0; charts.wind.options.scales.y.max=Math.max(...windData)+2;
        charts.wind.data.labels=labels; charts.wind.data.datasets[0].data=windData; charts.wind.update();

    }catch(e){ document.getElementById('status').innerText="⚠️ Using last known data"; }
}

createCharts(); loadData(); setInterval(loadData,15000);
});
</script>
</body>
</html>
`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("✅ KK Nagar Weather Station running on port " + PORT));
