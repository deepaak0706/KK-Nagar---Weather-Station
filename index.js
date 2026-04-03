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

// State tracks real-time rain rate and caching
let state = {
    cachedData: null,
    lastFetchTime: 0,
    lastDbWrite: 0, 
    lastRainfall: 0,
    lastRainTime: Date.now(),
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
        hi = -42.379 + 2.04901523 * T + 10.14333127 * R - 0.22475541 * T * R - 
             0.00683783 * T * T - 0.05481717 * R * R + 0.00122874 * T * T * R + 
             0.00085282 * T * R * R - 0.00000199 * T * T * R * R;
    }
    return parseFloat(((hi - 32) * 5 / 9).toFixed(1));
}

async function syncWithEcowitt() {
    const now = Date.now();
    // Cache for 30s to prevent API spam
    if (state.cachedData && (now - state.lastFetchTime < 30000)) return state.cachedData;

    try {
        const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}`;
        const response = await fetch(url);
        const json = await response.json();
        const d = json.data;

        // Conversion Logic
        const tempC = parseFloat(((d.outdoor.temperature.value - 32) * 5 / 9).toFixed(1));
        const hum = d.outdoor.humidity.value;
        const press = parseFloat((d.pressure.relative.value * 33.8639).toFixed(1));
        const dailyRain = parseFloat((d.rainfall.daily.value * 25.4).toFixed(1));
        const dewC = parseFloat(((d.outdoor.dew_point.value - 32) * 5 / 9).toFixed(1));
        const realFeel = calculateRealFeel(tempC, hum);
        const windKmh = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));
        const gustKmh = parseFloat((d.wind.wind_gust.value * 1.60934).toFixed(1));
        const solar = d.solar_and_uvi?.solar?.value || 0;
        const uvi = d.solar_and_uvi?.uvi?.value || 0;

        // Davis-Style Rain Rate Calculation
        let instantRR = 0;
        if (dailyRain > state.lastRainfall) {
            const timeDiffMin = (now - state.lastRainTime) / 60000;
            if (timeDiffMin > 0) instantRR = parseFloat(((0.254 / timeDiffMin) * 60).toFixed(1));
            state.lastRainfall = dailyRain;
            state.lastRainTime = now;
        } else if ((now - state.lastRainTime) > 15 * 60000) { instantRR = 0; }

        // DB WRITE (IST Default)
        if (now - state.lastDbWrite > 120000) {
            await pool.query(`INSERT INTO weather_history (temp_f, humidity, wind_speed_mph, wind_gust_mph, rain_rate_in, daily_rain_in, solar_radiation, press_rel) 
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, 
                        [d.outdoor.temperature.value, hum, d.wind.wind_speed.value, d.wind.wind_gust.value, instantRR, dailyRain, solar, press]);
            state.lastDbWrite = now;
        }

        // --- SIMPLIFIED IST QUERIES ---
        
        // 1. Fetch Daily Stats and Timings directly from IST column
        const statsRes = await pool.query(`
            WITH daily_data AS (
                SELECT * FROM weather_history 
                WHERE time::date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date
            )
            SELECT 
                MAX(temp_f) as mx_t, MIN(temp_f) as mn_t,
                MAX(wind_speed_mph) as mx_w, MAX(wind_gust_mph) as mx_g, MAX(rain_rate_in) as mx_rr,
                (SELECT TO_CHAR(time, 'HH24:MI') FROM daily_data WHERE temp_f = (SELECT MAX(temp_f) FROM daily_data) ORDER BY time DESC LIMIT 1) as mx_t_time,
                (SELECT TO_CHAR(time, 'HH24:MI') FROM daily_data WHERE temp_f = (SELECT MIN(temp_f) FROM daily_data) ORDER BY time DESC LIMIT 1) as mn_t_time,
                (SELECT TO_CHAR(time, 'HH24:MI') FROM daily_data WHERE wind_speed_mph = (SELECT MAX(wind_speed_mph) FROM daily_data) ORDER BY time DESC LIMIT 1) as mx_w_time,
                (SELECT TO_CHAR(time, 'HH24:MI') FROM daily_data WHERE wind_gust_mph = (SELECT MAX(wind_gust_mph) FROM daily_data) ORDER BY time DESC LIMIT 1) as mx_g_time
            FROM daily_data
        `);

        const stats = statsRes.rows[0] || {};

        // 2. Fetch Graph History (Formatted ISO strings for Chart.js)
        const historyRes = await pool.query(`
            SELECT TO_CHAR(time, 'YYYY-MM-DD"T"HH24:MI:SS') as ist_time, 
                   temp_f, humidity as hum, wind_speed_mph as wind, rain_rate_in as rain, press_rel as press 
            FROM weather_history 
            WHERE time::date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date
            ORDER BY time ASC
        `);

        const history = historyRes.rows.map(r => ({
            time: r.ist_time,
            temp: parseFloat(((r.temp_f - 32) * 5 / 9).toFixed(1)),
            hum: r.hum, press: r.press || press,
            wind: parseFloat((r.wind * 1.60934).toFixed(1)),
            rain: parseFloat(r.rain || 0)
        }));

        // Trend calculation
        let tTrend = 0, hTrend = 0, pTrend = 0;
        if (history.length >= 2) {
            const first = history[0];
            const timeDiffHrs = (now - new Date(first.time).getTime()) / 3600000;
            if (timeDiffHrs > 0.1) {
                tTrend = parseFloat(((tempC - first.temp) / timeDiffHrs).toFixed(1));
                hTrend = parseFloat(((hum - first.hum) / timeDiffHrs).toFixed(1));
                pTrend = parseFloat(((press - first.press) / timeDiffHrs).toFixed(1));
            }
        }

        state.cachedData = {
            temp: { 
                current: tempC, 
                max: stats.mx_t ? parseFloat(((stats.mx_t - 32) * 5 / 9).toFixed(1)) : tempC, 
                maxTime: stats.mx_t_time, 
                min: stats.mn_t ? parseFloat(((stats.mn_t - 32) * 5 / 9).toFixed(1)) : tempC, 
                minTime: stats.mn_t_time, 
                trend: tTrend, realFeel: realFeel 
            },
            atmo: { hum: hum, hTrend: hTrend, press: press, pTrend: pTrend, dew: dewC },
            wind: { 
                speed: windKmh, gust: gustKmh, 
                maxS: stats.mx_w ? parseFloat((stats.mx_w * 1.60934).toFixed(1)) : windKmh, 
                maxSTime: stats.mx_w_time,
                maxG: stats.mx_g ? parseFloat((stats.mx_g * 1.60934).toFixed(1)) : gustKmh, 
                maxGTime: stats.mx_g_time,
                card: getCard(d.wind.wind_direction.value), deg: d.wind.wind_direction.value 
            },
            rain: { total: dailyRain, rate: instantRR, maxR: parseFloat(stats.mx_rr || 0) },
            solar: { rad: solar, uvi: uvi },
            lastSync: d.time || new Date().toISOString(),
            history: history
        };
        state.lastFetchTime = now;
        return state.cachedData;
    } catch (e) { console.error(e); return state.cachedData || { error: "Update failed" }; }
}

