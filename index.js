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

// --- MIDNIGHT IST RESET & RECOVERY ---
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

    // Reset stats if new day in IST
    if (state.maxTemp === -999 || state.currentDate !== todayIST) {
        try {
            const recovery = await pool.query(`
                SELECT 
                    MAX(temp_f) as max_tf, MIN(temp_f) as min_tf,
                    MAX(wind_speed_mph) as max_ws, MAX(wind_gust_mph) as max_wg,
                    MAX(rain_rate_in) as max_rr
                FROM weather_history 
                WHERE time >= ($1::date AT TIME ZONE 'Asia/Kolkata')
            `, [todayIST]);

            if (recovery.rows[0] && recovery.rows[0].max_tf !== null) {
                const r = recovery.rows[0];
                state.maxTemp = parseFloat(((r.max_tf - 32) * 5 / 9).toFixed(1));
                state.minTemp = parseFloat(((r.min_tf - 32) * 5 / 9).toFixed(1));
                state.maxWindSpeed = parseFloat((r.max_ws * 1.60934).toFixed(1));
                state.maxGust = parseFloat((r.max_wg * 1.60934).toFixed(1));
                state.maxRainRate = parseFloat((r.max_rr || 0).toFixed(1));
            } else {
                state.maxTemp = -999; state.minTemp = 999; state.maxWindSpeed = 0; state.maxGust = 0; state.maxRainRate = 0;
            }
            state.currentDate = todayIST;
        } catch (err) { console.error("Recovery error:", err); }
    }

    if (state.cachedData && (now - state.lastFetchTime < 30000)) return state.cachedData;

    try {
        const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}`;
        const response = await fetch(url);
        const json = await response.json();
        const d = json.data;

        const tempC = parseFloat(((d.outdoor.temperature.value - 32) * 5 / 9).toFixed(1));
        const hum = d.outdoor.humidity.value;
        const windKmh = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));
        const gustKmh = parseFloat((d.wind.wind_gust.value * 1.60934).toFixed(1));
        const dailyRain = parseFloat((d.rainfall.daily.value * 25.4).toFixed(1));
        const press = parseFloat((d.pressure.relative.value * 33.8639).toFixed(1));
        const solar = d.solar_and_uvi?.solar?.value || 0;
        const uvi = d.solar_and_uvi?.uvi?.value || 0;

        // Davis Rain Rate
        let instantRR = 0;
        if (dailyRain > state.lastRainfall) {
            const timeDiffMin = (now - state.lastRainTotalTime) / 60000;
            if (timeDiffMin > 0) instantRR = parseFloat(((0.254 / timeDiffMin) * 60).toFixed(1));
            state.lastRainfall = dailyRain;
            state.lastRainTotalTime = now;
        } else if ((now - state.lastRainTotalTime) > 15 * 60000) { instantRR = 0; }

        const timeIST = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });

        if (tempC > state.maxTemp || state.maxTemp === -999) { state.maxTemp = tempC; state.maxTempTime = timeIST; }
        if (tempC < state.minTemp || state.minTemp === 999) { state.minTemp = tempC; state.minTempTime = timeIST; }
        if (windKmh > state.maxWindSpeed) { state.maxWindSpeed = windKmh; state.maxWindTime = timeIST; }
        if (gustKmh > state.maxGust) { state.maxGust = gustKmh; state.maxGustTime = timeIST; }
        if (instantRR > state.maxRainRate) { state.maxRainRate = instantRR; state.maxRainTime = timeIST; }

        if (now - state.lastDbWrite > 120000) {
            await pool.query(`INSERT INTO weather_history (temp_f, humidity, wind_speed_mph, wind_gust_mph, rain_rate_in, daily_rain_in, solar_radiation, press_rel) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, 
            [d.outdoor.temperature.value, hum, d.wind.wind_speed.value, d.wind.wind_gust.value, instantRR, dailyRain, solar, press]);
            state.lastDbWrite = now;
        }

        // FETCH 24H DATA FOR GRAPHS (Explicit IST Formatting)
        const historyRes = await pool.query(`
            SELECT TO_CHAR(time AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') as ist_label,
            temp_f, humidity, wind_speed_mph, rain_rate_in, press_rel
            FROM weather_history WHERE time > NOW() - INTERVAL '24 hours' ORDER BY time ASC
        `);

        state.cachedData = {
            temp: { current: tempC, max: state.maxTemp, maxTime: state.maxTempTime, min: state.minTemp, minTime: state.minTempTime, realFeel: calculateRealFeel(tempC, hum) },
            wind: { speed: windKmh, gust: gustKmh, deg: d.wind.wind_direction.value, card: getCard(d.wind.wind_direction.value), maxS: state.maxWindSpeed, maxSTime: state.maxWindTime, maxG: state.maxGust, maxGTime: state.maxGustTime },
            atmo: { hum: hum, press: press, dew: parseFloat(((d.outdoor.dew_point.value - 32) * 5 / 9).toFixed(1)), solar: solar, uvi: uvi },
            rain: { total: dailyRain, rate: instantRR, maxR: state.maxRainRate, maxRTime: state.maxRainTime },
            lastSync: new Date().toISOString(),
            history: historyRes.rows.map(r => ({
                time: r.ist_label,
                temp: parseFloat(((r.temp_f - 32) * 5 / 9).toFixed(1)),
                hum: r.humidity,
                wind: parseFloat((r.wind_speed_mph * 1.60934).toFixed(1)),
                rain: parseFloat(r.rain_rate_in || 0)
            }))
        };
        state.lastFetchTime = now;
        return state.cachedData;
    } catch (e) { return state.cachedData || { error: "Sync failed" }; }
}

