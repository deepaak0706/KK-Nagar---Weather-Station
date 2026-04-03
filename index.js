const express = require("express");
const fetch = require("node-fetch");
const { Pool } = require('pg'); 
const app = express();

const pool = new Pool({
    connectionString: process.env.POSTGRES_URL + "?sslmode=require",
});

const APPLICATION_KEY = process.env.APPLICATION_KEY;
const API_KEY = process.env.API_KEY;
const MAC = process.env.MAC;

// --- CRITICAL: MIDNIGHT IST RESET & RECOVERY STATE ---
let state = {
    cachedData: null,
    maxTemp: -999, maxTempTime: null,
    minTemp: 999, minTempTime: null,
    maxWindSpeed: 0, maxWindTime: null,
    maxGust: 0, maxGustTime: null,
    maxRainRate: 0, maxRainTime: null,
    lastFetchTime: 0, lastDbWrite: 0, 
    lastRainfall: 0, lastRainTotalTime: Date.now(),
    currentDate: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
};

const getCard = (a) => {
    const directions = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
    return directions[Math.round(a / 22.5) % 16];
};

function calculateRealFeel(tempC, humidity) {
    const T = (tempC * 9/5) + 32;
    const R = humidity;
    let hi = 0.5 * (T + 61.0 + ((T - 68.0) * 1.2) + (R * 0.094));
    if (hi > 79) {
        hi = -42.379 + 2.04901523 * T + 10.14333127 * R - 0.22475541 * T * R - 0.00683783 * T * T - 0.05481717 * R * R + 0.00122874 * T * T * R + 0.00085282 * T * R * R - 0.00000199 * T * T * R * R;
    }
    return parseFloat(((hi - 32) * 5 / 9).toFixed(1));
}