// Background Daemon: Syncs DB even if no one is viewing the page
setInterval(() => { syncWithEcowitt().catch(e => console.log("Daemon Sync Failed")); }, 60000);

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
        :root { --bg-1: #020617; --bg-2: #0f172a; --bg-3: #1e293b; --card: rgba(15, 23, 42, 0.45); --accent: #38bdf8; --max-t: #fb7185; --min-t: #60a5fa; --wind: #fbbf24; --rain: #818cf8; --border: rgba(255, 255, 255, 0.08); --gap: 24px; }
        * { box-sizing: border-box; -webkit-font-smoothing: antialiased; }
        @keyframes gradient-pan { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }
        @keyframes fade-in-up { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        body { margin: 0; font-family: 'Outfit', sans-serif; background: linear-gradient(-45deg, var(--bg-1), var(--bg-2), var(--bg-3), var(--bg-1)); background-size: 400% 400%; animation: gradient-pan 20s ease infinite; color: #f8fafc; padding: 32px 24px; display: flex; flex-direction: column; align-items: center; min-height: 100vh; }
        body.solar-low { background: #000; color: #cbd5e1; animation: none; }
        .container { width: 100%; max-width: 1200px; z-index: 1; position: relative; }
        .header { margin-bottom: 40px; display: flex; justify-content: space-between; align-items: center; width: 100%; }
        .live-container { display: inline-flex; align-items: center; gap: 10px; background: rgba(34, 197, 94, 0.1); padding: 8px 18px; border-radius: 100px; border: 1px solid rgba(34, 197, 94, 0.3); backdrop-filter: blur(12px); }
        .dot { width: 10px; height: 10px; background: #22c55e; border-radius: 50%; box-shadow: 0 0 12px #22c55e; animation: pulse 2s infinite; }
        @keyframes pulse { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.3); opacity: 0.6; } }
        .grid-system { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: var(--gap); width: 100%; margin-bottom: var(--gap); }
        .card, .graph-card { background: var(--card); padding: 32px; border-radius: 28px; border: 1px solid var(--border); position: relative; backdrop-filter: blur(24px); box-shadow: 0 24px 40px rgba(0, 0, 0, 0.4); animation: fade-in-up 0.6s ease-out forwards; opacity: 0; transition: transform 0.3s ease; }
        .card:hover { transform: translateY(-4px); }
        .label { color: #94a3b8; font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 8px; }
        .main-val { font-size: 56px; font-weight: 900; margin: 4px 0; display: flex; align-items: baseline; letter-spacing: -2px; }
        .unit { font-size: 22px; font-weight: 600; color: #64748b; margin-left: 8px; }
        .minor-line { font-size: 16px; font-weight: 600; margin: 4px 0 16px 0; display: flex; align-items: center; gap: 8px; }
        .trend-badge { font-size: 13px; font-weight: 800; margin-bottom: 24px; display: inline-flex; align-items: center; gap: 8px; padding: 6px 14px; background: rgba(255,255,255,0.06); border-radius: 12px; }
        .sub-box-4 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding-top: 24px; border-top: 1px solid rgba(255, 255, 255, 0.08); }
        .badge { padding: 16px; border-radius: 20px; background: rgba(0, 0, 0, 0.2); display: flex; flex-direction: column; gap: 8px; }
        .badge-label { font-size: 11px; color: #64748b; text-transform: uppercase; font-weight: 800; }
        .badge-val { font-size: 16px; font-weight: 700; color: #f1f5f9; display: flex; align-items: center; gap: 6px; }
        .time-mark { font-size: 10px; font-weight: 800; color: #94a3b8; background: rgba(255,255,255,0.08); padding: 2px 6px; border-radius: 6px; }
        .compass-ui { position: absolute; top: 32px; right: 32px; width: 60px; height: 60px; border: 2px solid rgba(255,255,255,0.1); border-radius: 50%; display: flex; align-items: center; justify-content: center; }
        #needle { width: 4px; height: 38px; background: linear-gradient(to bottom, var(--max-t) 50%, #e2e8f0 50%); clip-path: polygon(50% 0%, 100% 100%, 50% 85%, 0% 100%); transition: transform 1.5s cubic-bezier(0.34, 1.56, 0.64, 1); }
        .graph-card { height: 360px; padding: 20px; opacity: 1; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div><h1>Kk Nagar Weather Hub</h1><div class="live-container"><div class="dot"></div><span id="ts" style="font-family:monospace; color:#22c55e">--:--:--</span></div></div>
        </div>
        <div class="grid-system">
            <div class="card" style="animation-delay:0.1s">
                <div class="label">Temperature</div>
                <div class="main-val"><span id="t">--</span><span class="unit">°C</span></div>
                <div class="minor-line" style="color:var(--accent)">RealFeel: <span id="rf">--</span>°C</div>
                <div class="trend-badge" id="tr">--</div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Today High</span><span id="mx" class="badge-val" style="color:var(--max-t)">--</span></div>
                    <div class="badge"><span class="badge-label">Today Low</span><span id="mn" class="badge-val" style="color:var(--min-t)">--</span></div>
                    <div class="badge"><span class="badge-label">Humidity</span><span id="h" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Dew Point</span><span id="dp" class="badge-val">--</span></div>
                </div>
            </div>
            <div class="card" id="card-wind" style="animation-delay:0.2s">
                <div class="label">Wind Dynamics</div>
                <div class="compass-ui"><div id="needle"></div></div>
                <div class="main-val"><span id="w">--</span><span class="unit">km/h</span></div>
                <div id="wg" class="minor-line" style="color:var(--wind)">--</div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Max Wind</span><span id="mw" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Max Gust</span><span id="mg" class="badge-val">--</span></div>
                </div>
            </div>
            <div class="card" style="animation-delay:0.3s">
                <div class="label">Atmospheric</div>
                <div class="main-val"><span id="pr">--</span><span class="unit">hPa</span></div>
                <div id="p_status" class="minor-line" style="color:#64748b">Stable</div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Solar Rad</span><span id="sol" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">UV Index</span><span id="uv" class="badge-val">--</span></div>
                </div>
            </div>
            <div class="card" id="card-rain" style="animation-delay:0.4s">
                <div class="label">Precipitation</div>
                <div class="main-val"><span id="r">--</span><span class="unit">mm</span></div>
                <div class="minor-line"><span id="rr_main" style="color:var(--rain)">Rate: --</span><span id="rain_status" style="font-size:10px; padding:2px 6px; border-radius:4px; font-weight:800; text-transform:uppercase">--</span></div>
                <div class="sub-box-4" style="grid-template-columns:1fr"><div class="badge"><span class="badge-label">Max Intensity</span><span id="mr" class="badge-val" style="color:var(--rain)">--</span></div></div>
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
        const syncPlugin = {
            id: 'syncPlugin',
            afterDraw: (chart) => {
                if (chart.tooltip?._active?.length) {
                    const x = chart.tooltip._active[0].element.x;
                    const yAxis = chart.scales.y;
                    const ctx = chart.ctx;
                    ctx.save(); ctx.beginPath(); ctx.moveTo(x, yAxis.top); ctx.lineTo(x, yAxis.bottom); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)'; ctx.setLineDash([5, 5]); ctx.stroke(); ctx.restore();
                    Object.values(charts).forEach(otherChart => {
                        if (otherChart !== chart) {
                            const index = chart.tooltip.dataPoints[0].index;
                            const meta = otherChart.getDatasetMeta(0);
                            if (meta.data[index]) {
                                otherChart.tooltip.setActiveElements([{ datasetIndex: 0, index }], { x: meta.data[index].x, y: meta.data[index].y });
                                otherChart.draw();
                            }
                        }
                    });
                }
            }
        };
        Chart.register(syncPlugin);

        function setupChart(id, label, col) {
            const ctx = document.getElementById(id).getContext('2d');
            const grad = ctx.createLinearGradient(0, 0, 0, 300); grad.addColorStop(0, col + '44'); grad.addColorStop(1, col + '00');
            return new Chart(ctx, {
                type: 'line',
                data: { labels: [], datasets: [{ label, data: [], borderColor: col, tension: 0.4, pointRadius: 0, borderWidth: 3, fill: true, backgroundColor: grad }]},
                options: { 
                    responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
                    plugins: { legend: { labels: { color: '#f8fafc', font: { weight: '700' } } } },
                    scales: { x: { ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { display: false } }, y: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(255,255,255,0.03)' } } }
                }
            });
        }

        async function update() {
            try {
                const res = await fetch('/weather?v=' + Date.now());
                const d = await res.json();
                document.getElementById('t').innerText = d.temp.current;
                document.getElementById('rf').innerText = d.temp.realFeel;
                const tIcon = d.temp.trend > 0 ? '↗' : d.temp.trend < 0 ? '↘' : '→';
                const tCol = d.temp.trend > 0 ? 'var(--max-t)' : d.temp.trend < 0 ? '#22c55e' : '#94a3b8';
                document.getElementById('tr').innerHTML = '<span style="color:'+tCol+'">'+tIcon+' '+Math.abs(d.temp.trend)+'°C/hr Trend</span>';
                document.getElementById('mx').innerHTML = d.temp.max + '°C <span class="time-mark">' + (d.temp.maxTime || '') + '</span>';
                document.getElementById('mn').innerHTML = d.temp.min + '°C <span class="time-mark">' + (d.temp.minTime || '') + '</span>';
                document.getElementById('h').innerText = d.atmo.hum + '%';
                document.getElementById('dp').innerText = d.atmo.dew + '°C';
                document.getElementById('pr').innerText = d.atmo.press;
                document.getElementById('w').innerText = d.wind.speed;
                document.getElementById('wg').innerText = d.wind.card + ' | Gust ' + d.wind.gust;
                document.getElementById('mw').innerHTML = d.wind.maxS + ' km/h <span class="time-mark">' + (d.wind.maxSTime || '') + '</span>';
                document.getElementById('mg').innerHTML = d.wind.maxG + ' km/h <span class="time-mark">' + (d.wind.maxGTime || '') + '</span>';
                document.getElementById('needle').style.transform = 'rotate('+d.wind.deg+'deg)';
                document.getElementById('sol').innerText = d.solar.rad + ' W/m²';
                document.getElementById('uv').innerText = d.solar.uvi;
                document.getElementById('r').innerText = d.rain.total;
                document.getElementById('rr_main').innerText = 'Rate: ' + d.rain.rate + ' mm/h';
                document.getElementById('mr').innerText = (d.rain.maxR || 0) + ' mm/h';
                document.getElementById('ts').innerText = new Date(d.lastSync).toLocaleTimeString('en-IN', { hour12: false });
                
                const rStat = d.rain.rate > 0 ? {t:'Raining', c:'#38bdf8', b:'rgba(56,189,248,0.1)'} : {t:'Dry', c:'#64748b', b:'rgba(255,255,255,0.06)'};
                document.getElementById('rain_status').innerText = rStat.t;
                document.getElementById('rain_status').style.color = rStat.c;
                document.getElementById('rain_status').style.background = rStat.b;

                const labels = d.history.map(h => new Date(h.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }));
                if (!charts.cT) {
                    charts.cT = setupChart('cT', 'Temp (°C)', '#38bdf8'); charts.cH = setupChart('cH', 'Humidity (%)', '#10b981');
                    charts.cW = setupChart('cW', 'Wind (km/h)', '#fbbf24'); charts.cR = setupChart('cR', 'Rain (mm/h)', '#818cf8');
                }
                charts.cT.data.labels = labels; charts.cT.data.datasets[0].data = d.history.map(h => h.temp); charts.cT.update('none');
                charts.cH.data.labels = labels; charts.cH.data.datasets[0].data = d.history.map(h => h.hum); charts.cH.update('none');
                charts.cW.data.labels = labels; charts.cW.data.datasets[0].data = d.history.map(h => h.wind); charts.cW.update('none');
                charts.cR.data.labels = labels; charts.cR.data.datasets[0].data = d.history.map(h => h.rain); charts.cR.update('none');
            } catch (e) { }
        }
        setInterval(update, 30000); update();
    </script>
</body>
</html>
    `);
});

module.exports = app;
