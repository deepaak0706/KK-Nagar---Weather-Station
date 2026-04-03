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

// State management with IST Midnight Reset logic
let state = {
    cachedData: null,
    maxTemp: -999, maxTempTime: null,
    minTemp: 999, minTempTime: null,
    maxWindSpeed: 0, maxWindTime: null,
    maxGust: 0, maxGustTime: null,
    maxRainRate: 0, maxRainTime: null,
    lastFetchTime: 0, lastDbWrite: 0, 
    lastRainfall: 0, lastRainTotalTime: Date.now(),
    // en-CA gives YYYY-MM-DD which is perfect for daily comparison
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

    // --- RECOVERY & MIDNIGHT RESET ---
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
                    TO_CHAR((SELECT MIN(time_ist) FROM local_data WHERE temp_f = (SELECT MIN(temp_f) FROM local_data) LIMIT 1), 'HH24:MI:SS') as min_tf_t,
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
            } else {
                state.maxTemp = -999; state.maxTempTime = null; state.minTemp = 999; state.minTempTime = null;
                state.maxWindSpeed = 0; state.maxGust = 0; state.maxRainRate = 0;
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
        const press = parseFloat((d.pressure.relative.value * 33.8639).toFixed(1));
        const dailyRain = parseFloat((d.rainfall.daily.value * 25.4).toFixed(1));
        const solar = d.solar_and_uvi?.solar?.value || 0;
        const uvi = d.solar_and_uvi?.uvi?.value || 0;
        const realFeel = calculateRealFeel(tempC, hum);
        
        // Davis-Style Rain Rate calculation
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
        const windKmh = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));
        const gustKmh = parseFloat((d.wind.wind_gust.value * 1.60934).toFixed(1));
        if (windKmh > state.maxWindSpeed) { state.maxWindSpeed = windKmh; state.maxWindTime = currentTimeIST; }
        if (gustKmh > state.maxGust) { state.maxGust = gustKmh; state.maxGustTime = currentTimeIST; }
        if (instantRR > state.maxRainRate) { state.maxRainRate = instantRR; state.maxRainTime = currentTimeIST; }

        if (now - state.lastDbWrite > 120000) {
            await pool.query(`INSERT INTO weather_history (temp_f, humidity, wind_speed_mph, wind_gust_mph, rain_rate_in, daily_rain_in, solar_radiation, press_rel) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [d.outdoor.temperature.value, hum, d.wind.wind_speed.value, d.wind.wind_gust.value, instantRR, dailyRain, solar, press]);
            state.lastDbWrite = now;
        }

        const historyRes = await pool.query(`
            SELECT (time AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') as ist_time, 
            temp_f, humidity, wind_speed_mph, rain_rate_in, press_rel 
            FROM weather_history WHERE time > NOW() - INTERVAL '24 hours' ORDER BY time ASC
        `);
        
        const history = historyRes.rows.map(r => ({
            time: r.ist_time, 
            temp: parseFloat(((r.temp_f - 32) * 5 / 9).toFixed(1)),
            hum: r.humidity, press: r.press_rel || press,
            wind: parseFloat((r.wind_speed_mph * 1.60934).toFixed(1)),
            rain: Math.max(0, parseFloat(r.rain_rate_in || 0))
        }));

        state.cachedData = {
            temp: { current: tempC, max: state.maxTemp, maxTime: state.maxTempTime, min: state.minTemp, minTime: state.minTempTime, realFeel: realFeel },
            atmo: { hum: hum, press: press, dew: parseFloat(((d.outdoor.dew_point.value - 32) * 5 / 9).toFixed(1)) },
            wind: { speed: windKmh, gust: gustKmh, maxS: state.maxWindSpeed, maxSTime: state.maxWindTime, maxG: state.maxGust, maxGTime: state.maxGustTime, card: getCard(d.wind.wind_direction.value), deg: d.wind.wind_direction.value },
            rain: { total: dailyRain, rate: instantRR, maxR: state.maxRainRate, maxRTime: state.maxRainTime },
            solar: { rad: solar, uvi: uvi },
            lastSync: new Date().toISOString(),
            history: history
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
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Kk Nagar Weather Hub</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800;900&display=swap" rel="stylesheet">
    <style>
        :root { --bg-1: #020617; --bg-2: #0f172a; --card: rgba(15, 23, 42, 0.45); --accent: #38bdf8; --max-t: #fb7185; --min-t: #60a5fa; --wind: #fbbf24; --rain: #818cf8; --border: rgba(255, 255, 255, 0.08); }
        * { box-sizing: border-box; -webkit-font-smoothing: antialiased; }
        body { margin: 0; font-family: 'Outfit', sans-serif; background: var(--bg-1); color: #f8fafc; padding: 32px 20px; display: flex; flex-direction: column; align-items: center; min-height: 100vh; }
        .container { width: 100%; max-width: 1200px; position: relative; }
        .header { margin-bottom: 40px; display: flex; justify-content: space-between; align-items: center; }
        .live-container { display: inline-flex; align-items: center; gap: 10px; background: rgba(34, 197, 94, 0.1); padding: 8px 18px; border-radius: 100px; border: 1px solid rgba(34, 197, 94, 0.3); }
        .dot { width: 10px; height: 10px; background: #22c55e; border-radius: 50%; box-shadow: 0 0 12px #22c55e; animation: pulse 2s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        .grid-system { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 24px; margin-bottom: 24px; }
        .card, .graph-card { background: var(--card); padding: 32px; border-radius: 28px; border: 1px solid var(--border); backdrop-filter: blur(24px); box-shadow: 0 20px 40px rgba(0,0,0,0.3); }
        .label { color: #94a3b8; font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 12px; }
        .main-val { font-size: 56px; font-weight: 900; margin: 8px 0; letter-spacing: -2px; }
        .unit { font-size: 22px; color: #64748b; margin-left: 8px; }
        .sub-box-4 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding-top: 24px; border-top: 1px solid var(--border); }
        .badge { padding: 16px; border-radius: 20px; background: rgba(0,0,0,0.2); display: flex; flex-direction: column; gap: 4px; }
        .badge-label { font-size: 11px; color: #64748b; text-transform: uppercase; font-weight: 800; }
        .badge-val { font-size: 16px; font-weight: 700; color: #f1f5f9; }
        .time-mark { font-size: 10px; color: #94a3b8; background: rgba(255,255,255,0.08); padding: 2px 6px; border-radius: 6px; margin-left: 4px; }
        .compass-ui { position: absolute; top: 32px; right: 32px; width: 50px; height: 50px; border: 2px solid rgba(255,255,255,0.1); border-radius: 50%; }
        #needle { position: absolute; left: 50%; top: 50%; width: 3px; height: 25px; background: var(--max-t); transform-origin: top center; transition: 1.5s cubic-bezier(0.34, 1.56, 0.64, 1); }
        .graph-card { height: 360px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1 style="margin:0; font-size:28px; font-weight:900">Kk Nagar Weather Hub</h1>
            <div class="live-container"><div class="dot"></div><span id="ts" style="font-family:monospace; font-weight:800; color:#22c55e">--:--:--</span></div>
        </div>
        <div class="grid-system">
            <div class="card">
                <div class="label">Temperature</div>
                <div class="main-val"><span id="t">--</span><span class="unit">°C</span></div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">High</span><span id="mx" class="badge-val" style="color:var(--max-t)">--</span></div>
                    <div class="badge"><span class="badge-label">Low</span><span id="mn" class="badge-val" style="color:var(--min-t)">--</span></div>
                </div>
            </div>
            <div class="card">
                <div class="label">Wind Dynamics</div>
                <div class="compass-ui"><div id="needle"></div></div>
                <div class="main-val"><span id="w">--</span><span class="unit">km/h</span></div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Max Wind</span><span id="mw" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Max Gust</span><span id="mg" class="badge-val">--</span></div>
                </div>
            </div>
            <div class="card">
                <div class="label">Precipitation</div>
                <div class="main-val"><span id="r">--</span><span class="unit">mm</span></div>
                <div class="sub-box-4">
                    <div class="badge" style="grid-column: span 2;"><span class="badge-label">Max Intensity</span><span id="mr" class="badge-val" style="color:var(--rain)">--</span></div>
                </div>
            </div>
        </div>
        <div class="grid-system">
            <div class="graph-card"><canvas id="cT"></canvas></div>
            <div class="graph-card"><canvas id="cH"></canvas></div>
        </div>
    </div>
    <script>
        let charts = {};
        function setupChart(id, label, col) {
            return new Chart(document.getElementById(id), {
                type: 'line',
                data: { labels: [], datasets: [{ label: label, data: [], borderColor: col, tension: 0.4, pointRadius: 0, fill: true, backgroundColor: col+'11' }]},
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#64748b', font: { size: 10 } } }, y: { ticks: { color: '#64748b' } } } }
            });
        }

        async function update() {
            try {
                const res = await fetch('/weather?v=' + Date.now());
                const d = await res.json();
                document.getElementById('t').innerText = d.temp.current;
                document.getElementById('mx').innerHTML = d.temp.max + '°C<span class="time-mark">' + (d.temp.maxTime || '') + '</span>';
                document.getElementById('mn').innerHTML = d.temp.min + '°C<span class="time-mark">' + (d.temp.minTime || '') + '</span>';
                document.getElementById('w').innerText = d.wind.speed;
                document.getElementById('mw').innerHTML = d.wind.maxS + '<span class="time-mark">' + (d.wind.maxSTime || '') + '</span>';
                document.getElementById('mg').innerHTML = d.wind.maxG + '<span class="time-mark">' + (d.wind.maxGTime || '') + '</span>';
                document.getElementById('r').innerText = d.rain.total;
                document.getElementById('mr').innerText = d.rain.maxR + ' mm/h';
                document.getElementById('needle').style.transform = 'translate(-50%, -50%) rotate(' + d.wind.deg + 'deg)';
                document.getElementById('ts').innerText = new Date().toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' });

                const labels = d.history.map(h => new Date(h.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }));
                if (!charts.cT) {
                    charts.cT = setupChart('cT', 'Temp', '#38bdf8');
                    charts.cH = setupChart('cH', 'Humidity', '#10b981');
                }
                charts.cT.data.labels = labels; charts.cT.data.datasets[0].data = d.history.map(h => h.temp); charts.cT.update();
                charts.cH.data.labels = labels; charts.cH.data.datasets[0].data = d.history.map(h => h.hum); charts.cH.update();
            } catch (e) {}
        }
        setInterval(update, 35000); update();
    </script>
</body>
</html>
    `);
});

module.exports = app;

