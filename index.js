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

async function syncWithEcowitt() {
    const now = Date.now();
    const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

    // 1. RECOVERY: Strict IST logic for Highs/Lows
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
                    TO_CHAR((SELECT MIN(time_ist) FROM local_data WHERE temp_f = (SELECT MAX(temp_f) FROM local_data)), 'HH24:MI:SS') as max_tf_t,
                    MIN(temp_f) as min_tf,
                    TO_CHAR((SELECT MIN(time_ist) FROM local_data WHERE temp_f = (SELECT MIN(temp_f) FROM local_data)), 'HH24:MI:SS') as min_tf_t,
                    MAX(wind_speed_mph) as max_ws,
                    TO_CHAR((SELECT MIN(time_ist) FROM local_data WHERE wind_speed_mph = (SELECT MAX(wind_speed_mph) FROM local_data)), 'HH24:MI:SS') as max_ws_t,
                    MAX(wind_gust_mph) as max_wg,
                    TO_CHAR((SELECT MIN(time_ist) FROM local_data WHERE wind_gust_mph = (SELECT MAX(wind_gust_mph) FROM local_data)), 'HH24:MI:SS') as max_wg_t,
                    MAX(rain_rate_in) as max_rr,
                    TO_CHAR((SELECT MIN(time_ist) FROM local_data WHERE rain_rate_in = (SELECT MAX(rain_rate_in) FROM local_data)), 'HH24:MI:SS') as max_rr_t
                FROM local_data
            `, [todayIST]);

            if (recovery.rows[0] && recovery.rows[0].max_tf !== null) {
                const r = recovery.rows[0];
                state.maxTemp = parseFloat(((r.max_tf - 32) * 5 / 9).toFixed(1)); state.maxTempTime = r.max_tf_t;
                state.minTemp = parseFloat(((r.min_tf - 32) * 5 / 9).toFixed(1)); state.minTempTime = r.min_tf_t;
                state.maxWindSpeed = parseFloat((r.max_ws * 1.60934).toFixed(1)); state.maxWindTime = r.max_ws_t;
                state.maxGust = parseFloat((r.max_wg * 1.60934).toFixed(1)); state.maxGustTime = r.max_wg_t;
                state.maxRainRate = parseFloat((r.max_rr || 0).toFixed(1)); state.maxRainTime = r.max_rr_t;
                state.currentDate = todayIST;
            }
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
        
        // Instant Rain Rate Logic
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
            await pool.query(`INSERT INTO weather_history (temp_f, humidity, wind_speed_mph, wind_gust_mph, rain_rate_in, daily_rain_in, solar_radiation, press_rel) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [d.outdoor.temperature.value, hum, d.wind.wind_speed.value, d.wind.wind_gust.value, instantRR, dailyRain, d.solar_and_uvi?.solar?.value || 0, press]);
            state.lastDbWrite = now;
        }

        const historyRes = await pool.query(`SELECT (time AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') as ist_time, temp_f, humidity, wind_speed_mph, rain_rate_in, press_rel FROM weather_history WHERE time > NOW() - INTERVAL '24 hours' ORDER BY time ASC`);
        const history = historyRes.rows.map(r => ({
            time: r.ist_time, 
            temp: parseFloat(((r.temp_f - 32) * 5 / 9).toFixed(1)),
            hum: r.humidity, press: r.press_rel || press,
            wind: parseFloat((r.wind_speed_mph * 1.60934).toFixed(1)),
            rain: Math.max(0, parseFloat(r.rain_rate_in || 0))
        }));

        state.cachedData = {
            temp: { current: tempC, max: state.maxTemp, maxTime: state.maxTempTime, min: state.minTemp, minTime: state.minTempTime },
            atmo: { hum: hum, press: press, dew: parseFloat(((d.outdoor.dew_point.value - 32) * 5 / 9).toFixed(1)) },
            wind: { speed: windKmh, gust: gustKmh, maxS: state.maxWindSpeed, maxSTime: state.maxWindTime, maxG: state.maxGust, maxGTime: state.maxGustTime, card: getCard(d.wind.wind_direction.value), deg: d.wind.wind_direction.value },
            rain: { total: dailyRain, rate: instantRR, maxR: state.maxRainRate, maxRTime: state.maxRainTime },
            solar: { rad: d.solar_and_uvi?.solar?.value || 0, uvi: d.solar_and_uvi?.uvi?.value || 0 },
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
        :root { --bg-1: #020617; --card: rgba(15, 23, 42, 0.7); --accent: #38bdf8; --max-t: #fb7185; --min-t: #60a5fa; --wind: #fbbf24; --rain: #818cf8; --border: rgba(255, 255, 255, 0.1); }
        body { margin: 0; font-family: 'Outfit', sans-serif; background: var(--bg-1); color: #f8fafc; padding: 15px; display: flex; flex-direction: column; align-items: center; min-height: 100vh; }
        .container { width: 100%; max-width: 1200px; }
        .header { margin-bottom: 25px; display: flex; justify-content: space-between; align-items: center; }
        .live-container { display: inline-flex; align-items: center; gap: 8px; background: rgba(34, 197, 94, 0.1); padding: 8px 16px; border-radius: 100px; border: 1px solid rgba(34, 197, 94, 0.3); }
        .dot { width: 8px; height: 8px; background: #22c55e; border-radius: 50%; }
        .grid-system { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 15px; margin-bottom: 15px; }
        .card { background: var(--card); padding: 25px; border-radius: 28px; border: 1px solid var(--border); backdrop-filter: blur(20px); position: relative; }
        .label { color: #94a3b8; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 1.2px; margin-bottom: 10px; display: block; }
        .main-val { font-size: 48px; font-weight: 900; margin: 10px 0; }
        .unit { font-size: 18px; color: #64748b; margin-left: 4px; }
        .sub-box-4 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding-top: 15px; border-top: 1px solid rgba(255, 255, 255, 0.08); }
        .badge { padding: 12px; border-radius: 16px; background: rgba(0, 0, 0, 0.2); border: 1px solid rgba(255,255,255,0.05); }
        .badge-t { font-size: 10px; color: #64748b; font-weight: 700; margin-bottom: 4px; display: block; }
        .badge-v { font-size: 14px; font-weight: 700; display: flex; align-items: center; justify-content: space-between; }
        .time-mark { font-size: 9px; color: #94a3b8; background: rgba(255,255,255,0.1); padding: 2px 4px; border-radius: 4px; font-family: monospace; }
        .graph-card { height: 280px; background: var(--card); border-radius: 28px; padding: 20px; border: 1px solid var(--border); }
        .compass { position: absolute; top: 25px; right: 25px; width: 40px; height: 40px; border: 1px solid rgba(255,255,255,0.1); border-radius: 50%; }
        #needle { position: absolute; left: 50%; top: 50%; width: 2px; height: 20px; background: var(--max-t); transform-origin: top center; transition: 1s; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1 style="margin:0; font-size:22px; font-weight:900">Kk Nagar Weather Hub</h1>
            <div class="live-container"><div class="dot"></div><span id="ts" style="font-family:monospace; font-weight:700">--:--:--</span></div>
        </div>
        <div class="grid-system">
            <div class="card">
                <span class="label">Temperature & Humidity</span>
                <div class="main-val"><span id="t">--</span><span class="unit">°C</span></div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-t">HIGH</span><div class="badge-v" style="color:var(--max-t)"><span id="mx">--</span><span id="mxt" class="time-mark"></span></div></div>
                    <div class="badge"><span class="badge-t">LOW</span><div class="badge-v" style="color:var(--min-t)"><span id="mn">--</span><span id="mnt" class="time-mark"></span></div></div>
                    <div class="badge"><span class="badge-t">HUMIDITY</span><div class="badge-v"><span id="h">--</span>%</div></div>
                    <div class="badge"><span class="badge-t">DEW POINT</span><div class="badge-v"><span id="dp">--</span>°C</div></div>
                </div>
            </div>
            <div class="card">
                <span class="label">Wind Dynamics</span>
                <div class="compass"><div id="needle"></div></div>
                <div class="main-val"><span id="w">--</span><span class="unit">km/h</span></div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-t">PEAK WIND</span><div class="badge-v"><span id="mw">--</span><span id="mwt" class="time-mark"></span></div></div>
                    <div class="badge"><span class="badge-t">GUST</span><div class="badge-v"><span id="mg">--</span><span id="mgt" class="time-mark"></span></div></div>
                </div>
            </div>
            <div class="card">
                <span class="label">Atmospheric & Solar</span>
                <div class="main-val"><span id="pr">--</span><span class="unit">hPa</span></div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-t">SOLAR</span><div class="badge-v"><span id="sol">--</span><span class="unit" style="font-size:9px">W/m²</span></div></div>
                    <div class="badge"><span class="badge-t">UV INDEX</span><div class="badge-v" id="uv">--</div></div>
                </div>
            </div>
            <div class="card">
                <span class="label">Rainfall</span>
                <div class="main-val"><span id="r">--</span><span class="unit">mm</span></div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-t">RATE</span><div class="badge-v"><span id="rr">--</span><span class="unit" style="font-size:9px">mm/h</span></div></div>
                    <div class="badge"><span class="badge-t">MAX RATE</span><div class="badge-v"><span id="mr">--</span><span id="mrt" class="time-mark"></span></div></div>
                </div>
            </div>
        </div>
        <div class="grid-system">
            <div class="graph-card"><canvas id="cT"></canvas></div>
            <div class="graph-card"><canvas id="cH"></canvas></div>
            <div class="graph-card"><canvas id="cW"></canvas></div>
            <div class="graph-card"><canvas id="cR"></canvas></div>
        </div>
    </div>
    <script>
        let charts = {};
        function createChart(id, label, color, minV = null) {
            return new Chart(document.getElementById(id), {
                type: 'line',
                data: { labels: [], datasets: [{ data: [], borderColor: color, fill: true, tension: 0.4, pointRadius: 0, borderWidth: 2, backgroundColor: color+'10' }] },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    scales: {
                        x: { ticks: { color: '#64748b', font: { size: 9 }, maxRotation: 0 } },
                        y: { min: minV, ticks: { color: '#64748b', font: { size: 9 } }, grid: { color: 'rgba(255,255,255,0.05)' } }
                    },
                    plugins: { legend: { display: false } }
                }
            });
        }

        async function update() {
            try {
                const d = await (await fetch('/weather?v=' + Date.now())).json();
                document.getElementById('t').innerText = d.temp.current;
                document.getElementById('mx').innerText = d.temp.max;
                document.getElementById('mxt').innerText = d.temp.maxTime || '';
                document.getElementById('mn').innerText = d.temp.min;
                document.getElementById('mnt').innerText = d.temp.minTime || '';
                document.getElementById('h').innerText = d.atmo.hum;
                document.getElementById('dp').innerText = d.atmo.dew;
                document.getElementById('pr').innerText = d.atmo.press;
                document.getElementById('w').innerText = d.wind.speed;
                document.getElementById('mw').innerText = d.wind.maxS;
                document.getElementById('mwt').innerText = d.wind.maxSTime || '';
                document.getElementById('mg').innerText = d.wind.gust;
                document.getElementById('mgt').innerText = d.wind.maxGTime || '';
                document.getElementById('sol').innerText = d.solar.rad;
                document.getElementById('uv').innerText = d.solar.uvi;
                document.getElementById('r').innerText = d.rain.total;
                document.getElementById('rr').innerText = d.rain.rate;
                document.getElementById('mr').innerText = d.rain.maxR;
                document.getElementById('mrt').innerText = d.rain.maxRTime || '';
                document.getElementById('needle').style.transform = 'translate(-50%, -50%) rotate('+d.wind.deg+'deg)';
                document.getElementById('ts').innerText = new Date().toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' });

                const labels = d.history.map(h => new Date(h.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }));
                if (!charts.cT) {
                    charts.cT = createChart('cT', 'Temp', '#38bdf8');
                    charts.cH = createChart('cH', 'Humidity', '#10b981', 0);
                    charts.cW = createChart('cW', 'Wind', '#fbbf24', 0);
                    charts.cR = createChart('cR', 'Rain', '#818cf8', 0);
                }
                charts.cT.data.labels = labels; charts.cT.data.datasets[0].data = d.history.map(h => h.temp); charts.cT.update();
                charts.cH.data.labels = labels; charts.cH.data.datasets[0].data = d.history.map(h => h.hum); charts.cH.update();
                charts.cW.data.labels = labels; charts.cW.data.datasets[0].data = d.history.map(h => h.wind); charts.cW.update();
                charts.cR.data.labels = labels; charts.cR.data.datasets[0].data = d.history.map(h => h.rain); charts.cR.update();
            } catch (e) { console.error(e); }
        }
        setInterval(update, 45000); update();
    </script>
</body>
</html>
    `);
});

module.exports = app;
