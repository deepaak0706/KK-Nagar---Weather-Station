const express = require("express");
const fetch = require("node-fetch");

const app = express();

const API_KEY = "ec7a03ba77b341dcba03ba77b3a1dcfc";
const STATION_ID = "ICHENN63";

// API endpoint
app.get("/weather", async (req, res) => {
    try {
        const response = await fetch(
            `https://api.weather.com/v2/pws/observations/current?stationId=${STATION_ID}&format=json&units=m&apiKey=${API_KEY}`
        );
        const data = await response.json();
        res.json(data.observations[0]);
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
        body {
            font-family: Arial;
            margin: 0;
            background: #0f172a;
            color: white;
            text-align: center;
        }
        h1 {
            padding: 15px;
        }
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

async function loadData() {
    try {
        const res = await fetch('/weather');
        const data = await res.json();

        const currentRain = data.metric.precipTotal; // cumulative rain
        const currentTime = Date.now();

        let instantRainRate = 0;

        if (lastRain !== null && lastTime !== null) {
            const rainDiff = currentRain - lastRain;
            const timeDiff = (currentTime - lastTime) / 1000; // seconds

            if (timeDiff > 0 && rainDiff >= 0) {
                instantRainRate = (rainDiff * 3600 / timeDiff).toFixed(2);
            }
        }

        // Update previous values
        lastRain = currentRain;
        lastTime = currentTime;

        // Update UI
        document.getElementById('temp').innerText = data.metric.temp + " °C";
        document.getElementById('hum').innerText = data.humidity + " %";
        document.getElementById('wind').innerText = data.metric.windSpeed + " km/h";
        document.getElementById('rain').innerText = instantRainRate + " mm/hr";
        document.getElementById('totalRain').innerText = currentRain + " mm";
        document.getElementById('uv').innerText = data.uv;
        document.getElementById('solar').innerText = data.solarRadiation;

    } catch (e) {
        console.log("Error loading data");
    }
}

// Refresh every 10 sec
setInterval(loadData, 10000);
loadData();
</script>

</body>
</html>
    `);
});

app.listen(3000, () => console.log("Server running"));
