const express = require("express");
const fetch = require("node-fetch");
const { Pool } = require('pg');
const app = express();

const pool = new Pool({
    connectionString: process.env.POSTGRES_URL + "?sslmode=require",
    ssl: { rejectUnauthorized: false }
});

const APPLICATION_KEY = process.env.APPLICATION_KEY;
const API_KEY = process.env.API_KEY;
const MAC = process.env.MAC;

// Persistent state for caching and database buffering
let state = { 
    cachedData: null, 
    lastFetchTime: 0, 
    lastDbWrite: 0,
    bufW: 0, bufG: 0, bufMaxT: -999, bufMinT: 999, bufRR: 0 
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

async function syncWithEcowitt(forceWrite = false) {
    const now = Date.now();
    if (!forceWrite && state.cachedData && (now - state.lastFetchTime < 35000)) return state.cachedData;

    try {
        const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}`;
        const response = await fetch(url);
        const json = await response.json();
        const d = json.data;

        const liveTemp = parseFloat(((d.outdoor.temperature.value - 32) * 5 / 9).toFixed(1));
        const liveDew = parseFloat(((d.outdoor.dew_point.value - 32) * 5 / 9).toFixed(1));
        const liveHum = d.outdoor.humidity.value || 0;
        const livePress = parseFloat((d.pressure.relative.value * 33.8639).toFixed(1));
        const liveWind = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));
        const liveGust = parseFloat((d.wind.wind_gust.value * 1.60934).toFixed(1));
        
        const liveRain24h = parseFloat((d.rainfall.daily.value * 25.4).toFixed(1));
        const liveRainWeekly = parseFloat((d.rainfall.weekly.value * 25.4).toFixed(1));
        const liveRainMonthly = parseFloat((d.rainfall.monthly.value * 25.4).toFixed(1));
        const liveRainYearly = parseFloat((d.rainfall.yearly.value * 25.4).toFixed(1));
        const liveRainRate = parseFloat(((d.rainfall.rain_rate?.value || 0) * 25.4).toFixed(1));

        // Archive and buffer logic
        if (d.wind.wind_speed.value > state.bufW) state.bufW = d.wind.wind_speed.value;
        if (d.wind.wind_gust.value > state.bufG) state.bufG = d.wind.wind_gust.value;
        if (d.outdoor.temperature.value > state.bufMaxT) state.bufMaxT = d.outdoor.temperature.value;
        if (d.outdoor.temperature.value < state.bufMinT) state.bufMinT = d.outdoor.temperature.value;
        if ((d.rainfall.rain_rate?.value || 0) > state.bufRR) state.bufRR = (d.rainfall.rain_rate?.value || 0);

        const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        const dateCheck = await pool.query(`SELECT (time AT TIME ZONE 'Asia/Kolkata')::date as record_date FROM weather_history ORDER BY time ASC LIMIT 1`);
        
        if (dateCheck.rows.length > 0) {
            const oldestDate = new Date(dateCheck.rows[0].record_date).toLocaleDateString('en-CA');
            if (oldestDate !== todayIST) {
                await pool.query(`INSERT INTO daily_max_records (record_date, max_temp_c, min_temp_c, max_wind_kmh, total_rain_mm) SELECT $1, MAX((temp_f - 32) * 5/9), MIN((temp_f - 32) * 5/9), MAX(wind_speed_mph * 1.60934), MAX(daily_rain_in * 25.4) FROM weather_history WHERE (time AT TIME ZONE 'Asia/Kolkata')::date = $1::date;`, [oldestDate]);
                await pool.query(`DELETE FROM weather_history WHERE (time AT TIME ZONE 'Asia/Kolkata')::date < (NOW() AT TIME ZONE 'Asia/Kolkata')::date;`);
            }
        }

        if (forceWrite || (now - state.lastDbWrite > 120000)) {
            try {
                await pool.query(`INSERT INTO weather_history (time, temp_f, humidity, wind_speed_mph, wind_gust_mph, daily_rain_in, solar_radiation, press_rel, rain_rate_in) VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8)`, [state.bufMaxT, liveHum, state.bufW, state.bufG, d.rainfall.daily.value, d.solar_and_uvi?.solar?.value || 0, livePress, state.bufRR]);
                state.bufW = 0; state.bufG = 0; state.bufMaxT = -999; state.bufMinT = 999; state.bufRR = 0;
                state.lastDbWrite = now;
            } catch (err) { console.error("DB Error:", err.message); }
        }

        const historyRes = await pool.query(`SELECT * FROM weather_history WHERE (time AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date ORDER BY time ASC`);
        const oneHourAgoRes = await pool.query(`SELECT temp_f, humidity FROM weather_history WHERE time >= NOW() - INTERVAL '1 hour' ORDER BY time ASC LIMIT 1`);
        
        let mx_t = -999, mn_t = 999, mx_t_time = "--:--", mn_t_time = "--:--", mx_w = 0, mx_w_t = "--:--", mx_g = 0, mx_g_t = "--:--", mx_r = 0, mx_r_t = "--:--", pTrend = 0, tRate = 0, hTrend = 0, graphHistory = [];

        if (historyRes.rows.length > 0) {
            const lastRow = historyRes.rows[historyRes.rows.length - 1];
            pTrend = parseFloat((livePress - (lastRow.press_rel || livePress)).toFixed(1));
            const baseTempF = oneHourAgoRes.rows.length > 0 ? oneHourAgoRes.rows[0].temp_f : (historyRes.rows[0].temp_f || d.outdoor.temperature.value);
            const baseHum = oneHourAgoRes.rows.length > 0 ? oneHourAgoRes.rows[0].humidity : (historyRes.rows[0].humidity || liveHum);
            tRate = parseFloat((liveTemp - parseFloat(((baseTempF - 32) * 5 / 9).toFixed(1))).toFixed(1));
            hTrend = liveHum - baseHum;

            historyRes.rows.forEach(r => {
                const r_time = new Date(r.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
                const r_temp = parseFloat(((r.temp_f - 32) * 5 / 9).toFixed(1));
                const r_wind = parseFloat((r.wind_speed_mph * 1.60934).toFixed(1));
                const r_gust = parseFloat((r.wind_gust_mph * 1.60934).toFixed(1));
                const r_rain_rate = parseFloat((r.rain_rate_in * 25.4).toFixed(1));

                if (r_temp > mx_t) { mx_t = r_temp; mx_t_time = r_time; }
                if (r_temp < mn_t || mn_t === 999) { mn_t = r_temp; mn_t_time = r_time; }
                if (r_wind > mx_w) { mx_w = r_wind; mx_w_t = r_time; }
                if (r_gust > mx_g) { mx_g = r_gust; mx_g_t = r_time; }
                if (r_rain_rate > mx_r) { mx_r = r_rain_rate; mx_r_t = r_time; }
                
                graphHistory.push({ time: r.time, temp: r_temp, hum: r.humidity, wind: r_wind, rain: parseFloat((r.daily_rain_in * 25.4).toFixed(1)) });
            });
        }

        const liveTime = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
        
        if (mx_t === -999 || liveTemp > mx_t) { mx_t = liveTemp; mx_t_time = liveTime; }
        if (mn_t === 999 || liveTemp < mn_t) { mn_t = liveTemp; mn_t_time = liveTime; }
        if (liveWind > mx_w) { mx_w = liveWind; mx_w_t = "Live"; }
        if (liveGust > mx_g) { mx_g = liveGust; mx_g_t = "Live"; }
        if (liveRainRate > mx_r) { mx_r = liveRainRate; mx_r_t = "Live"; }

        state.cachedData = {
            temp: { current: liveTemp, dew: liveDew, max: mx_t, maxTime: mx_t_time, min: mn_t, minTime: mn_t_time, realFeel: calculateRealFeel(liveTemp, liveHum), rate: tRate },
            atmo: { hum: liveHum, hTrend: hTrend, press: livePress, pTrend, sol: d.solar_and_uvi?.solar?.value || 0, uv: d.solar_and_uvi?.uvi?.value || 0 },
            wind: { speed: liveWind, gust: liveGust, maxS: mx_w, maxSTime: mx_w_t, maxG: mx_g, maxGTime: mx_g_t, deg: d.wind.wind_direction.value, card: getCard(d.wind.wind_direction.value) },
            rain: { total: liveRain24h, weekly: liveRainWeekly, monthly: liveRainMonthly, yearly: liveRainYearly, rate: liveRainRate, maxR: mx_r, maxRTime: mx_r_t },
            history: graphHistory,
            lastSync: new Date().toISOString()
        };
        state.lastFetchTime = now;
        return state.cachedData;
    } catch (e) { return { error: e.message }; }
}

app.get("/weather", async (req, res) => res.json(await syncWithEcowitt()));
app.get("/api/sync", async (req, res) => res.json(await syncWithEcowitt(true)));

app.get("/", (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <title>KK Nagar Weather Hub</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;700;900&display=swap" rel="stylesheet">
    <style>
        :root { 
            --bg: #e0f2fe; 
            --card: rgba(255, 255, 255, 0.85); 
            --border: rgba(2, 132, 199, 0.1);
            --text: #0f172a; 
            --muted: #64748b; 
            --accent: #0284c7; 
            --glow: 0 10px 40px -10px rgba(2, 132, 199, 0.15);
            --badge: rgba(2, 132, 199, 0.05);
        }

        body.is-night {
            --bg: #0f172a; 
            --card: rgba(30, 41, 59, 0.7); 
            --border: rgba(255, 255, 255, 0.08);
            --text: #f1f5f9; 
            --muted: #94a3b8; 
            --accent: #38bdf8; 
            --glow: 0 15px 50px -12px rgba(0,0,0,0.6);
            --badge: rgba(255, 255, 255, 0.04);
        }

        body { 
            margin: 0; font-family: 'Outfit', sans-serif; background: var(--bg); color: var(--text); 
            padding: 20px 16px 120px 16px; transition: background 0.5s ease, color 0.5s ease; 
            min-height: 100vh; overflow-x: hidden; 
        }

        .container { width: 100%; max-width: 1200px; margin: 0 auto; }
        
        .header { margin-bottom: 32px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px; }
        .header h1 { font-size: 28px; font-weight: 900; margin: 0; letter-spacing: -1px; }

        .header-actions { display: flex; align-items: center; gap: 12px; }
        
        .theme-toggle {
            background: var(--card); border: 1px solid var(--border); padding: 4px; border-radius: 12px;
            display: flex; gap: 4px; box-shadow: var(--glow); cursor: pointer;
        }
        .theme-btn { 
            padding: 6px 10px; border-radius: 8px; font-size: 11px; font-weight: 700; 
            transition: 0.3s; color: var(--muted); 
        }
        .theme-btn.active { background: var(--accent); color: white; }

        .status-bar { display: flex; align-items: center; gap: 8px; background: var(--card); padding: 6px 16px; border-radius: 100px; border: 1px solid var(--border); box-shadow: var(--glow); font-size: 13px; }
        .live-dot { width: 6px; height: 6px; background: #10b981; border-radius: 50%; animation: blink 2s infinite; }
        @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        
        .grid-system { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
        
        .card { 
            background: var(--card); padding: 28px; border-radius: 32px; border: 1px solid var(--border); 
            backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); box-shadow: var(--glow); 
            position: relative; overflow: hidden; transition: background 0.5s ease; 
        }

        #windCanvas { position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 0; pointer-events: none; border-radius: 32px; }
        .card > *:not(canvas) { position: relative; z-index: 5; }

        .label { color: var(--accent); font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 6px; }
        .main-val { font-size: 56px; font-weight: 900; margin: 0; letter-spacing: -2px; display: flex; align-items: baseline; line-height: 1.1; }
        .unit { font-size: 20px; font-weight: 600; color: var(--muted); margin-left: 4px; letter-spacing: 0; }

        .sub-pill { font-size: 12px; font-weight: 800; padding: 6px 12px; border-radius: 10px; background: var(--badge); display: inline-flex; align-items: center; gap: 4px; margin: 12px 0 20px 0; }

        .sub-box-4 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding-top: 20px; border-top: 1px solid var(--border); }
        .badge { padding: 12px; border-radius: 18px; background: var(--badge); display: flex; flex-direction: column; gap: 2px; }
        .badge-label { font-size: 9px; color: var(--muted); text-transform: uppercase; font-weight: 800; }
        .badge-val { font-size: 16px; font-weight: 800; }

        .compass-ui { position: absolute !important; top: 28px !important; right: 28px !important; width: 50px; height: 50px; border: 2px solid var(--border); border-radius: 50%; display: flex; align-items: center; justify-content: center; z-index: 10; }
        #needle { width: 3px; height: 32px; background: linear-gradient(to bottom, #ef4444 50%, var(--muted) 50%); clip-path: polygon(50% 0%, 100% 100%, 50% 85%, 0% 100%); transition: transform 2s cubic-bezier(0.1, 0.9, 0.2, 1); }

        .graphs-wrapper { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-top: 20px; }
        .graph-card { background: var(--card); padding: 24px; border-radius: 32px; border: 1px solid var(--border); height: 320px; box-shadow: var(--glow); display: flex; flex-direction: column; overflow: hidden; transition: background 0.5s ease; }
        .graph-card canvas { flex-grow: 1; width: 100% !important; height: 100% !important; }

        .trend-up { color: #f43f5e; } .trend-down { color: #0ea5e9; }
        .time-mark { font-size: 9px; color: var(--muted); font-weight: 600; margin-left: 2px; background: rgba(0,0,0,0.04); padding: 1px 4px; border-radius: 4px; }
        body.is-night .time-mark { background: rgba(255,255,255,0.1); }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>KK Nagar Weather Hub</h1>
            <div class="header-actions">
                <div class="status-bar">
                    <div class="live-dot"></div>
                    <div class="timestamp"><span id="ts">--:--:--</span></div>
                </div>
                
                <div class="theme-toggle" id="themeToggle">
                    <div class="theme-btn" id="btn-light">LIGHT</div>
                    <div class="theme-btn" id="btn-dark">DARK</div>
                    <div class="theme-btn active" id="btn-auto">AUTO</div>
                </div>
            </div>
        </div>

        <div class="grid-system">
            <div class="card">
                <div class="label">Temperature</div>
                <div class="main-val"><span id="t">--</span><span class="unit">°C</span></div>
                <div id="tTrendBox" class="sub-pill">--</div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Today High</span><span id="mx" class="badge-val" style="color:#ef4444">--</span></div>
                    <div class="badge"><span class="badge-label">Today Low</span><span id="mn" class="badge-val" style="color:#0ea5e9">--</span></div>
                    <div class="badge"><span class="badge-label">Humidity</span><span id="h_val" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Dew Point</span><span id="d_val" class="badge-val">--</span></div>
                    <div class="badge" style="grid-column: span 2;"><span class="badge-label">Feels Like</span><span id="rf" class="badge-val">--</span></div>
                </div>
            </div>

            <div class="card">
                <canvas id="windCanvas"></canvas>
                <div class="label">Wind Dynamics</div>
                <div class="compass-ui"><div id="needle"></div></div>
                <div class="main-val">
                    <span id="w">--</span>
                    <span id="wd_bracket" style="font-size:18px; color:var(--muted); margin-left:8px; font-weight:700">(--)</span>
                    <span class="unit">km/h</span>
                </div>
                <div class="sub-pill">● Live Gust: <span id="wg" style="margin-left:4px">--</span></div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Max Speed</span><span id="mw" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Max Gust</span><span id="mg" class="badge-val">--</span></div>
                </div>
            </div>

            <div class="card">
                <div class="label">Rain Realm</div>
                <div class="main-val"><span id="r_tot">--</span><span class="unit">mm</span></div>
                <div class="sub-pill">● Rain Rate: <span id="r_rate">--</span> mm/h</div>
                <div class="sub-box-4">
                    <div class="badge" style="grid-column: span 2;"><span class="badge-label">Max Rate Today</span><span id="mr" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Weekly</span><span id="r_week" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Monthly</span><span id="r_month" class="badge-val">--</span></div>
                    <div class="badge" style="grid-column: span 2;"><span class="badge-label">Yearly</span><span id="r_year" class="badge-val">--</span></div>
                </div>
            </div>

            <div class="card">
                <div class="label">Atmospheric <span id="pIcon"></span></div>
                <div class="main-val"><span id="pr">--</span><span class="unit">hPa</span></div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Solar Rad</span><span id="sol" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">UV Index</span><span id="uv" class="badge-val">--</span></div>
                </div>
            </div>
        </div>

        <div class="graphs-wrapper">
            <div class="graph-card"><div class="label" style="margin-bottom: 8px;">Temperature Trend</div><canvas id="cT"></canvas></div>
            <div class="graph-card"><div class="label" style="margin-bottom: 8px;">Humidity Levels</div><canvas id="cH"></canvas></div>
            <div class="graph-card"><div class="label" style="margin-bottom: 8px;">Wind Velocity</div><canvas id="cW"></canvas></div>
            <div class="graph-card"><div class="label" style="margin-bottom: 8px;">Precipitation</div><canvas id="cR"></canvas></div>
        </div>
    </div>


    <script>
        let currentMode = localStorage.getItem('weatherMode') || 'auto';
        let charts = {};
        let liveWindSpeed = 0, liveWindDeg = 0, particles = [];
        const wCanvas = document.getElementById('windCanvas');
        const ctxW = wCanvas.getContext('2d');

        // Custom Chart Enhancements for MAX labels and hover lines
        Chart.register({
            id: 'customChartEnhancements',
            afterDraw: (chart) => {
                if (chart.tooltip?._active?.length) {
                    const x = chart.tooltip._active[0].element.x;
                    const yAxis = chart.scales.y;
                    const ctx = chart.ctx;
                    ctx.save();
                    ctx.setLineDash([5, 5]);
                    ctx.beginPath();
                    ctx.moveTo(x, yAxis.top);
                    ctx.lineTo(x, yAxis.bottom);
                    ctx.lineWidth = 1;
                    ctx.strokeStyle = document.body.classList.contains('is-night') ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)';
                    ctx.stroke();
                    ctx.restore();
                }
            },
            afterDatasetsDraw: (chart) => {
                const { ctx, data, scales: { x, y } } = chart;
                const dataset = data.datasets[0];
                if (!dataset || !dataset.data || dataset.data.length < 2) return;

                const maxVal = Math.max(...dataset.data);
                const maxIndex = dataset.data.lastIndexOf(maxVal);
                const meta = chart.getDatasetMeta(0);
                const point = meta.data[maxIndex];

                if (point && maxVal > -50) { 
                    ctx.save();
                    ctx.beginPath();
                    ctx.arc(point.x, point.y, 5, 0, 2 * Math.PI);
                    ctx.strokeStyle = dataset.borderColor;
                    ctx.lineWidth = 2;
                    ctx.stroke();
                    ctx.beginPath();
                    ctx.arc(point.x, point.y, 2, 0, 2 * Math.PI);
                    ctx.fillStyle = '#fff';
                    ctx.fill();
                    ctx.fillStyle = document.body.classList.contains('is-night') ? '#94a3b8' : '#475569';
                    ctx.font = 'bold 10px Outfit, sans-serif';
                    ctx.textAlign = 'center';
                    ctx.fillText('MAX', point.x, point.y - 12);
                    ctx.restore();
                }
            }
        });

        function applyTheme() {
            const hour = new Date().getHours();
            const btns = document.querySelectorAll('.theme-btn');
            btns.forEach(b => b.classList.remove('active'));

            if (currentMode === 'dark') {
                document.body.classList.add('is-night');
                document.getElementById('btn-dark').classList.add('active');
            } else if (currentMode === 'light') {
                document.body.classList.remove('is-night');
                document.getElementById('btn-light').classList.add('active');
            } else {
                document.getElementById('btn-auto').classList.add('active');
                if (hour >= 18 || hour < 6) document.body.classList.add('is-night');
                else document.body.classList.remove('is-night');
            }
            if (charts.cT) updateChartColors();
        }

        document.getElementById('btn-light').onclick = () => { currentMode = 'light'; localStorage.setItem('weatherMode', 'light'); applyTheme(); };
        document.getElementById('btn-dark').onclick = () => { currentMode = 'dark'; localStorage.setItem('weatherMode', 'dark'); applyTheme(); };
        document.getElementById('btn-auto').onclick = () => { currentMode = 'auto'; localStorage.setItem('weatherMode', 'auto'); applyTheme(); };

        function updateChartColors() {
            const gridColor = document.body.classList.contains('is-night') ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)';
            const textColor = document.body.classList.contains('is-night') ? '#94a3b8' : '#64748b';
            Object.values(charts).forEach(chart => {
                chart.options.scales.y.grid.color = gridColor;
                chart.options.scales.y.ticks.color = textColor;
                chart.options.scales.x.ticks.color = textColor;
                chart.update('none');
            });
        }

        function setupChart(id, label, color, minVal = null) {
            const canvas = document.getElementById(id);
            const ctx = canvas.getContext('2d');
            const gradient = ctx.createLinearGradient(0, 0, 0, 300);
            gradient.addColorStop(0, color + '40'); 
            gradient.addColorStop(1, color + '00');

            return new Chart(ctx, { 
                type: id === 'cR' ? 'bar' : 'line', 
                data: { 
                    labels: [], 
                    datasets: [{ 
                        label: label, 
                        data: [], 
                        borderColor: color, 
                        backgroundColor: gradient,
                        fill: true, 
                        tension: 0.4, 
                        pointRadius: 0,
                        hitRadius: 10, 
                        borderWidth: 2,
                        borderRadius: 4
                    }] 
                }, 
                options: { 
                    animation: { duration: 1000, easing: 'easeOutQuart' },
                    responsive: true, 
                    maintainAspectRatio: false,
                    interaction: { intersect: false, mode: 'index' },
                    plugins: { legend: { display: false }, tooltip: { padding: 10, cornerRadius: 10, displayColors: false } },
                    scales: { 
                        y: { grid: { color: 'rgba(0,0,0,0.03)', drawBorder: false }, ticks: { font: { family: 'Outfit', size: 9 }, padding: 4 }, min: minVal }, 
                        x: { grid: { display: false }, ticks: { font: { family: 'Outfit', size: 9 }, maxTicksLimit: 8, maxRotation: 0 } } 
                    } 
                } 
            });
        }

        async function update() {
            try {
                const res = await fetch('/weather?v=' + Date.now()); 
                const d = await res.json(); 
                if (!d || d.error) return;
                
                document.getElementById('t').innerText = d.temp.current;
                document.getElementById('tTrendBox').innerHTML = d.temp.rate > 0 ? '<span class="trend-up">▲</span> +' + d.temp.rate + '°C /hr' : d.temp.rate < 0 ? '<span class="trend-down">▼</span> ' + d.temp.rate + '°C /hr' : '● Steady';
                document.getElementById('mx').innerHTML = d.temp.max + '°C <span class="time-mark">' + d.temp.maxTime + '</span>';
                document.getElementById('mn').innerHTML = d.temp.min + '°C <span class="time-mark">' + d.temp.minTime + '</span>';
                document.getElementById('rf').innerText = d.temp.realFeel + '°C'; 
                
                const hIcon = d.atmo.hTrend > 0 ? '<span style="color:#10b981">▲</span>' : d.atmo.hTrend < 0 ? '<span style="color:#f43f5e">▼</span>' : '<span style="opacity:0.4">●</span>';
                document.getElementById('h_val').innerHTML = d.atmo.hum + '% ' + hIcon;
                document.getElementById('d_val').innerText = d.temp.dew + '°C';
                
                document.getElementById('w').innerText = d.wind.speed; 
                document.getElementById('wd_bracket').innerText = '(' + d.wind.card + ')';
                document.getElementById('wg').innerText = d.wind.gust + ' km/h';
                document.getElementById('mw').innerHTML = d.wind.maxS + ' km/h <span class="time-mark">' + d.wind.maxSTime + '</span>';
                document.getElementById('mg').innerHTML = d.wind.maxG + ' km/h <span class="time-mark">' + d.wind.maxGTime + '</span>';
                document.getElementById('needle').style.transform = 'rotate(' + d.wind.deg + 'deg)';
                
                liveWindSpeed = d.wind.speed;
                liveWindDeg = d.wind.deg;

                document.getElementById('r_tot').innerText = d.rain.total; 
                document.getElementById('r_rate').innerText = d.rain.rate;
                document.getElementById('r_week').innerText = d.rain.weekly + ' mm'; 
                document.getElementById('r_month').innerText = d.rain.monthly + ' mm';
                document.getElementById('r_year').innerText = d.rain.yearly + ' mm';
                document.getElementById('mr').innerHTML = d.rain.maxR > 0 ? d.rain.maxR + ' mm/h <span class="time-mark">' + d.rain.maxRTime + '</span>' : '0 mm/h';
                
                document.getElementById('pr').innerText = d.atmo.press;
                const pIcon = document.getElementById('pIcon');
                if (d.atmo.pTrend > 0) pIcon.innerHTML = '<span class="trend-up">▲</span>';
                else if (d.atmo.pTrend < 0) pIcon.innerHTML = '<span class="trend-down">▼</span>';
                else pIcon.innerHTML = '<span style="opacity:0.3">●</span>';

                document.getElementById('sol').innerText = d.atmo.sol + ' W/m²'; 
                document.getElementById('uv').innerText = d.atmo.uv;
                document.getElementById('ts').innerText = new Date(d.lastSync).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

                const labels = d.history.map(h => new Date(h.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }));
                if(!charts.cT) { 
                    charts.cT = setupChart('cT', 'Temp °C', '#ef4444'); 
                    charts.cH = setupChart('cH', 'Humidity %', '#10b981'); 
                    charts.cW = setupChart('cW', 'Wind km/h', '#f59e0b'); 
                    charts.cR = setupChart('cR', 'Rain mm', '#3b82f6', 0); 
                    applyTheme(); 
                }
                charts.cT.data.labels = labels; charts.cT.data.datasets[0].data = d.history.map(h => h.temp); charts.cT.update('none');
                charts.cH.data.labels = labels; charts.cH.data.datasets[0].data = d.history.map(h => h.hum); charts.cH.update('none');
                charts.cW.data.labels = labels; charts.cW.data.datasets[0].data = d.history.map(h => h.wind); charts.cW.update('none');
                charts.cR.data.labels = labels; charts.cR.data.datasets[0].data = d.history.map(h => h.rain); charts.cR.update('none');

            } catch (e) { console.error(e); }
        }

        // Particle logic for wind animation
        for(let i=0; i<60; i++) { particles.push({ x: Math.random() * 800, y: Math.random() * 800 }); }
        
        function animateWind() {
            if (wCanvas.width !== wCanvas.offsetWidth) { 
                wCanvas.width = wCanvas.offsetWidth; 
                wCanvas.height = wCanvas.offsetHeight; 
            }
            ctxW.clearRect(0, 0, wCanvas.width, wCanvas.height);
            const rad = (liveWindDeg - 90) * (Math.PI / 180);
            const speed = Math.max(0.5, liveWindSpeed * 0.8); 
            const dx = Math.cos(rad) * speed, dy = Math.sin(rad) * speed;
            const intensity = Math.min(0.4, 0.1 + (liveWindSpeed / 60));
            
            ctxW.strokeStyle = document.body.classList.contains('is-night') 
                ? \`rgba(255, 255, 255, \${intensity * 1.5})\` 
                : \`rgba(2, 132, 199, \${intensity})\`;
            
            ctxW.lineWidth = liveWindSpeed > 20 ? 1.5 : 1;
            ctxW.beginPath();
            particles.forEach(p => {
                p.x += dx; p.y += dy;
                if (p.x > wCanvas.width) p.x = 0; else if (p.x < 0) p.x = wCanvas.width;
                if (p.y > wCanvas.height) p.y = 0; else if (p.y < 0) p.y = wCanvas.height;
                ctxW.moveTo(p.x, p.y);
                ctxW.lineTo(p.x - dx * 0.35, p.y - dy * 0.35);
            });
            ctxW.stroke();
            requestAnimationFrame(animateWind);
        }

        applyTheme();
        animateWind();
        setInterval(update, 45000); 
        update();
    </script>
</body>
</html>
    `);
});

if (process.env.NODE_ENV !== 'production') {
    const port = 3000;
    app.listen(port, () => {
        console.log(`Local development server running at http://localhost:${port}`);
    });
}

module.exports = app;
