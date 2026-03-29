const express = require("express");
const app = express();

const API_KEY = process.env.API_KEY;
const STATION_ID = "ICHENN63";

let cachedData = null;
let lastFetch = 0;
let history = [];

app.get("/weather", async (req, res) => {
    const now = Date.now();

    if (cachedData && (now - lastFetch < 60000)) {
        return res.json(cachedData);
    }

    try {
        const weatherRes = await fetch(
            `https://api.weather.com/v2/pws/observations/current?stationId=${STATION_ID}&format=json&units=m&apiKey=${API_KEY}`
        );

        if (!weatherRes.ok) throw new Error(`API error: ${weatherRes.status}`);

        const weatherData = await weatherRes.json();
        const obs = weatherData.observations[0];

        if (!obs) throw new Error("No observations");

        const sunRes = await fetch(
            `https://api.sunrise-sunset.org/json?lat=${obs.lat}&lng=${obs.lon}&formatted=0`
        );
        const sunData = await sunRes.json().catch(() => ({ results: { sunrise: null, sunset: null } }));

        history.push({
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            temp: obs.metric.temp,
            hum: obs.humidity,
            rain: obs.metric.precipTotal || 0,
            windSpeed: obs.metric.windSpeed || 0,
            windDir: obs.winddir || 0
        });

        if (history.length > 30) history.shift();

        cachedData = {
            obs,
            sunrise: sunData.results.sunrise,
            sunset: sunData.results.sunset,
            history
        };

        lastFetch = now;
        res.json(cachedData);

    } catch (error) {
        console.error("API Error:", error.message);
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
        body { margin:0; font-family:Arial,sans-serif; background:linear-gradient(135deg,#0f172a,#1e293b); color:#e2e8f0; min-height:100vh; }
        h1 { text-align:center; padding:25px 15px 10px; font-size:28px; margin:0; background:rgba(15,23,42,0.8); }
        .status { text-align:center; font-size:14px; padding:10px; opacity:0.9; }
        .container { max-width:1100px; margin:0 auto; padding:15px; }
        .card {
            background:rgba(255,255,255,0.08);
            backdrop-filter:blur(12px);
            border-radius:20px;
            padding:22px;
            margin-bottom:18px;
            box-shadow:0 8px 32px rgba(0,0,0,0.3);
        }
        .grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(160px,1fr)); gap:16px; }
        .item { text-align:center; padding:12px; }
        .label { font-size:13px; opacity:0.75; margin-bottom:6px; }
        .value { font-size:28px; font-weight:700; }
        .wind-container { text-align:center; padding:20px; }
        .wind-arrow {
            font-size:52px;
            margin:15px 0;
            transition:transform 0.6s cubic-bezier(0.4,0,0.2,1);
            display:inline-block;
        }
        canvas { background:#fff; border-radius:16px; padding:15px; margin-top:12px; }
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
                <div class="item"><div class="label">Temperature</div><div class="value" id="temp"></div></div>
                <div class="item"><div class="label">Feels Like</div><div class="value" id="feels"></div></div>
                <div class="item"><div class="label">Humidity</div><div class="value" id="hum"></div></div>
            </div>
        </div>

        <div class="card">
            <div class="grid">
                <div class="item"><div class="label">Rain Rate</div><div class="value" id="rain"></div></div>
                <div class="item"><div class="label">Total Rain</div><div class="value" id="totalRain"></div></div>
                <div class="item"><div class="label">Dew Point</div><div class="value" id="dewpoint"></div></div>
            </div>
        </div>

        <div class="card wind-container">
            <div class="label">Wind</div>
            <div class="value" id="wind"></div>
            <div class="wind-arrow" id="arrow">⬆️</div>
            <div id="winddir"></div>
        </div>

        <div class="card">
            <div class="grid">
                <div class="item"><div class="label">UV Index</div><div class="value" id="uv"></div></div>
                <div class="item"><div class="label">Solar</div><div class="value" id="solar"></div></div>
                <div class="item"><div class="label">Pressure</div><div class="value" id="pressure"></div></div>
            </div>
        </div>

        <div class="card">
            <div class="grid">
                <div class="item"><div class="label">Sunrise</div><div class="value" id="sunrise"></div></div>
                <div class="item"><div class="label">Sunset</div><div class="value" id="sunset"></div></div>
            </div>
        </div>

        <div class="card">
            <h3 style="margin:0 0 15px 0; text-align:center;">Trends • Last 30 points</h3>
            <canvas id="tempChart" height="130"></canvas>
            <canvas id="humChart" height="130"></canvas>
            <canvas id="windChart" height="130"></canvas>
        </div>
    </div>

    <script>
        let lastRain = null;
        let lastTime = null;
        let charts = {};

        function format(v) { return isNaN(parseFloat(v)) ? '--' : Math.round(v); }

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
            const opt = { animation: false, scales: { y: { beginAtZero: true } } };
            charts.temp = new Chart(document.getElementById('tempChart'), { type:'line', data:{labels:[], datasets:[{label:'Temp (°C)', data:[], borderColor:'#67e8f9', tension:0.3}]}, options:opt });
            charts.hum = new Chart(document.getElementById('humChart'), { type:'line', data:{labels:[], datasets:[{label:'Humidity (%)', data:[], borderColor:'#4ade80', tension:0.3}]}, options:opt });
            charts.wind = new Chart(document.getElementById('windChart'), { type:'line', data:{labels:[], datasets:[{label:'Wind (km/h)', data:[], borderColor:'#fb923c', tension:0.3}]}, options:opt });
        }

        async function loadData() {
            try {
                const res = await fetch('/weather');
                const data = await res.json();

                if (data.error) {
                    document.getElementById('status').innerHTML = \`⚠️ \${data.error}\`;
                    return;
                }

                const d = data.obs;
                const currentRain = d.metric.precipTotal || 0;
                const nowTime = Date.now();

                let rainRate = 0;
                if (lastRain !== null) {
                    const diff = currentRain - lastRain;
                    const t = (nowTime - lastTime) / 1000;
                    if (t > 0 && diff >= 0) rainRate = (diff * 3600 / t);
                }
                lastRain = currentRain;
                lastTime = nowTime;

                const tempClass = getTempClass(d.metric.temp);

                document.getElementById('temp').innerHTML = \`<span class="\${tempClass}">\${format(d.metric.temp)}°C</span>\`;
                document.getElementById('feels').innerHTML = \`<span class="\${tempClass}">\${format(d.metric.heatIndex)}°C</span>\`;
                document.getElementById('hum').innerText = format(d.humidity) + "%";

                document.getElementById('wind').innerText = format(d.metric.windSpeed) + " km/h";
                document.getElementById('arrow').style.transform = \`rotate(\${d.winddir}deg)\`;
                document.getElementById('winddir').innerText = \`\${d.winddir}° (\${getWindDirection(d.winddir)})\`;

                document.getElementById('rain').innerText = format(rainRate) + " mm/hr";
                document.getElementById('totalRain').innerText = format(currentRain) + " mm";
                document.getElementById('dewpoint').innerText = format(d.metric.dewpt) + "°C";
                document.getElementById('pressure').innerText = format(d.metric.pressure) + " hPa";

                document.getElementById('uv').innerText = format(d.uv);
                document.getElementById('solar').innerText = format(d.solarRadiation);

                if (data.sunrise) document.getElementById('sunrise').innerText = new Date(data.sunrise).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
                if (data.sunset) document.getElementById('sunset').innerText = new Date(data.sunset).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});

                document.getElementById('status').innerHTML = \`✅ Live • Updated \${new Date().toLocaleTimeString()}\`;

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
        setInterval(loadData, 60000);
        loadData();
    </script>
</body>
</html>
`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(\`✅ KK Nagar Weather Station running on port \${PORT}\`);
    console.log(\`Station ID: \${STATION_ID}\`);
});
