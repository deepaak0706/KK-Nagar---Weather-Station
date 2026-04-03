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
    currentDate: new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })
};

const getCard = (a) => {
    const directions = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
    return directions[Math.round(a / 22.5) % 16];
};

async function syncWithEcowitt() {
    const now = Date.now();
    const today = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });

    // --- RECOVERY & INITIALIZATION ---
    if (state.maxTemp === -999 || state.currentDate !== today) {
        try {
            const recovery = await pool.query(`
                SELECT 
                    MAX(temp_f) as max_tf, TO_CHAR(MAX(time) FILTER (WHERE temp_f = (SELECT MAX(temp_f) FROM weather_history WHERE time >= CURRENT_DATE)), 'HH24:MI:SS') as max_tf_t,
                    MIN(temp_f) as min_tf, TO_CHAR(MAX(time) FILTER (WHERE temp_f = (SELECT MIN(temp_f) FROM weather_history WHERE time >= CURRENT_DATE)), 'HH24:MI:SS') as min_tf_t,
                    MAX(wind_speed_mph) as max_ws, TO_CHAR(MAX(time) FILTER (WHERE wind_speed_mph = (SELECT MAX(wind_speed_mph) FROM weather_history WHERE time >= CURRENT_DATE)), 'HH24:MI:SS') as max_ws_t,
                    MAX(wind_gust_mph) as max_wg, TO_CHAR(MAX(time) FILTER (WHERE wind_gust_mph = (SELECT MAX(wind_gust_mph) FROM weather_history WHERE time >= CURRENT_DATE)), 'HH24:MI:SS') as max_wg_t,
                    MAX(rain_rate_in) as max_rr, TO_CHAR(MAX(time) FILTER (WHERE rain_rate_in = (SELECT MAX(rain_rate_in) FROM weather_history WHERE time >= CURRENT_DATE)), 'HH24:MI:SS') as max_rr_t
                FROM weather_history 
                WHERE time >= CURRENT_DATE AT TIME ZONE 'Asia/Kolkata'
            `);
            if (recovery.rows[0] && recovery.rows[0].max_tf !== null) {
                const r = recovery.rows[0];
                state.maxTemp = parseFloat(((r.max_tf - 32) * 5 / 9).toFixed(1)); state.maxTempTime = r.max_tf_t;
                state.minTemp = parseFloat(((r.min_tf - 32) * 5 / 9).toFixed(1)); state.minTempTime = r.min_tf_t;
                state.maxWindSpeed = parseFloat((r.max_ws * 1.60934).toFixed(1)); state.maxWindTime = r.max_ws_t;
                state.maxGust = parseFloat((r.max_wg * 1.60934).toFixed(1)); state.maxGustTime = r.max_wg_t;
                state.maxRainRate = parseFloat((r.max_rr || 0).toFixed(1)); state.maxRainTime = r.max_rr_t;
                state.currentDate = today;
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
        
        let instantRR = 0;
        if (dailyRain > state.lastRainfall) {
            const timeDiffMin = (now - state.lastRainTotalTime) / 60000;
            if (timeDiffMin > 0) instantRR = parseFloat(((0.254 / timeDiffMin) * 60).toFixed(1));
            state.lastRainfall = dailyRain;
            state.lastRainTotalTime = now;
        } else if ((now - state.lastRainTotalTime) > 15 * 60000) { instantRR = 0; }

        const currentTimeStr = new Date(now).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });

        // Update Highs and capture Timestamps
        if (tempC > state.maxTemp || state.maxTemp === -999) { state.maxTemp = tempC; state.maxTempTime = currentTimeStr; }
        if (tempC < state.minTemp || state.minTemp === 999) { state.minTemp = tempC; state.minTempTime = currentTimeStr; }
        const windKmh = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));
        const gustKmh = parseFloat((d.wind.wind_gust.value * 1.60934).toFixed(1));
        if (windKmh > state.maxWindSpeed) { state.maxWindSpeed = windKmh; state.maxWindTime = currentTimeStr; }
        if (gustKmh > state.maxGust) { state.maxGust = gustKmh; state.maxGustTime = currentTimeStr; }
        if (instantRR > state.maxRainRate) { state.maxRainRate = instantRR; state.maxRainTime = currentTimeStr; }

        if (now - state.lastDbWrite > 120000) {
            await pool.query(`INSERT INTO weather_history (temp_f, humidity, wind_speed_mph, wind_gust_mph, rain_rate_in, daily_rain_in, solar_radiation, press_rel) 
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, 
                        [d.outdoor.temperature.value, hum, d.wind.wind_speed.value, d.wind.wind_gust.value, instantRR, dailyRain, d.solar_and_uvi?.solar?.value || 0, press]);
            state.lastDbWrite = now;
        }

        const historyRes = await pool.query(`SELECT time, temp_f, humidity as hum, wind_speed_mph as wind, rain_rate_in as rain, press_rel as press 
                                             FROM weather_history WHERE time > NOW() - INTERVAL '24 hours' ORDER BY time ASC`);
        const history = historyRes.rows.map(r => ({
            time: r.time,
            temp: parseFloat(((r.temp_f - 32) * 5 / 9).toFixed(1)),
            hum: r.hum, press: r.press || press,
            wind: parseFloat((r.wind * 1.60934).toFixed(1)),
            rain: r.rain
        }));

        let tTrend = 0, hTrend = 0, pTrend = 0;
        if (history.length >= 2) {
            const first = history[0];
            const timeDiffHrs = (now - new Date(first.time).getTime()) / 3600000;
            if (timeDiffHrs > 0.05) {
                tTrend = parseFloat(((tempC - first.temp) / timeDiffHrs).toFixed(1));
                hTrend = parseFloat(((hum - first.hum) / timeDiffHrs).toFixed(1));
                pTrend = parseFloat(((press - first.press) / timeDiffHrs).toFixed(1));
            }
        }

        state.cachedData = {
            temp: { current: tempC, max: state.maxTemp, maxTime: state.maxTempTime, min: state.minTemp, minTime: state.minTempTime, trend: tTrend },
            atmo: { hum: hum, hTrend: hTrend, press: press, pTrend: pTrend, dew: parseFloat(((d.outdoor.dew_point.value - 32) * 5 / 9).toFixed(1)) },
            wind: { speed: windKmh, gust: gustKmh, maxS: state.maxWindSpeed, maxSTime: state.maxWindTime, maxG: state.maxGust, maxGTime: state.maxGustTime, card: getCard(d.wind.wind_direction.value), deg: d.wind.wind_direction.value },
            rain: { total: dailyRain, rate: instantRR, maxR: state.maxRainRate, maxRTime: state.maxRainTime },
            solar: { rad: d.solar_and_uvi?.solar?.value || 0, uvi: d.solar_and_uvi?.uvi?.value || 0 },
            lastSync: d.time || new Date().toISOString(),
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
        body { margin: 0; font-family: 'Outfit', sans-serif; background: var(--bg-1); color: #f8fafc; padding: 24px; display: flex; flex-direction: column; align-items: center; min-height: 100vh; }
        .container { width: 100%; max-width: 1200px; }
        .header { margin-bottom: 32px; display: flex; justify-content: space-between; align-items: center; }
        .live-container { display: inline-flex; align-items: center; gap: 8px; background: rgba(34, 197, 94, 0.1); padding: 6px 14px; border-radius: 100px; border: 1px solid rgba(34, 197, 94, 0.3); }
        .dot { width: 8px; height: 8px; background: #22c55e; border-radius: 50%; }
        .grid-system { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-bottom: 20px; }
        .card { background: var(--card); padding: 24px; border-radius: 24px; border: 1px solid var(--border); backdrop-filter: blur(20px); position: relative; }
        .label { color: #94a3b8; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 1.5px; }
        .main-val { font-size: 48px; font-weight: 900; margin: 8px 0; display: flex; align-items: baseline; }
        .unit { font-size: 18px; color: #64748b; margin-left: 6px; }
        .trend-badge { font-size: 12px; font-weight: 800; margin-bottom: 20px; display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; background: rgba(255,255,255,0.06); border-radius: 8px; }
        .sub-box-4 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding-top: 16px; border-top: 1px solid rgba(255, 255, 255, 0.08); }
        .badge { padding: 12px; border-radius: 16px; background: rgba(0, 0, 0, 0.2); }
        .badge-label { font-size: 10px; color: #64748b; text-transform: uppercase; font-weight: 800; display: block; margin-bottom: 4px; }
        .badge-val { font-size: 14px; font-weight: 700; color: #f1f5f9; display: flex; flex-wrap: wrap; align-items: center; }
        .time-mark { font-size: 9px; font-weight: 800; color: #64748b; background: rgba(255,255,255,0.05); padding: 2px 5px; border-radius: 4px; margin-left: 4px; }
        .compass-ui { position: absolute; top: 24px; right: 24px; width: 50px; height: 50px; border: 2px solid rgba(255,255,255,0.1); border-radius: 50%; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.4); }
        #needle { width: 3px; height: 30px; background: linear-gradient(to bottom, var(--max-t) 50%, #eee 50%); clip-path: polygon(50% 0%, 100% 100%, 50% 85%, 0% 100%); transition: transform 1.5s ease-out; }
        .graph-card { height: 300px; background: var(--card); border-radius: 24px; padding: 20px; border: 1px solid var(--border); }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h2 style="margin:0">Kk Nagar Weather Hub</h2>
            <div class="live-container"><div class="dot"></div><span id="ts" style="font-family:monospace; font-size:12px">--:--:--</span></div>
        </div>
        <div class="grid-system">
            <div class="card">
                <div class="label">Temperature</div>
                <div class="main-val"><span id="t">--</span><span class="unit">°C</span></div>
                <div id="tr" class="trend-badge">--</div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Today High</span><span id="mx" class="badge-val" style="color:var(--max-t)">--</span></div>
                    <div class="badge"><span class="badge-label">Today Low</span><span id="mn" class="badge-val" style="color:var(--min-t)">--</span></div>
                    <div class="badge"><span class="badge-label">Humidity <span id="h_tr"></span></span><span id="h" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Dew Point</span><span id="dp" class="badge-val">--</span></div>
                </div>
            </div>
            <div class="card">
                <div class="label">Wind Dynamics</div>
                <div class="compass-ui"><div id="needle"></div></div>
                <div class="main-val"><span id="w">--</span><span class="unit">km/h</span></div>
                <div id="wg" class="minor-line" style="color:var(--wind); font-size:13px; font-weight:700; margin-bottom:15px">--</div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Max wind</span><span id="mw" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Max Gust</span><span id="mg" class="badge-val">--</span></div>
                </div>
            </div>
            <div class="card">
                <div class="label">Atmospheric <span id="p_tr"></span></div>
                <div class="main-val"><span id="pr">--</span><span class="unit">hPa</span></div>
                <div id="p_status" class="minor-line" style="color:#64748b; font-size:13px; margin-bottom:15px">--</div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Solar Rad</span><span id="sol" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">UV Index</span><span id="uv" class="badge-val">--</span></div>
                </div>
            </div>
            <div class="card">
                <div class="label">Precipitation</div>
                <div class="main-val"><span id="r">--</span><span class="unit">mm</span></div>
                <div class="minor-line" style="color:var(--rain); font-size:13px; margin-bottom:15px"><span id="rr_main">Rate: --</span></div>
                <div class="sub-box-4" style="grid-template-columns: 1fr;">
                    <div class="badge"><span class="badge-label">Max Intensity</span><span id="mr" class="badge-val" style="color:var(--rain)">--</span></div>
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
        function setupChart(id, label, col) {
            const ctx = document.getElementById(id).getContext('2d');
            return new Chart(ctx, { type: 'line', data: { labels: [], datasets: [{ label: label, data: [], borderColor: col, tension: 0.4, pointRadius: 0, borderWidth: 2, fill: true, backgroundColor: col + '11' }]}, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#64748b', font: { size: 9 } } } } } });
        }

        async function update() {
            try {
                const res = await fetch('/weather?v=' + Date.now());
                const d = await res.json();
                document.getElementById('t').innerText = d.temp.current;
                document.getElementById('tr').innerHTML = (d.temp.trend > 0 ? '▲' : '▼') + ' ' + Math.abs(d.temp.trend) + '°C/hr';
                document.getElementById('mx').innerHTML = d.temp.max + '°C' + (d.temp.maxTime ? '<span class="time-mark">'+d.temp.maxTime+'</span>' : '');
                document.getElementById('mn').innerHTML = d.temp.min + '°C' + (d.temp.minTime ? '<span class="time-mark">'+d.temp.minTime+'</span>' : '');
                document.getElementById('h').innerText = d.atmo.hum + '%';
                document.getElementById('h_tr').innerHTML = d.atmo.hTrend > 0 ? '▲' : d.atmo.hTrend < 0 ? '▼' : '';
                document.getElementById('pr').innerText = d.atmo.press;
                document.getElementById('p_tr').innerHTML = d.atmo.pTrend > 0 ? '▲' : d.atmo.pTrend < 0 ? '▼' : '';
                document.getElementById('p_status').innerText = d.atmo.pTrend > 0 ? 'Rising' : d.atmo.pTrend < 0 ? 'Falling' : 'Stable';
                document.getElementById('dp').innerText = d.atmo.dew + '°C';
                document.getElementById('w').innerText = d.wind.speed;
                document.getElementById('wg').innerText = d.wind.card + ' | Gust ' + d.wind.gust;
                document.getElementById('mw').innerHTML = d.wind.maxS + ' km/h' + (d.wind.maxSTime ? '<span class="time-mark">'+d.wind.maxSTime+'</span>' : '');
                document.getElementById('mg').innerHTML = d.wind.maxG + ' km/h' + (d.wind.maxGTime ? '<span class="time-mark">'+d.wind.maxGTime+'</span>' : '');
                document.getElementById('needle').style.transform = 'rotate('+d.wind.deg+'deg)';
                document.getElementById('sol').innerText = d.solar.rad + ' W/m²';
                document.getElementById('uv').innerText = d.solar.uvi;
                document.getElementById('r').innerText = d.rain.total;
                document.getElementById('rr_main').innerText = 'Rate: ' + d.rain.rate + ' mm/h';
                document.getElementById('mr').innerHTML = d.rain.maxR + ' mm/h' + (d.rain.maxRTime ? '<span class="time-mark">'+d.rain.maxRTime+'</span>' : '');
                document.getElementById('ts').innerText = new Date(d.lastSync).toLocaleTimeString('en-IN', { hour12: false });

                const labels = d.history.map(h => new Date(h.time).toLocaleTimeString());
                if (!charts.cT) {
                    charts.cT = setupChart('cT', 'Temp', '#38bdf8'); charts.cH = setupChart('cH', 'Hum', '#10b981');
                    charts.cW = setupChart('cW', 'Wind', '#fbbf24'); charts.cR = setupChart('cR', 'Rain', '#818cf8');
                }
                charts.cT.data.labels = labels; charts.cT.data.datasets[0].data = d.history.map(h => h.temp); charts.cT.update();
                charts.cH.data.labels = labels; charts.cH.data.datasets[0].data = d.history.map(h => h.hum); charts.cH.update();
                charts.cW.data.labels = labels; charts.cW.data.datasets[0].data = d.history.map(h => h.wind); charts.cW.update();
                charts.cR.data.labels = labels; charts.cR.data.datasets[0].data = d.history.map(h => h.rain); charts.cR.update();
            } catch (e) {}
        }
        setInterval(update, 45000); update();
    </script>
</body>
</html>
    `);
});

module.exports = app;
