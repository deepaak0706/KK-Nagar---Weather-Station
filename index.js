const express = require("express");
const fetch = require("node-fetch");
const app = express();

const APPLICATION_KEY = process.env.APPLICATION_KEY;
const API_KEY = process.env.API_KEY;
const MAC = process.env.MAC;

// State kept in memory (Resets if function goes idle)
let state = {
    cachedData: null,
    todayHistory: [],
    maxTemp: -999,
    minTemp: 999,
    lastFetchTime: 0
};

async function syncWithEcowitt() {
    const now = Date.now();
    // Cache for 45 seconds to stay within API limits
    if (state.cachedData && (now - state.lastFetchTime < 45000)) return state.cachedData;

    try {
        const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}`;
        const res = await fetch(url);
        const json = await res.json();
        if (json.code !== 0) throw new Error(json.msg);
        
        const d = json.data;
        const tempC = parseFloat(((d.outdoor.temperature.value - 32) * 5 / 9).toFixed(1));
        const rainRate = parseFloat((d.rainfall.rain_rate.value * 25.4).toFixed(1));
        const windKmh = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));

        if (tempC > state.maxTemp || state.maxTemp === -999) state.maxTemp = tempC;
        if (tempC < state.minTemp || state.minTemp === 999) state.minTemp = tempC;

        state.todayHistory.push({ 
            time: new Date().toISOString(), 
            temp: tempC, 
            hum: d.outdoor.humidity.value, 
            wind: windKmh, 
            rain: rainRate 
        });

        // Keep only last 24 hours (roughly 1920 entries at 45s intervals)
        if (state.todayHistory.length > 2000) state.todayHistory.shift();

        state.cachedData = {
            temp: { current: tempC, max: state.maxTemp, min: state.minTemp, feels: ((d.outdoor.feels_like.value - 32) * 5 / 9).toFixed(1) },
            wind: { speed: windKmh, deg: d.wind.wind_direction.value },
            atmo: { hum: d.outdoor.humidity.value, press: (d.pressure.relative.value * 33.8639).toFixed(1) },
            rain: { total: (d.rainfall.daily.value * 25.4).toFixed(1), rate: rainRate },
            history: state.todayHistory,
            lastSync: new Date().toISOString()
        };
        state.lastFetchTime = now;
        return state.cachedData;
    } catch (e) {
        return state.cachedData || { error: e.message };
    }
}

app.get("/weather", async (req, res) => {
    const data = await syncWithEcowitt();
    res.json(data);
});

app.get("/", (req, res) => {
    res.send(`<!DOCTYPE html>
<html>
<head>
    <title>KK Nagar Weather</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { background: #0b1120; color: white; font-family: sans-serif; padding: 20px; text-align: center; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; }
        .card { background: #1e293b; padding: 20px; border-radius: 12px; border: 1px solid #334155; }
        .val { font-size: 2.5rem; font-weight: bold; color: #38bdf8; }
        .chart-container { height: 200px; margin-top: 20px; background: #1e293b; border-radius: 12px; padding: 10px; }
    </style>
</head>
<body>
    <h1>Weather Dashboard</h1>
    <div id="status" style="margin-bottom: 20px; opacity: 0.7;">Initializing...</div>
    
    <div class="grid">
        <div class="card"><div>Temp</div><div id="t" class="val">--</div><small>Max: <span id="mx">--</span> Min: <span id="mn">--</span></small></div>
        <div class="card"><div>Humidity</div><div id="h" class="val">--</div></div>
        <div class="card"><div>Wind</div><div id="w" class="val">--</div></div>
        <div class="card"><div>Daily Rain</div><div id="r" class="val">--</div></div>
    </div>

    <div class="chart-container"><canvas id="mainChart"></canvas></div>

    <script>
        let chart;
        async function update() {
            try {
                const res = await fetch('/weather?t=' + Date.now());
                const d = await res.json();
                document.getElementById('t').innerText = d.temp.current + '°C';
                document.getElementById('mx').innerText = d.temp.max + '°C';
                document.getElementById('mn').innerText = d.temp.min + '°C';
                document.getElementById('h').innerText = d.atmo.hum + '%';
                document.getElementById('w').innerText = d.wind.speed + ' km/h';
                document.getElementById('r').innerText = d.rain.total + ' mm';
                document.getElementById('status').innerText = 'Last Updated: ' + new Date(d.lastSync).toLocaleTimeString();

                const ctx = document.getElementById('mainChart').getContext('2d');
                const labels = d.history.map(h => new Date(h.time).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}));
                const temps = d.history.map(h => h.temp);

                if(!chart) {
                    chart = new Chart(ctx, {
                        type: 'line',
                        data: { labels, datasets: [{ label: 'Temp °C', data: temps, borderColor: '#38bdf8', tension: 0.3 }] },
                        options: { responsive: true, maintainAspectRatio: false }
                    });
                } else {
                    chart.data.labels = labels;
                    chart.data.datasets[0].data = temps;
                    chart.update('none');
                }
            } catch(e) {}
        }
        setInterval(update, 45000); // 45 Second Auto Refresh
        update();
    </script>
</body>
</html>`);
});

module.exports = app;
