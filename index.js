const express = require("express");
const fetch = require("node-fetch");
const { Pool } = require('pg');
const app = express();

const pool = new Pool({
    connectionString: process.env.POSTGRES_URL + "?sslmode=require",
});

// Environment Variables
const APPLICATION_KEY = process.env.APPLICATION_KEY;
const API_KEY = process.env.API_KEY;
const MAC = process.env.MAC;

let state = {
    cachedData: null,
    lastFetchTime: 0,
    lastDbWrite: 0
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

async function syncWithEcowitt(forceWrite = false) {
    const now = Date.now();
    
    if (!forceWrite && state.cachedData && (now - state.lastFetchTime < 35000)) {
        return state.cachedData;
    }

    try {
        const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}`;
        const response = await fetch(url);
        const json = await response.json();
        if (!json.data) throw new Error("No data from Ecowitt");
        const d = json.data;

        // Current Stats
        const tempC = parseFloat(((d.outdoor.temperature.value - 32) * 5 / 9).toFixed(1));
        const hum = d.outdoor.humidity.value || 0;
        const press = parseFloat((d.pressure.relative.value * 33.8639).toFixed(1)) || 0;
        const dailyRain = parseFloat((d.rainfall.daily.value * 25.4).toFixed(1)) || 0;
        const windKmh = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1)) || 0;
        const gustKmh = parseFloat((d.wind.wind_gust.value * 1.60934).toFixed(1)) || 0;
        const solar = d.solar_and_uvi?.solar?.value || 0;
        const dewC = parseFloat(((d.outdoor.dew_point.value - 32) * 5 / 9).toFixed(1)) || 0;

        // DB Write (Every 2 mins via Cron)
        if (forceWrite || (now - state.lastDbWrite > 120000)) {
            await pool.query(`INSERT INTO weather_history (time, temp_f, humidity, wind_speed_mph, wind_gust_mph, daily_rain_in, solar_radiation, press_rel, rain_rate_in) 
                             VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8)`, 
                             [d.outdoor.temperature.value, hum, d.wind.wind_speed.value, d.wind.wind_gust.value, d.rainfall.daily.value, solar, press, d.rainfall.rain_rate?.value || 0]);
            state.lastDbWrite = now;
        }

        // Process 24h History from DB
        const historyRes = await pool.query(`SELECT * FROM weather_history WHERE time > NOW() - INTERVAL '24 hours' ORDER BY time ASC`);
        const todayStr = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
        
        let mx_t = tempC, mn_t = tempC, mx_t_time = "", mn_t_time = "";
        let mx_w = windKmh, mx_w_time = "", mx_g = gustKmh, mx_g_time = "";
        let mx_r = 0, mx_r_time = "";
        let graphHistory = [];
        let lastGraphTS = 0;

        historyRes.rows.forEach(r => {
            const r_date = new Date(r.time).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
            const r_time = new Date(r.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
            const r_temp = parseFloat(((r.temp_f - 32) * 5 / 9).toFixed(1));
            const r_wind = parseFloat((r.wind_speed_mph * 1.60934).toFixed(1));
            const r_gust = parseFloat((r.wind_gust_mph * 1.60934).toFixed(1));
            const r_rain_rate = parseFloat((r.rain_rate_in * 25.4).toFixed(1));

            if (r_date === todayStr) {
                if (r_temp >= mx_t) { mx_t = r_temp; mx_t_time = r_time; }
                if (r_temp <= mn_t) { mn_t = r_temp; mn_t_time = r_time; }
                if (r_wind >= mx_w) { mx_w = r_wind; mx_w_time = r_time; }
                if (r_gust >= mx_g) { mx_g = r_gust; mx_g_time = r_time; }
                if (r_rain_rate >= mx_r) { mx_r = r_rain_rate; mx_r_time = r_time; }
            }

            // 5-minute Graph Interval Filter
            const r_ts = new Date(r.time).getTime();
            if (r_ts - lastGraphTS >= 300000) {
                graphHistory.push({ time: r.time, temp: r_temp, hum: r.humidity, wind: r_wind, press: r.press_rel || press, rain: r_rain_rate });
                lastGraphTS = r_ts;
            }
        });

        state.cachedData = {
            temp: { current: tempC, max: mx_t, maxTime: mx_t_time, min: mn_t, minTime: mn_t_time, trend: 0, realFeel: calculateRealFeel(tempC, hum) },
            atmo: { hum: hum, press: press, dew: dewC, hTrend: 0, pTrend: 0 },
            wind: { speed: windKmh, gust: gustKmh, maxS: mx_w, maxSTime: mx_w_time, maxG: mx_g, maxGTime: mx_g_time, deg: d.wind.wind_direction.value, card: getCard(d.wind.wind_direction.value) },
            rain: { total: dailyRain, rate: parseFloat(((d.rainfall.rain_rate?.value || 0) * 25.4).toFixed(1)), maxR: mx_r, maxRTime: mx_r_time },
            solar: { rad: solar, uvi: d.solar_and_uvi?.uvi?.value || 0 },
            history: graphHistory,
            lastSync: new Date().toISOString()
        };
        state.lastFetchTime = now;
        return state.cachedData;
    } catch (e) { 
        console.error(e);
        return state.cachedData || { error: "Sync failed" }; 
    }
}

// Routes
app.get("/api/sync", async (req, res) => {
    await syncWithEcowitt(true);
    res.json({ success: true });
});

app.get("/weather", async (req, res) => {
    const data = await syncWithEcowitt();
    res.json(data);
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
        :root { 
            --bg-1: #020617; --bg-2: #0f172a; --bg-3: #1e293b;
            --card: rgba(15, 23, 42, 0.45); --accent: #38bdf8; 
            --max-t: #fb7185; --min-t: #60a5fa; --wind: #fbbf24; 
            --rain: #818cf8; --border: rgba(255, 255, 255, 0.08); --gap: 24px;
        }

        * { box-sizing: border-box; -webkit-font-smoothing: antialiased; }
        
        @keyframes gradient-pan { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }
        @keyframes fade-in-up { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }

        body { 
            margin: 0; font-family: 'Outfit', sans-serif; 
            background: linear-gradient(-45deg, var(--bg-1), var(--bg-2), var(--bg-3), var(--bg-1));
            background-size: 400% 400%; animation: gradient-pan 20s ease infinite;
            color: #f8fafc; padding: 32px 24px; display: flex; flex-direction: column; align-items: center; min-height: 100vh;
        }

        body.solar-low { background: #000; animation: none; }

        .container { width: 100%; max-width: 1200px; z-index: 1; }
        .header { margin-bottom: 40px; display: flex; justify-content: space-between; align-items: center; width: 100%; }
        .header h1 { margin: 0; font-size: 32px; font-weight: 900; letter-spacing: -1px; }
        
        .live-container { 
            display: inline-flex; align-items: center; gap: 10px; 
            background: rgba(34, 197, 94, 0.1); padding: 8px 18px; 
            border-radius: 100px; border: 1px solid rgba(34, 197, 94, 0.3); 
        }
        
        .dot { width: 10px; height: 10px; background: #22c55e; border-radius: 50%; animation: pulse 2s infinite; }
        @keyframes pulse { 0% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.3); opacity: 0.6; } 100% { transform: scale(1); opacity: 1; } }
        
        .grid-system { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: var(--gap); width: 100%; margin-bottom: var(--gap); }
        
        .card, .graph-card { 
            background: var(--card); padding: 32px; border-radius: 28px; 
            border: 1px solid var(--border); backdrop-filter: blur(24px); 
            box-shadow: 0 24px 40px -10px rgba(0, 0, 0, 0.4);
            animation: fade-in-up 0.6s ease-out forwards; opacity: 0;
        }

        .label { color: #94a3b8; font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 8px; }
        .main-val { font-size: 56px; font-weight: 900; margin: 4px 0; display: flex; align-items: baseline; letter-spacing: -2px; }
        .unit { font-size: 22px; font-weight: 600; color: #64748b; margin-left: 8px; }
        
        .minor-line { font-size: 16px; font-weight: 600; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
        .sub-box-4 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding-top: 24px; border-top: 1px solid rgba(255, 255, 255, 0.08); }
        
        .badge { 
            padding: 16px; border-radius: 20px; background: rgba(0, 0, 0, 0.2); 
            display: flex; flex-direction: column; gap: 4px; border: 1px solid rgba(255,255,255,0.03);
        }
        
        .badge-label { font-size: 11px; color: #64748b; text-transform: uppercase; font-weight: 800; }
        .badge-val { font-size: 16px; font-weight: 700; display: flex; align-items: center; flex-wrap: wrap; gap: 4px; }
        
        .time-mark { font-size: 10px; font-weight: 800; color: #94a3b8; background: rgba(255,255,255,0.08); padding: 2px 6px; border-radius: 6px; }
        
        .compass-ui { position: absolute; top: 32px; right: 32px; width: 60px; height: 60px; border: 2px solid rgba(255,255,255,0.1); border-radius: 50%; display: flex; align-items: center; justify-content: center; }
        #needle { width: 4px; height: 38px; background: linear-gradient(to bottom, var(--max-t) 50%, #e2e8f0 50%); clip-path: polygon(50% 0%, 100% 100%, 50% 85%, 0% 100%); transition: transform 1.5s; }
        
        .graph-card { height: 360px; padding: 25px 20px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div><h1>Kk Nagar Weather Hub</h1><div class="live-container"><div class="dot"></div><span id="ts">--:--:--</span></div></div>
        </div>
        <div class="grid-system">
            <div class="card" style="opacity:1">
                <div class="label">Temperature</div>
                <div class="main-val"><span id="t">--</span><span class="unit">°C</span></div>
                <div class="minor-line" style="color:var(--accent)">RealFeel: <span id="rf">--</span>°C</div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Today High</span><span id="mx" class="badge-val" style="color:var(--max-t)">--</span></div>
                    <div class="badge"><span class="badge-label">Today Low</span><span id="mn" class="badge-val" style="color:var(--min-t)">--</span></div>
                    <div class="badge"><span class="badge-label">Humidity</span><span id="h" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Dew Point</span><span id="dp" class="badge-val">--</span></div>
                </div>
            </div>
            <div class="card" style="opacity:1">
                <div class="label">Wind Dynamics</div>
                <div class="compass-ui"><div id="needle"></div></div>
                <div class="main-val"><span id="w">--</span><span class="unit">km/h</span></div>
                <div id="wg" class="minor-line" style="color:var(--wind)">--</div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Max Wind</span><span id="mw" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Max Gust</span><span id="mg" class="badge-val">--</span></div>
                </div>
            </div>
            <div class="card" style="opacity:1">
                <div class="label">Atmospheric</div>
                <div class="main-val"><span id="pr">--</span><span class="unit">hPa</span></div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Solar Rad</span><span id="sol" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">UV Index</span><span id="uv" class="badge-val" style="color:#fbbf24">--</span></div>
                </div>
            </div>
            <div class="card" style="opacity:1">
                <div class="label">Precipitation</div>
                <div class="main-val"><span id="r_rate">--</span><span class="unit">mm/h</span></div>
                <div class="minor-line" style="color:var(--rain)">Total Today: <span id="r_tot">--</span> mm</div>
                <div class="sub-box-4" style="grid-template-columns:1fr">
                    <div class="badge"><span class="badge-label">Max Intensity</span><span id="mr" class="badge-val">--</span></div>
                </div>
            </div>
        </div>
        <div class="grid-system">
            <div class="graph-card" style="opacity:1"><canvas id="cT"></canvas></div>
            <div class="graph-card" style="opacity:1"><canvas id="cH"></canvas></div>
            <div class="graph-card" style="opacity:1"><canvas id="cW"></canvas></div>
            <div class="graph-card" style="opacity:1"><canvas id="cR"></canvas></div>
        </div>
    </div>
    <script>
        let charts = {};
        function setupChart(id, label, col) {
            const ctx = document.getElementById(id).getContext('2d');
            return new Chart(ctx, {
                type: 'line',
                data: { labels: [], datasets: [{ label: label, data: [], borderColor: col, tension: 0.4, pointRadius: 0, borderWidth: 3, fill: true, backgroundColor: col + '22' }] },
                options: { 
                    responsive: true, maintainAspectRatio: false, 
                    plugins: { legend: { labels: { color: '#f8fafc', font: { family: "'Outfit'" } } } },
                    scales: { x: { ticks: { color: '#94a3b8' } }, y: { ticks: { color: '#94a3b8' } } } 
                }
            });
        }

        async function update() {
            try {
                const res = await fetch('/weather?v=' + Date.now());
                const d = await res.json();
                
                document.getElementById('t').innerText = d.temp.current;
                document.getElementById('rf').innerText = d.temp.realFeel;
                document.getElementById('mx').innerHTML = d.temp.max + '°C' + (d.temp.maxTime ? '<span class="time-mark">' + d.temp.maxTime + '</span>' : '');
                document.getElementById('mn').innerHTML = d.temp.min + '°C' + (d.temp.minTime ? '<span class="time-mark">' + d.temp.minTime + '</span>' : '');
                
                document.getElementById('h').innerText = d.atmo.hum + '%';
                document.getElementById('dp').innerText = d.atmo.dew + '°C';
                document.getElementById('pr').innerText = d.atmo.press;
                
                document.getElementById('w').innerText = d.wind.speed;
                document.getElementById('wg').innerText = d.wind.card + ' | Gust ' + d.wind.gust;
                document.getElementById('mw').innerHTML = d.wind.maxS + ' km/h' + (d.wind.maxSTime ? '<span class="time-mark">' + d.wind.maxSTime + '</span>' : '');
                document.getElementById('mg').innerHTML = d.wind.maxG + ' km/h' + (d.wind.maxGTime ? '<span class="time-mark">' + d.wind.maxGTime + '</span>' : '');
                document.getElementById('needle').style.transform = 'rotate(' + d.wind.deg + 'deg)';
                
                document.getElementById('sol').innerText = d.solar.rad + ' W/m²';
                document.getElementById('uv').innerText = d.solar.uvi;
                
                document.getElementById('r_rate').innerText = d.rain.rate;
                document.getElementById('r_tot').innerText = d.rain.total;
                document.getElementById('mr').innerHTML = d.rain.maxR + ' mm/h' + (d.rain.maxRTime ? '<span class="time-mark">' + d.rain.maxRTime + '</span>' : '');
                
                document.getElementById('ts').innerText = new Date(d.lastSync).toLocaleTimeString('en-IN');
                document.body.classList.toggle('solar-low', d.solar.rad <= 0);

                const labels = d.history.map(h => new Date(h.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }));
                if (!charts.cT) {
                    charts.cT = setupChart('cT', 'Temp (°C)', '#38bdf8');
                    charts.cH = setupChart('cH', 'Humidity (%)', '#10b981');
                    charts.cW = setupChart('cW', 'Wind (km/h)', '#fbbf24');
                    charts.cR = setupChart('cR', 'Rain (mm/h)', '#818cf8');
                }
                charts.cT.data.labels = labels; charts.cT.data.datasets[0].data = d.history.map(h => h.temp); charts.cT.update();
                charts.cH.data.labels = labels; charts.cH.data.datasets[0].data = d.history.map(h => h.hum); charts.cH.update();
                charts.cW.data.labels = labels; charts.cW.data.datasets[0].data = d.history.map(h => h.wind); charts.cW.update();
                charts.cR.data.labels = labels; charts.cR.data.datasets[0].data = d.history.map(h => h.rain); charts.cR.update();

            } catch (e) { console.error(e); }
        }
        setInterval(update, 40000); update();
    </script>
</body>
</html>
    `);
});

module.exports = app;

