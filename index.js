const express = require("express");
const app = express();

// ===== ENV =====
const APP_KEY = process.env.ECOWITT_APP_KEY;
const API_KEY = process.env.ECOWITT_API_KEY;
const DEVICE_ID = process.env.ECOWITT_DEVICE_ID;

// ===== STATE =====
let cachedData = null;
let lastFetch = 0;

let history = [];
let maxTemp = -Infinity;
let minTemp = Infinity;
let maxWind = 0;
let maxGust = 0;
let maxRainRate = 0;

let lastRain = null;
let lastTime = null;

let currentDate = new Date().toDateString();

// ===== HELPERS =====
const fToC = f => (f - 32) * 5/9;
const mphToKmh = m => m * 1.60934;
const inchToMm = i => i * 25.4;

app.get("/weather", async (req, res) => {
    const now = Date.now();
    const today = new Date().toDateString();

    if (today !== currentDate) {
        history = [];
        maxTemp = -Infinity;
        minTemp = Infinity;
        maxWind = 0;
        maxGust = 0;
        maxRainRate = 0;
        lastRain = null;
        lastTime = null;
        currentDate = today;
    }

    if (cachedData && now - lastFetch < 60000) {
        return res.json(cachedData);
    }

    try {
        const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APP_KEY}&api_key=${API_KEY}&device_id=${DEVICE_ID}`;
        const r = await fetch(url);
        const json = await r.json();

        if (json.code !== 0) throw new Error("API error");

        const d = json.data;

        // ===== CONVERT =====
        const temp = fToC(Number(d.outdoor.temperature.value));
        const feels = fToC(Number(d.outdoor.feels_like.value));
        const dew = fToC(Number(d.outdoor.dew_point.value));
        const hum = Number(d.outdoor.humidity.value);

        const wind = mphToKmh(Number(d.wind.wind_speed.value));
        const gust = mphToKmh(Number(d.wind.wind_gust.value));
        const dir = Number(d.wind.wind_direction.value);

        const rainTotal = inchToMm(Number(d.rainfall.daily.value));
        const rawRain = rainTotal;

        const uv = Number(d.solar_and_uvi.uvi.value);
        const solar = Number(d.solar_and_uvi.solar.value);

        // ===== INSTANT RAIN RATE =====
        let rainRate = 0;

        if (lastRain !== null) {
            const diff = rawRain - lastRain;
            const dt = (now - lastTime) / 1000;

            if (diff >= 0 && diff < 5 && dt > 0) {
                rainRate = (diff * 3600) / dt;
            }
        }

        lastRain = rawRain;
        lastTime = now;

        maxRainRate = Math.max(maxRainRate, rainRate);

        // ===== MAX TRACK =====
        maxTemp = Math.max(maxTemp, temp);
        minTemp = Math.min(minTemp, temp);
        maxWind = Math.max(maxWind, wind);
        maxGust = Math.max(maxGust, gust);

        // ===== HISTORY =====
        history.push({
            ts: now,
            temp,
            hum,
            wind,
            rain: rainTotal
        });

        if (history.length > 1440) history.shift();

        cachedData = {
            temp, feels, dew, hum,
            wind, gust, dir,
            rainTotal,
            rainRate,
            maxRainRate,
            uv, solar,
            maxTemp, minTemp,
            maxWind, maxGust,
            history,
            updatedTs: now
        };

        lastFetch = now;

        res.setHeader("Cache-Control", "no-store");
        res.json(cachedData);

    } catch (e) {
        if (cachedData) return res.json(cachedData);
        res.status(500).json({ error: "API error" });
    }
});

// ===== UI =====
app.get("/", (req, res) => {
res.send(`<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>

<style>
body{margin:0;font-family:'Segoe UI';background:#0f172a;color:#fff}
.container{padding:15px}
.section{background:#1e293b;padding:15px;border-radius:14px;margin-top:10px}
.title{font-size:14px;opacity:.7}
.big{font-size:30px;font-weight:600}
.center{text-align:center}
.compass{width:120px;height:120px;border:2px solid #555;border-radius:50%;margin:auto;position:relative}
.arrow{position:absolute;top:50%;left:50%;transform-origin:50% 100%;transform:translate(-50%,-100%) rotate(0deg);transition:.5s}
canvas{background:#0f172a;border-radius:10px;margin-top:10px}
</style>
</head>

<body>
<div class="container">

<div id="status" class="center"></div>

<div class="section center">
<div class="title">Temperature</div>
<div id="temp" class="big"></div>
<div id="extra"></div>
<div id="dew"></div>
</div>

<div class="section center">
<div class="title">Humidity</div>
<div id="hum" class="big"></div>
</div>

<div class="section center">
<div class="title">Wind</div>
<div class="compass"><div id="arrow" class="arrow">▲</div></div>
<div id="wind"></div>
<div id="gust"></div>
<div id="maxWind"></div>
</div>

<div class="section center">
<div class="title">Rainfall</div>
<div>Total: <span id="rain"></span> mm</div>
<div>Rate: <span id="rainRate"></span> mm/hr</div>
<div>Max: <span id="maxRainRate"></span></div>
</div>

<div class="section center">
<div class="title">Sun</div>
<div>UV: <span id="uv"></span></div>
<div>Solar: <span id="solar"></span></div>
</div>

<canvas id="chart"></canvas>

</div>

<script>
function toIST(ts){
 return new Date(ts).toLocaleTimeString("en-IN",{timeZone:"Asia/Kolkata"})+" IST";
}

let chart=new Chart(document.getElementById("chart"),{
 type:"line",
 data:{labels:[],datasets:[{label:"Temp °C",data:[]}]},
 options:{animation:false}
});

function f(v){return (v==null)?'--':Number(v).toFixed(1);}

async function load(){
 const r=await fetch('/weather?ts='+Date.now());
 const d=await r.json();

 document.getElementById("status").innerText="Last Updated: "+toIST(d.updatedTs);

 document.getElementById("temp").innerText=f(d.temp)+"°C";
 document.getElementById("extra").innerText="Max "+f(d.maxTemp)+" / Min "+f(d.minTemp);
 document.getElementById("dew").innerText="Dew "+f(d.dew)+"°C";

 document.getElementById("hum").innerText=f(d.hum)+"%";

 document.getElementById("wind").innerText="Speed "+f(d.wind)+" km/h";
 document.getElementById("gust").innerText="Gust "+f(d.gust)+" km/h";
 document.getElementById("maxWind").innerText="Max "+f(d.maxWind)+" / "+f(d.maxGust);

 document.getElementById("arrow").style.transform="translate(-50%,-100%) rotate("+d.dir+"deg)";

 document.getElementById("rain").innerText=f(d.rainTotal);
 document.getElementById("rainRate").innerText=f(d.rainRate);
 document.getElementById("maxRainRate").innerText=f(d.maxRainRate);

 document.getElementById("uv").innerText=f(d.uv);
 document.getElementById("solar").innerText=f(d.solar);

 chart.data.labels=d.history.map(h=>toIST(h.ts));
 chart.data.datasets[0].data=d.history.map(h=>h.temp);
 chart.update();
}

load();
setInterval(load,60000);
</script>

</body>
</html>`);
});

app.listen(process.env.PORT || 3000);
