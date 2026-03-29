const express = require("express");
const fetch = require("node-fetch");

const app = express();

const API_KEY = process.env.API_KEY;
const STATION_ID = "ICHENN63";

let cachedData = null;
let lastFetch = 0;

// API route
app.get("/weather", async (req, res) => {
    const now = Date.now();

    if (cachedData && (now - lastFetch < 10000)) {
        return res.json(cachedData);
    }

    try {
        const response = await fetch(
            `https://api.weather.com/v2/pws/observations/current?stationId=${STATION_ID}&format=json&units=m&apiKey=${API_KEY}`
        );

        const data = await response.json();
        const obs = data.observations[0];

        cachedData = obs;
        lastFetch = now;

        res.json(obs);
    } catch (err) {
        res.json({ error: "Failed to fetch data" });
    }
});

// UI
app.get("/", (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>KK Nagar Weather</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body { font-family: Arial; margin: 0; background: #0f172a; color: white; text-align: center; }
        h1 { padding: 15px; }
        .container {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
            gap: 15px;
            padding: 15px;
        }
        .card {
            background: #1e293b;
            padding: 15px;
            border-radius: 10px;
        }
        .value {
            font-size: 22px;
            font-weight: bold;
        }
    </style>
</head>
<body>

<h1>KK Nagar Weather Station</h1>

<div class="container">
    <div class="card"><div>🌡 Temp</div><div class="value" id="temp">--</div></div>
    <div class="card"><div>💧 Humidity</div><div class="value" id="hum">--</div></div>
    <div class="card"><div>🌬 Wind</div><div class="value" id="wind">--</div></div>
    <div class="card"><div>⚡ Instant Rain</div><div class="value" id="rain">--</div></div>
    <div class="card"><div>🌧 Total Rain</div><div class="value" id="totalRain">--</div></div>
    <div class="card"><div>☀️ UV</div><div class="value" id="uv">--</div></div>
    <div class="card"><div>🌞 Solar</div><div class="value" id="solar">--</div></div>
</div>

<script>
let lastRain = null;
let lastTime = null;

function formatDecimal(value, digits = 1) {
    return Number(value).toFixed(digits);
}

async function loadData() {
    try {
        const res = await fetch('/weather');
        const data = await res.json();

        const currentRain = data.metric.precipTotal;
        const currentTime = Date.now();

        let instantRainRate = 0;

        if (lastRain !== null && lastTime !== null) {
            const rainDiff = currentRain - lastRain;
            const timeDiff = (currentTime - lastTime) / 1000;

            if (timeDiff > 0 && rainDiff >= 0) {
                instantRainRate = (rainDiff * 3600 / timeDiff);
            }
        }

        lastRain = currentRain;
        lastTime = currentTime;

        // 👇 DECIMAL FIX APPLIED HERE
        document.getElementById('temp').innerText = formatDecimal(data.metric.temp, 1) + " °C";
        document.getElementById('hum').innerText = formatDecimal(data.humidity, 0) + " %";
        document.getElementById('wind').innerText = formatDecimal(data.metric.windSpeed, 1) + " km/h";
        document.getElementById('rain').innerText = formatDecimal(instantRainRate, 2) + " mm/hr";
        document.getElementById('totalRain').innerText = formatDecimal(currentRain, 2) + " mm";
        document.getElementById('uv').innerText = formatDecimal(data.uv, 1);
        document.getElementById('solar').innerText = formatDecimal(data.solarRadiation, 0);

    } catch (e) {
        console.log("Error loading data");
    }
}

setInterval(loadData, 10000);
loadData();
</script>

</body>
</html>
    `);
});

app.listen(3000, () => console.log("Server running"));
