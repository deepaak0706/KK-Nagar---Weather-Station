const express = require("express");
const fetch = require("node-fetch");
const app = express();

const APPLICATION_KEY = process.env.APPLICATION_KEY;
const API_KEY = process.env.API_KEY;
const MAC = process.env.MAC;

let state = {
    cachedData: null,
    todayHistory: [],
    maxTemp: -999,
    minTemp: 999,
    lastFetchTime: 0,
    currentDate: new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })
};

const getCard = (a) => ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"][Math.round(a/22.5)%16];

async function syncWithEcowitt() {
    const now = Date.now();
    // Cache on server for 40s so we don't hit Ecowitt limits
    if (state.cachedData && (now - state.lastFetchTime < 40000)) return state.cachedData;

    try {
        const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}`;
        const response = await fetch(url);
        const json = await response.json();
        const d = json.data;

        const tempC = parseFloat(((d.outdoor.temperature.value - 32) * 5 / 9).toFixed(1));
        const rainRate = parseFloat((d.rainfall.rain_rate.value * 25.4).toFixed(1));
        const windKmh = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));

        if (tempC > state.maxTemp || state.maxTemp === -999) state.maxTemp = tempC;
        if (tempC < state.minTemp || state.minTemp === 999) state.minTemp = tempC;

        state.todayHistory.push({ time: new Date().toISOString(), temp: tempC, hum: d.outdoor.humidity.value, wind: windKmh, rain: rainRate });
        if (state.todayHistory.length > 500) state.todayHistory.shift();

        state.cachedData = {
            temp: { current: tempC, max: state.maxTemp, min: state.minTemp },
            wind: { speed: windKmh, card: getCard(d.wind.wind_direction.value) },
            atmo: { hum: d.outdoor.humidity.value, press: (d.pressure.relative.value * 33.8639).toFixed(1) },
            rain: { total: (d.rainfall.daily.value * 25.4).toFixed(1), rate: rainRate },
            history: state.todayHistory,
            lastSync: new Date().toISOString()
        };
        state.lastFetchTime = now;
        return state.cachedData;
    } catch (e) { return state.cachedData || { error: "Offline" }; }
}

// API ROUTE
app.get("/weather", async (req, res) => {
    // ESSENTIAL: Stop Vercel from caching the JSON response
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    const data = await syncWithEcowitt();
    res.json(data);
});

// UI ROUTE
app.get("/", (req, res) => {
    res.send(`<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>KK Nagar Weather Live</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root { --bg: #0b1120; --card: #1e293b; --accent: #38bdf8; }
        body { margin:0; font-family: sans-serif; background: var(--bg); color: #f1f5f9; padding: 15px; text-align: center; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; max-width: 1000px; margin: 0 auto; }
        .card { background: var(--card); padding: 20px; border-radius: 12px; border: 1px solid #334155; }
        .label { color: var(--accent); font-size: 11px; font-weight: bold; text-transform: uppercase; }
        .val { font-size: 32px; font-weight: 800; margin: 10px 0; }
        .chart-container { max-width: 1000px; margin: 20px auto; height: 250px; background: var(--card); border-radius: 12px; padding: 15px; border: 1px solid #334155; }
        #status { font-size: 12px; color: #4ade80; margin-bottom: 20px; }
    </style>
</head>
<body>
    <h2>KK Nagar Weather</h2>
    <div id="status">Linking to station...</div>
    
    <div class="grid">
        <div class="card"><div class="label">Temp</div><div id="t" class="val">--</div><small>High: <span id="mx">--</span> Low: <span id="mn">--</span></small></div>
        <div class="card"><div class="label">Wind</div><div id="w" class="val">--</div><small id="wd">--</small></div>
        <div class="card"><div class="label">Humidity</div><div id="h" class="val">--</div><small id="p">--</small></div>
        <div class="card"><div class="label">Rain Today</div><div id="r" class="val">--</div><small id="rr">--</small></div>
    </div>

    <div class="chart-container"><canvas id="mainChart"></canvas></div>

    <script>
        let chart;

        async function fetchNewData() {
            try {
                // We add ?v=... to the end to force the browser to bypass any cache
                const response = await fetch('/weather?v=' + Date.now());
                const data = await response.json();

                if(data.error) return;

                // Update text values
                document.getElementById('t').innerText = data.temp.current + '°C';
                document.getElementById('mx').innerText = data.temp.max + '°';
                document.getElementById('mn').innerText = data.temp.min + '°';
                document.getElementById('w').innerText = data.wind.speed + ' km/h';
                document.getElementById('wd').innerText = 'Direction: ' + data.wind.card;
                document.getElementById('h').innerText = data.atmo.hum + '%';
                document.getElementById('p').innerText = data.atmo.press + ' hPa';
                document.getElementById('r').innerText = data.rain.total + ' mm';
                document.getElementById('rr').innerText = 'Rate: ' + data.rain.rate + ' mm/h';
                
                const timeStr = new Date(data.lastSync).toLocaleTimeString('en-IN');
                document.getElementById('status').innerText = '🟢 AUTO-SYNC ACTIVE: ' + timeStr;

                // Update Chart
                const labels = data.history.map(h => new Date(h.time).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}));
                const temps = data.history.map(h => h.temp);

                if(!chart) {
                    const ctx = document.getElementById('mainChart').getContext('2d');
                    chart = new Chart(ctx, {
                        type: 'line',
                        data: { labels: labels, datasets: [{ label: 'Temp °C', data: temps, borderColor: '#38bdf8', tension: 0.3, pointRadius: 0 }] },
                        options: { responsive: true, maintainAspectRatio: false, scales: { x: { display: true }, y: { beginAtZero: false } } }
                    });
                } else {
                    chart.data.labels = labels;
                    chart.data.datasets[0].data = temps;
                    chart.update('none');
                }
            } catch (e) {
                document.getElementById('status').innerText = '🔴 Connection lost. Reconnecting...';
            }
        }

        // TRIGGER AUTO-REFRESH EVERY 45 SECONDS
        setInterval(fetchNewData, 45000);

        // Load immediately on page open
        fetchNewData();
    </script>
</body>
</html>`);
});

module.exports = app;