async function syncWithEcowitt() {
    const now = Date.now();
    const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

    // Midnight Reset & DB Recovery
    if (state.maxTemp === -999 || state.currentDate !== todayIST) {
        try {
            const recovery = await pool.query(`
                WITH local_data AS (
                    SELECT *, (time AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') as time_ist
                    FROM weather_history 
                    WHERE time >= ($1::date AT TIME ZONE 'Asia/Kolkata')
                )
                SELECT 
                    MAX(temp_f) as max_tf,
                    TO_CHAR((SELECT MIN(time_ist) FROM local_data WHERE temp_f = (SELECT MAX(temp_f) FROM local_data) LIMIT 1), 'HH24:MI:SS') as max_tf_t,
                    MIN(temp_f) as min_tf,
                    TO_CHAR((SELECT MIN(time_ist) FROM local_data WHERE temp_f = (SELECT MIN(time_ist) FROM local_data) LIMIT 1), 'HH24:MI:SS') as min_tf_t,
                    MAX(wind_speed_mph) as max_ws,
                    TO_CHAR((SELECT MIN(time_ist) FROM local_data WHERE wind_speed_mph = (SELECT MAX(wind_speed_mph) FROM local_data) LIMIT 1), 'HH24:MI:SS') as max_ws_t,
                    MAX(wind_gust_mph) as max_wg,
                    TO_CHAR((SELECT MIN(time_ist) FROM local_data WHERE wind_gust_mph = (SELECT MAX(wind_gust_mph) FROM local_data) LIMIT 1), 'HH24:MI:SS') as max_wg_t,
                    MAX(rain_rate_in) as max_rr,
                    TO_CHAR((SELECT MIN(time_ist) FROM local_data WHERE rain_rate_in = (SELECT MAX(rain_rate_in) FROM local_data) LIMIT 1), 'HH24:MI:SS') as max_rr_t
                FROM local_data
            `, [todayIST]);

            if (recovery.rows[0] && recovery.rows[0].max_tf !== null) {
                const r = recovery.rows[0];
                state.maxTemp = parseFloat(((r.max_tf - 32) * 5 / 9).toFixed(1)); state.maxTempTime = r.max_tf_t;
                state.minTemp = parseFloat(((r.min_tf - 32) * 5 / 9).toFixed(1)); state.minTempTime = r.min_tf_t;
                state.maxWindSpeed = parseFloat((r.max_ws * 1.60934).toFixed(1)); state.maxWindTime = r.max_ws_t;
                state.maxGust = parseFloat((r.max_wg * 1.60934).toFixed(1)); state.maxGustTime = r.max_wg_t;
                state.maxRainRate = parseFloat((r.max_rr || 0).toFixed(1)); state.maxRainTime = r.max_rr_t;
            }
            state.currentDate = todayIST;
        } catch (err) { console.error("Recovery error:", err); }
    }

    if (state.cachedData && (now - state.lastFetchTime < 35000)) return state.cachedData;

    try {
        const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}`;
        const response = await fetch(url);
        const json = await response.json();
        const d = json.data;

        const tempC = parseFloat(((d.outdoor.temperature.value - 32) * 5 / 9).toFixed(1));
        const hum = d.outdoor.humidity.value;
        const windKmh = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));
        const gustKmh = parseFloat((d.wind.wind_gust.value * 1.60934).toFixed(1));
        const windDeg = d.wind.wind_direction.value;
        const dailyRain = parseFloat((d.rainfall.daily.value * 25.4).toFixed(1));
        const press = parseFloat((d.pressure.relative.value * 33.8639).toFixed(1));
        
        // Davis Rain Rate
        let instantRR = 0;
        if (dailyRain > state.lastRainfall) {
            const timeDiffMin = (now - state.lastRainTotalTime) / 60000;
            if (timeDiffMin > 0) instantRR = parseFloat(((0.254 / timeDiffMin) * 60).toFixed(1));
            state.lastRainfall = dailyRain;
            state.lastRainTotalTime = now;
        } else if ((now - state.lastRainTotalTime) > 15 * 60000) { instantRR = 0; }

        const currentTimeIST = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });

        if (tempC > state.maxTemp || state.maxTemp === -999) { state.maxTemp = tempC; state.maxTempTime = currentTimeIST; }
        if (tempC < state.minTemp || state.minTemp === 999) { state.minTemp = tempC; state.minTempTime = currentTimeIST; }
        if (windKmh > state.maxWindSpeed) { state.maxWindSpeed = windKmh; state.maxWindTime = currentTimeIST; }
        if (gustKmh > state.maxGust) { state.maxGust = gustKmh; state.maxGustTime = currentTimeIST; }
        if (instantRR > state.maxRainRate) { state.maxRainRate = instantRR; state.maxRainTime = currentTimeIST; }

        if (now - state.lastDbWrite > 120000) {
            await pool.query(`INSERT INTO weather_history (temp_f, humidity, wind_speed_mph, wind_gust_mph, rain_rate_in, daily_rain_in, press_rel) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [d.outdoor.temperature.value, hum, d.wind.wind_speed.value, d.wind.wind_gust.value, instantRR, dailyRain, press]);
            state.lastDbWrite = now;
        }

        const historyRes = await pool.query(`SELECT (time AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') as ist_time, temp_f, humidity, wind_speed_mph, rain_rate_in FROM weather_history WHERE time > NOW() - INTERVAL '24 hours' ORDER BY time ASC`);
        
        state.cachedData = {
            temp: { current: tempC, max: state.maxTemp, maxTime: state.maxTempTime, min: state.minTemp, minTime: state.minTempTime, realFeel: calculateRealFeel(tempC, hum) },
            wind: { speed: windKmh, gust: gustKmh, deg: windDeg, card: getCard(windDeg), maxS: state.maxWindSpeed, maxSTime: state.maxWindTime, maxG: state.maxGust, maxGTime: state.maxGustTime },
            rain: { total: dailyRain, rate: instantRR, maxR: state.maxRainRate, maxRTime: state.maxRainTime },
            hum: hum, press: press,
            lastSync: new Date().toISOString(),
            history: historyRes.rows.map(r => ({
                time: r.ist_time, 
                temp: parseFloat(((r.temp_f - 32) * 5 / 9).toFixed(1)),
                wind: parseFloat((r.wind_speed_mph * 1.60934).toFixed(1)),
                rain: Math.max(0, parseFloat(r.rain_rate_in || 0))
            }))
        };
        state.lastFetchTime = now;
        return state.cachedData;
    } catch (e) { return state.cachedData || { error: "Sync failed" }; }
}