app.get("/weather", async (req, res) => res.json(await syncWithEcowitt()));

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
        body { margin: 0; font-family: 'Outfit', sans-serif; background: var(--bg); color: #f8fafc; padding: 20px; display: flex; flex-direction: column; align-items: center; }
        .container { width: 100%; max-width: 1200px; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px; margin-bottom: 20px; }
        .card { background: var(--card); padding: 25px; border-radius: 24px; border: 1px solid var(--border); backdrop-filter: blur(20px); position: relative; }
        .label { color: #94a3b8; font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 10px; }
        .main-val { font-size: 52px; font-weight: 900; margin: 5px 0; }
        .unit { font-size: 20px; color: #64748b; }
        .sub-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 15px; }
        .badge { background: rgba(0,0,0,0.3); padding: 12px; border-radius: 16px; border: 1px solid rgba(255,255,255,0.05); }
        .badge-v { font-size: 16px; font-weight: 700; display: block; }
        .time-mark { font-size: 9px; color: #64748b; background: rgba(255,255,255,0.1); padding: 1px 4px; border-radius: 4px; margin-left: 3px; }
        .compass-wrap { position: relative; width: 100px; height: 100px; background: rgba(0,0,0,0.2); border-radius: 50%; border: 2px solid var(--border); }
        #needle { position: absolute; left: 50%; top: 50%; width: 2px; height: 40px; background: var(--max-t); transform-origin: top center; transition: 2s; }
        .graph-card { height: 320px; padding: 20px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header"><h1>Weather Hub</h1><div id="ts" style="font-weight:800; color:#22c55e">--:--</div></div>
        <div class="grid">
            <div class="card">
                <div class="label">Temperature</div>
                <div class="main-val"><span id="t">--</span><span class="unit">°C</span></div>
                <div style="color:var(--accent); font-weight:600">Feels <span id="rf">--</span>° | Dew <span id="dp">--</span>°</div>
                <div class="sub-grid">
                    <div class="badge"><span class="label" style="font-size:9px">High</span><span id="mx" class="badge-v" style="color:var(--max-t)">--</span></div>
                    <div class="badge"><span class="label" style="font-size:9px">Low</span><span id="mn" class="badge-v" style="color:var(--min-t)">--</span></div>
                </div>
            </div>
            <div class="card">
                <div style="display:flex; justify-content:space-between">
                    <div>
                        <div class="label">Wind Speed</div>
                        <div class="main-val"><span id="w">--</span><span class="unit">km/h</span></div>
                        <div id="wd" style="font-weight:700; color:var(--accent)">--° --</div>
                    </div>
                    <div class="compass-wrap"><div id="needle"></div></div>
                </div>
                <div class="sub-grid">
                    <div class="badge"><span class="label" style="font-size:9px">Max Wind</span><span id="mw" class="badge-v">--</span></div>
                    <div class="badge"><span class="label" style="font-size:9px">Max Gust</span><span id="mg" class="badge-v">--</span></div>
                </div>
            </div>
            <div class="card">
                <div class="label">Atmospheric</div>
                <div class="main-val"><span id="h">--</span><span class="unit">% Hum</span></div>
                <div style="font-weight:600; color:#10b981"><span id="pr">--</span> hPa | <span id="sol">--</span> W/m²</div>
                <div class="sub-grid">
                    <div class="badge"><span class="label" style="font-size:9px">UV Index</span><span id="uv" class="badge-v">--</span></div>
                    <div class="badge"><span class="label" style="font-size:9px">Rain Rate</span><span id="rr" class="badge-v" style="color:var(--rain)">--</span></div>
                </div>
            </div>
        </div>
        <div class="grid">
            <div class="graph-card card"><canvas id="cT"></canvas></div>
            <div class="graph-card card"><canvas id="cH"></canvas></div>
            <div class="graph-card card"><canvas id="cW"></canvas></div>
            <div class="graph-card card"><canvas id="cR"></canvas></div>
        </div>
    </div>
    <script>
        let charts = {};
        function createChart(id, label, color) {
            return new Chart(document.getElementById(id), {
                type: 'line',
                data: { labels: [], datasets: [{ label: label, data: [], borderColor: color, fill: true, tension: 0.4, pointRadius: 0, backgroundColor: color+'11' }] },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: true, labels: {color:'#fff'} } }, scales: { x: { ticks: { color: '#64748b' } }, y: { ticks: { color: '#64748b' } } } }
            });
        }
        async function update() {
            const res = await fetch('/weather?v=' + Date.now());
            const d = await res.json();
            document.getElementById('t').innerText = d.temp.current;
            document.getElementById('rf').innerText = d.temp.realFeel;
            document.getElementById('dp').innerText = d.atmo.dew;
            document.getElementById('mx').innerHTML = d.temp.max + '°<span class="time-mark">'+d.temp.maxTime+'</span>';
            document.getElementById('mn').innerHTML = d.temp.min + '°<span class="time-mark">'+d.temp.minTime+'</span>';
            document.getElementById('w').innerText = d.wind.speed;
            document.getElementById('wd').innerText = d.wind.deg + '° ' + d.wind.card;
            document.getElementById('mw').innerText = d.wind.maxS;
            document.getElementById('mg').innerText = d.wind.maxG;
            document.getElementById('needle').style.transform = 'translate(-50%, -50%) rotate('+d.wind.deg+'deg)';
            document.getElementById('h').innerText = d.atmo.hum;
            document.getElementById('pr').innerText = d.atmo.press;
            document.getElementById('sol').innerText = d.atmo.solar;
            document.getElementById('uv').innerText = d.atmo.uvi;
            document.getElementById('rr').innerText = d.rain.rate + ' mm/h';
            document.getElementById('ts').innerText = new Date().toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' });

            if (!charts.cT) {
                charts.cT = createChart('cT', 'Temp °C', '#38bdf8');
                charts.cH = createChart('cH', 'Humidity %', '#10b981');
                charts.cW = createChart('cW', 'Wind km/h', '#fbbf24');
                charts.cR = createChart('cR', 'Rain Rate mm/h', '#818cf8');
            }
            const labels = d.history.map(h => h.time);
            charts.cT.data.labels = labels; charts.cT.data.datasets[0].data = d.history.map(h => h.temp); charts.cT.update();
            charts.cH.data.labels = labels; charts.cH.data.datasets[0].data = d.history.map(h => h.hum); charts.cH.update();
            charts.cW.data.labels = labels; charts.cW.data.datasets[0].data = d.history.map(h => h.wind); charts.cW.update();
            charts.cR.data.labels = labels; charts.cR.data.datasets[0].data = d.history.map(h => h.rain); charts.cR.update();
        }
        setInterval(update, 35000); update();
    </script>
</body>
</html>
    `);
});

module.exports = app;
