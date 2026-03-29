const express = require("express");
const app = express();

const API_KEY = process.env.API_KEY;
const STATION_ID = "ICHENN63";

let cachedData = null;
let lastFetch = 0;

let todayHistory = [];
let todayMaxRainRate = 0;
let currentDate = new Date().toDateString();

// Rain accumulators with initial values
let weeklyRain = 0;
let monthlyRain = 8.9;   // initial monthly rain
let yearlyRain = 90.2;   // initial yearly rain
let currentWeek = getWeekNumber(new Date());
let currentMonth = new Date().getMonth();
let currentYear = new Date().getFullYear();

function getWeekNumber(d) {
    d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

app.get("/weather", async (req, res) => {
    const now = Date.now();
    const todayStr = new Date().toDateString();
    const nowDate = new Date();

    if (todayStr !== currentDate) {
        todayHistory = [];
        todayMaxRainRate = 0;
        currentDate = todayStr;
    }

    const weekNum = getWeekNumber(nowDate);
    if (weekNum !== currentWeek) { weeklyRain = 0; currentWeek = weekNum; }
    const monthNum = nowDate.getMonth();
    if (monthNum !== currentMonth) { monthlyRain = 0; currentMonth = monthNum; }
    const yearNum = nowDate.getFullYear();
    if (yearNum !== currentYear) { yearlyRain = 0; currentYear = yearNum; }

    if (cachedData && (now - lastFetch < 60000)) return res.json(cachedData);

    try {
        const weatherRes = await fetch(`https://api.weather.com/v2/pws/observations/current?stationId=${STATION_ID}&format=json&units=m&apiKey=${API_KEY}`);
        if (!weatherRes.ok) throw new Error(`API error: ${weatherRes.status}`);
        const weatherData = await weatherRes.json();
        const obs = weatherData.observations[0];
        if (!obs) throw new Error("No observations");

        const sunRes = await fetch(`https://api.sunrise-sunset.org/json?lat=${obs.lat}&lng=${obs.lon}&formatted=0`);
        const sunData = await sunRes.json().catch(() => ({ results: { sunrise: null, sunset: null } }));

        const rainTotal = obs.metric.precipTotal || 0;
        const windSpeed = obs.metric.windSpeed || 0;

        let rainRate = 0;
        if (todayHistory.length > 0) {
            const lastEntry = todayHistory[todayHistory.length - 1];
            const timeDiff = (Date.now() - lastEntry.time.getTime()) / 1000;
            if (timeDiff > 0) rainRate = ((rainTotal - lastEntry.rain) * 3600) / timeDiff;
        }
        todayMaxRainRate = Math.max(todayMaxRainRate, rainRate);

        weeklyRain += rainTotal;
        monthlyRain += rainTotal;
        yearlyRain += rainTotal;

        todayHistory.push({
            time: new Date(),
            temp: obs.metric.temp,
            hum: obs.humidity,
            dewpt: obs.metric.dewpt,
            rain: rainTotal,
            windSpeed: windSpeed,
            windDir: obs.winddir || 0
        });

        while (todayHistory.length > 20) todayHistory.shift(); // keep last 20 points (~5 min auto)

        cachedData = {
            obs,
            sunrise: sunData.results.sunrise,
            sunset: sunData.results.sunset,
            history: todayHistory,
            maxRainRate: todayMaxRainRate,
            totalRain24h: rainTotal,
            weeklyRain,
            monthlyRain,
            yearlyRain,
            currentDate
        };

        lastFetch = now;
        res.json(cachedData);
    } catch (e) {
        console.error("API Error:", e.message);
        if (cachedData) return res.json(cachedData);
        res.status(500).json({ error: "Failed to fetch data" });
    }
});

app.get("/", (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>KK Nagar Weather Station</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<style>
body{margin:0;font-family:'Segoe UI',Arial,sans-serif;background:linear-gradient(135deg,#0f172a,#1e293b);color:#e2e8f0;min-height:100vh;animation:bgAnim 60s linear infinite;}
@keyframes bgAnim{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
h1{text-align:center;padding:16px;font-size:28px;margin:0;background:rgba(15,23,42,0.85);}
.status{text-align:center;font-size:12px;padding:6px;opacity:0.85;}
.container{max-width:1200px;margin:0 auto;padding:10px;display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;}
.card{background:rgba(255,255,255,0.05);backdrop-filter:blur(24px);border-radius:18px;padding:16px;box-shadow:0 8px 25px rgba(0,0,0,0.35);}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:8px;}
.item{text-align:center;}
.label{font-size:12px;opacity:0.75;margin-bottom:4px;}
.value{font-size:22px;font-weight:700;}
.wind-arrow{font-size:36px;margin:8px 0;transition:transform 0.6s cubic-bezier(0.4,0,0.2,1);}
.cool{color:#67e8f9;}
.mild{color:#fcd34d;}
.hot{color:#fb923c;}
.veryhot{color:#f87171;}
.badge{display:inline-block;padding:2px 6px;border-radius:6px;background:rgba(0,0,0,0.3);font-size:11px;opacity:0.8;margin-top:4px;}
canvas{background:rgba(15,23,42,0.95);border-radius:12px;padding:12px;margin-top:8px;width:100%;}
</style>
</head>
<body>
<h1>KK Nagar Weather Station</h1>
<div id="status" class="status">Loading live data...</div>
<div class="container">

<div class="card">
  <div class="grid">
    <div class="item"><div class="label">🌡️ TEMPERATURE</div><div class="value" id="temp"></div></div>
    <div class="item"><div class="label">🤗 FEELS LIKE</div><div class="value" id="feels"></div></div>
    <div class="item"><div class="label">💧 DEW POINT</div><div class="value" id="dewpoint"></div></div>
    <div class="item"><div class="label">💦 HUMIDITY</div><div class="value" id="hum"></div></div>
  </div>
</div>

<div class="card">
  <div class="grid">
    <div class="item"><div class="label">🌧️ CURRENT RAIN</div><div class="value" id="currentRain"></div></div>
    <div class="item"><div class="label">💨 RAIN RATE</div><div class="value" id="rainRate"></div></div>
    <div class="item"><div class="label">24H TOTAL</div><div class="value" id="totalRain"></div></div>
    <div class="item"><div class="label">WEEKLY</div><div class="value" id="weeklyRain"></div></div>
    <div class="item"><div class="label">MONTHLY</div><div class="value" id="monthlyRain"></div></div>
    <div class="item"><div class="label">YEARLY</div><div class="value" id="yearlyRain"></div></div>
  </div>
</div>

<div class="card">
  <div class="grid">
    <div class="item"><div class="label">💨 WIND SPEED</div><div class="value" id="wind"></div><div class="wind-arrow" id="arrow">⬆️</div><div class="badge" id="winddir"></div></div>
    <div class="item"><div class="label">🌞 UV INDEX</div><div class="value" id="uv"></div></div>
    <div class="item"><div class="label">☀️ SOLAR RADIATION</div><div class="value" id="solar"></div></div>
    <div class="item"><div class="label">🌅 SUNRISE</div><div class="value" id="sunrise"></div></div>
    <div class="item"><div class="label">🌇 SUNSET</div><div class="value" id="sunset"></div></div>
  </div>
</div>

<div class="card">
  <h3 style="margin:0 0 12px 0;text-align:center;opacity:0.85;">Recent Trends (Last 5 min)</h3>
  <canvas id="tempChart" height="120"></canvas>
  <canvas id="humChart" height="120"></canvas>
  <canvas id="windChart" height="120"></canvas>
</div>

</div>
<script>
let lastRain=null,lastTime=null,charts={};
function format(v){return isNaN(parseFloat(v))? '--':v.toFixed(1);}
function getWindDirection(deg){const dirs=["N","NE","E","SE","S","SW","W","NW"];return dirs[Math.round(deg/45)%8];}
function getTempClass(temp){if(temp<=25)return "cool";if(temp<35)return "mild";if(temp<40)return "hot";return "veryhot";}
function createCharts(){
  const opt={animation:false,scales:{x:{type:'time',time:{unit:'minute',displayFormats:{minute:'HH:mm'}},ticks:{maxTicksLimit:5}},y:{beginAtZero:false}}};
  charts.temp=new Chart(document.getElementById('tempChart'), {type:'line', data:{labels:[], datasets:[{label:'Temperature (°C)', data:[], borderColor:'#67e8f9', backgroundColor:'rgba(103,232,249,0.2)', tension:0.3, fill:true}]}, options:opt});
  charts.hum=new Chart(document.getElementById('humChart'), {type:'line', data:{labels:[], datasets:[{label:'Humidity (%)', data:[], borderColor:'#4ade80', backgroundColor:'rgba(74,222,128,0.2)', tension:0.3, fill:true}]}, options:opt});
  charts.wind=new Chart(document.getElementById('windChart'), {type:'line', data:{labels:[], datasets:[{label:'Wind Speed (km/h)', data:[], borderColor:'#fb923c', backgroundColor:'rgba(251,146,60,0.2)', tension:0.3, fill:true}]}, options:opt});
}
async function loadData(){
  try{
    const res=await fetch('/weather'); const data=await res.json();
    if(data.error){document.getElementById('status').innerHTML='⚠️ '+data.error;return;}
    const d=data.obs, nowTime=Date.now(), currentRain=d.metric.precipTotal||0;
    let rainRate=0;
    if(lastRain!==null){const diff=currentRain-lastRain;const t=(nowTime-lastTime)/1000;if(t>0&&diff>=0) rainRate=(diff*3600/t);}
    lastRain=currentRain; lastTime=nowTime;

    const tempClass=getTempClass(d.metric.temp);
    document.getElementById('temp').innerHTML='<span class="'+tempClass+'">'+format(d.metric.temp)+'°C</span>';
    document.getElementById('feels').innerHTML='<span class="'+tempClass+'">'+format(d.metric.heatIndex)+'°C</span>';
    document.getElementById('dewpoint').innerText=format(d.metric.dewpt)+'°C';
    document.getElementById('hum').innerText=format(d.humidity)+'%';
    document.getElementById('wind').innerText=format(d.metric.windSpeed)+' km/h';
    document.getElementById('arrow').style.transform='rotate('+d.winddir+'deg)';
    document.getElementById('winddir').innerText=d.winddir+'° ('+getWindDirection(d.winddir)+')';
    document.getElementById('currentRain').innerText=format(currentRain)+' mm';
    document.getElementById('rainRate').innerText=format(rainRate)+' mm/hr (Max: '+format(data.maxRainRate)+')';
    document.getElementById('totalRain').innerText=format(data.totalRain24h)+' mm';
    document.getElementById('weeklyRain').innerText=format(data.weeklyRain)+' mm';
    document.getElementById('monthlyRain').innerText=format(data.monthlyRain)+' mm';
    document.getElementById('yearlyRain').innerText=format(data.yearlyRain)+' mm';
    document.getElementById('uv').innerText=format(d.uv);
    document.getElementById('solar').innerText=format(d.solarRadiation);
    if(data.sunrise) document.getElementById('sunrise').innerText=new Date(data.sunrise).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    if(data.sunset) document.getElementById('sunset').innerText=new Date(data.sunset).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    document.getElementById('status').innerHTML='✅ Live • Updated '+new Date().toLocaleTimeString();

    const labels=data.history.map(h=>h.time);
    charts.temp.data.labels=labels; charts.temp.data.datasets[0].data=data.history.map(h=>h.temp);
    charts.hum.data.labels=labels; charts.hum.data.datasets[0].data=data.history.map(h=>h.hum);
    charts.wind.data.labels=labels; charts.wind.data.datasets[0].data=data.history.map(h=>h.windSpeed);
    charts.temp.update(); charts.hum.update(); charts.wind.update();
  }catch(e){document.getElementById('status').innerHTML="⚠️ Using last known data";}
}
createCharts(); setInterval(loadData,60000); loadData();
</script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("✅ KK Nagar Weather Station running on port " + PORT));