app.get("/weather", async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await syncWithEcowitt());
});

app.get("/", (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Kk Nagar Weather Hub</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800;900&display=swap" rel="stylesheet">
    <style>
        :root { --bg: #020617; --card: rgba(15, 23, 42, 0.6); --accent: #38bdf8; --max-t: #fb7185; --min-t: #60a5fa; --border: rgba(255, 255, 255, 0.1); }
        body { margin: 0; font-family: 'Outfit', sans-serif; background: var(--bg); color: #f8fafc; padding: 25px; display: flex; flex-direction: column; align-items: center; }
        .container { width: 100%; max-width: 1200px; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 25px; margin-bottom: 25px; }
        .card { background: var(--card); padding: 30px; border-radius: 32px; border: 1px solid var(--border); backdrop-filter: blur(20px); position: relative; overflow: hidden; }
        .label { color: #94a3b8; font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 2px; }
        .main-val { font-size: 60px; font-weight: 900; margin: 10px 0; }
        .unit { font-size: 24px; color: #64748b; margin-left: 5px; }
        
        /* Modernized Compass UI */
        .wind-box { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
        .compass-wrap { position: relative; width: 120px; height: 120px; border: 2px solid rgba(255,255,255,0.05); border-radius: 50%; background: rgba(0,0,0,0.2); }
        .compass-cardinal { position: absolute; width: 100%; height: 100%; font-size: 10px; font-weight: 900; color: #475569; padding: 5px; box-sizing: border-box; }
        .card-n { position: absolute; top: 2px; left: 50%; transform: translateX(-50%); color: var(--max-t); }
        .card-s { position: absolute; bottom: 2px; left: 50%; transform: translateX(-50%); }
        .card-e { position: absolute; right: 2px; top: 50%; transform: translateY(-50%); }
        .card-w { position: absolute; left: 2px; top: 50%; transform: translateY(-50%); }
        .needle-box { position: absolute; top: 0; left: 0; width: 100%; height: 100%; transition: transform 2s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
        .needle { position: absolute; top: 15%; left: 50%; transform: translateX(-50%); width: 0; height: 0; border-left: 8px solid transparent; border-right: 8px solid transparent; border-bottom: 45px solid var(--accent); filter: drop-shadow(0 0 8px var(--accent)); }
        .needle::after { content: ''; position: absolute; top: 45px; left: -8px; width: 0; height: 0; border-left: 8px solid transparent; border-right: 8px solid transparent; border-top: 20px solid rgba(255,255,255,0.2); }

        .sub-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-top: 20px; }
        .badge { background: rgba(0,0,0,0.3); padding: 15px; border-radius: 20px; border: 1px solid rgba(255,255,255,0.05); }
        .badge-v { font-size: 18px; font-weight: 700; display: block; margin-top: 5px; }
        .time-mark { font-size: 10px; color: #64748b; background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 5px; margin-left: 5px; }
        .graph-card { height: 350px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1 style="margin:0; font-weight:900">Weather Hub</h1>
            <div style="background:rgba(34,197,94,0.1); padding:8px 20px; border-radius:100px; color:#22c55e; font-weight:800; border:1px solid #22c55e44">
                LIVE <span id="ts" style="margin-left:10px; color:#f8fafc; font-family:monospace">--:--:--</span>
            </div>
        </div>
        <div class="grid">
            <div class="card">
                <span class="label">Temperature</span>
                <div class="main-val"><span id="t">--</span><span class="unit">°C</span></div>
                <div style="color:var(--accent); font-weight:600">Feels like <span id="rf">--</span>°C</div>
                <div class="sub-grid">
                    <div class="badge"><span class="label" style="font-size:10px">High</span><span id="mx" class="badge-v" style="color:var(--max-t)">--</span></div>
                    <div class="badge"><span class="label" style="font-size:10px">Low</span><span id="mn" class="badge-v" style="color:var(--min-t)">--</span></div>
                </div>
            </div>
            <div class="card">
                <div class="wind-box">
                    <div>
                        <span class="label">Wind Speed</span>
                        <div class="main-val"><span id="w">--</span><span class="unit">km/h</span></div>
                        <div id="wd" style="font-weight:800; color:var(--accent); font-size:18px">--° --</div>
                    </div>
                    <div class="compass-wrap">
                        <div class="compass-cardinal"><span class="card-n">N</span><span class="card-e">E</span><span class="card-s">S</span><span class="card-w">W</span></div>
                        <div class="needle-box" id="needle"><div class="needle"></div></div>
                    </div>
                </div>
                <div class="sub-grid">
                    <div class="badge"><span class="label" style="font-size:10px">Max Wind</span><span id="mw" class="badge-v">--</span></div>
                    <div class="badge"><span class="label" style="font-size:10px">Peak Gust</span><span id="mg" class="badge-v">--</span></div>
                </div>
            </div>
        </div>
        <div class="grid">
            <div class="graph-card card"><canvas id="cT"></canvas></div>
            <div class="graph-card card"><canvas id="cR"></canvas></div>
        </div>
    </div>
    <script>
        let charts = {};
        function createChart(id, label, color) {
            return new Chart(document.getElementById(id), {
                type: 'line',
                data: { labels: [], datasets: [{ label: label, data: [], borderColor: color, fill: true, tension: 0.4, pointRadius: 0, backgroundColor: color+'11' }] },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#64748b' } }, y: { ticks: { color: '#64748b' } } } }
            });
        }

        async function update() {
            try {
                const res = await fetch('/weather?v=' + Date.now());
                const d = await res.json();
                document.getElementById('t').innerText = d.temp.current;
                document.getElementById('rf').innerText = d.temp.realFeel;
                document.getElementById('mx').innerHTML = d.temp.max + '°<span class="time-mark">'+d.temp.maxTime+'</span>';
                document.getElementById('mn').innerHTML = d.temp.min + '°<span class="time-mark">'+d.temp.minTime+'</span>';
                
                document.getElementById('w').innerText = d.wind.speed;
                document.getElementById('wd').innerText = d.wind.deg + '° ' + d.wind.card;
                document.getElementById('mw').innerHTML = d.wind.maxS + '<span class="time-mark">'+d.wind.maxSTime+'</span>';
                document.getElementById('mg').innerHTML = d.wind.maxG + '<span class="time-mark">'+d.wind.maxGTime+'</span>';
                document.getElementById('needle').style.transform = 'rotate('+d.wind.deg+'deg)';
                
                document.getElementById('ts').innerText = new Date().toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' });

                const labels = d.history.map(h => new Date(h.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }));
                if (!charts.cT) {
                    charts.cT = createChart('cT', 'Temp', '#38bdf8');
                    charts.cR = createChart('cR', 'Rain Rate', '#818cf8');
                }
                charts.cT.data.labels = labels; charts.cT.data.datasets[0].data = d.history.map(h => h.temp); charts.cT.update();
                charts.cR.data.labels = labels; charts.cR.data.datasets[0].data = d.history.map(h => h.rain); charts.cR.update();
            } catch (e) {}
        }
        setInterval(update, 35000); update();
    </script>
</body>
</html>
    `);
});

module.exports = app;
