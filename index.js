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
let lastTemp = null;
let lastTempTime = null;

app.get("/weather", async (req, res) => {
    const now = Date.now();
    const todayStr = new Date().toDateString();

    if (todayStr !== currentDate) {
        todayHistory = [];
        todayMaxRainRate = 0;
        todayMaxWindSpeed = 0;
        todayMaxWindGust = 0;
        currentDate = todayStr;
    }

    if (cachedData && (now - lastFetch < 30000)) {
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

        let tempChangeRate = 0;
        if (lastTemp !== null && lastTempTime !== null) {
            const timeDiffHrs = (Date.now() - lastTempTime) / (1000 * 3600);
            if (timeDiffHrs > 0) {
                tempChangeRate = ((parseFloat(tempC) - lastTemp) / timeDiffHrs).toFixed(1);
            }
        }
        lastTemp = parseFloat(tempC);
        lastTempTime = Date.now();

        const currentRainRate = parseFloat(rainRateMmHr);
        if (currentRainRate > todayMaxRainRate) todayMaxRainRate = currentRainRate;
        const currentWindSpeed = parseFloat(windSpeedKmh);
        const currentWindGust = parseFloat(windGustKmh);
        if (currentWindSpeed > todayMaxWindSpeed) todayMaxWindSpeed = currentWindSpeed;
        if (currentWindGust > todayMaxWindGust) todayMaxWindGust = currentWindGust;

        todayHistory.push({
            time: new Date().toISOString(),
            temp: parseFloat(tempC),
            hum: parseFloat(d.outdoor.humidity.value),
            rainRate: currentRainRate,
            totalRain: parseFloat(totalRainMm),
            windSpeed: currentWindSpeed,
            windGust: currentWindGust,
            windDir: parseFloat(d.wind.wind_direction.value)
        });

        if (todayHistory.length > 1440) todayHistory.shift();

        cachedData = {
            outdoor: {
                temp: tempC,
                feelsLike: feelsLikeC,
                humidity: parseFloat(d.outdoor.humidity.value),
                dewPoint: dewPointC,
                tempChangeRate: parseFloat(tempChangeRate),
                maxTemp: Math.max(...todayHistory.map(h=>h.temp)).toFixed(1),
                minTemp: Math.min(...todayHistory.map(h=>h.temp)).toFixed(1)
            },
            rainfall: {
                rainRate: rainRateMmHr,
                totalRain: totalRainMm,
                maxRainRate: todayMaxRainRate.toFixed(1)
            },
            wind: {
                speed: windSpeedKmh,
                gust: windGustKmh,
                maxSpeed: todayMaxWindSpeed.toFixed(1),
                maxGust: todayMaxWindGust.toFixed(1),
                direction: d.wind.wind_direction.value
            },
            solar_uv: {
                solar: d.solar_and_uvi.solar.value,
                uvi: d.solar_and_uvi.uvi.value
            },
            pressure: (parseFloat(d.pressure.relative.value) * 33.8639).toFixed(1),
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
.small { font-size:14px; font-weight:400; opacity:0.85; }
.rise { color:#4ade80; } .fall { color:#f87171; }
.cool { color:#67e8f9; } .mild { color:#fcd34d; } .hot { color:#fb923c; } .veryhot { color:#f87171; }
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
            <div class="small" id="tempRate"></div>
            <div class="small" id="tempMaxMin"></div>
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
            <div class="small" id="windMax"></div>
        </div>
        <div class="item">
            <div class="label">WIND GUST</div>
            <div class="value" id="gust"></div>
            <div class="small" id="gustMax"></div>
        </div>
        <div class="item" style="grid-column:1/-1; text-align:center;">
            <div class="label">WIND DIRECTION</div>
            <div class="value" id="winddir"></div>
        </div>
    </div>
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
let charts={};

function format(v){ return isNaN(parseFloat(v))?'--':parseFloat(v).toFixed(1); }

function getWindDirection(degrees) {
    const directions = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    const index = Math.round(degrees / 22.5) % 16;
    return directions[index];
}

function createCharts(){
    const opt = {
        animation:false,
        scales:{
            y:{ beginAtZero:false,ticks:{ callback: v=>v.toFixed(1) } },
            x:{ 
                type:'category', 
                ticks:{ 
                    maxRotation: 45,
                    minRotation: 45,
                    callback: function(value, index) {
                        return index % 4 === 0 ? this.getLabelForValue(value) : '';
                    }
                }
            }
        },
        plugins: {
            legend: { display: true, position: 'top' }
        }
    };
    charts.temp = new Chart(document.getElementById('tempChart'),{
        type:'line', data:{ labels:[], datasets:[{label:'Temperature (°C)', data:[], borderColor:'#67e8f9', tension:0.3}]}, options:opt
    });
    charts.hum = new Chart(document.getElementById('humChart'),{
        type:'line', data:{ labels:[], datasets:[{label:'Humidity (%)', data:[], borderColor:'#4ade80', tension:0.3}]}, options:opt
    });
    charts.wind = new Chart(document.getElementById('windChart'),{
        type:'line', data:{ labels:[], datasets:[{label:'Wind Speed (km/h)', data:[], borderColor:'#fb923c', tension:0.3}]}, options:opt
    });
}

async function loadData(){
    try{
        const res = await fetch('/weather');
        const data = await res.json();
        if(data.error){ 
            document.getElementById('status').innerHTML='⚠️ '+data.error; 
            return; 
        }

        const o=data.outdoor, r=data.rainfall, w=data.wind, s=data.solar_uv;

        // Temperature
        document.getElementById('temp').innerText = o.temp+'°C';
        let rate=o.tempChangeRate, sign=rate>=0?'↑':'↓', color=rate>=0?'#4ade80':'#f87171';
        document.getElementById('tempRate').innerHTML='<span style="color:'+color+'">'+sign+' '+Math.abs(rate)+' °C/hr</span>';
        document.getElementById('tempMaxMin').innerHTML='Max: <span style="color:#f87171">'+o.maxTemp+'</span> | Min: <span style="color:#67e8f9">'+o.minTemp+'</span>';
        document.getElementById('dewpoint').innerText=o.dewPoint+'°C';
        document.getElementById('hum').innerText=o.humidity+'%';
        document.getElementById('feels').innerText=o.feelsLike+'°C';

        document.getElementById('rain').innerText=r.rainRate+' mm/hr (Max: '+r.maxRainRate+')';
        document.getElementById('totalRain').innerText=r.totalRain+' mm';

        document.getElementById('wind').innerText=w.speed+' km/h';
        document.getElementById('gust').innerText=w.gust+' km/h';
        document.getElementById('windMax').innerText='Max Speed: '+w.maxSpeed+' km/h';
        document.getElementById('gustMax').innerText='Max Gust: '+w.maxGust+' km/h';

        // Wind direction with name in brackets (e.g. 225° (SW))
        const dir = parseFloat(w.direction);
        const dirName = getWindDirection(dir);
        document.getElementById('winddir').innerText = dir + '° (' + dirName + ')';

        document.getElementById('pressure').innerText=data.pressure+' hPa';
        document.getElementById('uv').innerText=s.uvi;
        document.getElementById('solar').innerText=s.solar+' W/m²';

        // IST time labels
        const labels = data.history.map(h=>{
            const d = new Date(h.time);
            return d.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'Asia/Kolkata'});
        });

        charts.temp.data.labels = labels;
        charts.temp.data.datasets[0].data = data.history.map(h=>h.temp);
        charts.hum.data.labels = labels;
        charts.hum.data.datasets[0].data = data.history.map(h=>h.hum);
        charts.wind.data.labels = labels;
        charts.wind.data.datasets[0].data = data.history.map(h=>h.windSpeed);

        charts.temp.update(); charts.hum.update(); charts.wind.update();

        document.getElementById('status').innerHTML='✅ Live • Updated '+new Date().toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata'});
    }catch(e){
        console.error(e);
        document.getElementById('status').innerHTML="⚠️ Using last known data";
    }
}

createCharts();
loadData();
setInterval(loadData,30000);
</script>

</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT,()=>console.log("✅ KK Nagar Weather Station running on port "+PORT));
