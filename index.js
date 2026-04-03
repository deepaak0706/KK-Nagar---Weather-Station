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
    maxTemp: -999,
    maxTempTime: null,
    minTemp: 999,
    minTempTime: null,
    maxWindSpeed: 0,
    maxGust: 0,
    maxRainRate: 0,
    lastFetchTime: 0,
    lastDbWrite: 0, 
    lastRainfall: 0,
    lastRainTime: Date.now(),
    currentDate: new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })
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
    const today = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });

    // HYDRATION: Fetch Highs/Lows from DB if state is empty (prevents reset on reload)
    if (state.maxTemp === -999 || state.currentDate !== today) {
        try {
            const recovery = await pool.query(`
                SELECT 
                    MAX(temp_f) as max_tf, MIN(temp_f) as min_tf, 
                    MAX(wind_speed_mph) as max_ws, MAX(wind_gust_mph) as max_wg, 
                    MAX(rain_rate_in) as max_rr
                FROM weather_history 
                WHERE time >= CURRENT_DATE AT TIME ZONE 'Asia/Kolkata'
            `);
            if (recovery.rows[0] && recovery.rows[0].max_tf !== null) {
                const r = recovery.rows[0];
                state.maxTemp = parseFloat(((r.max_tf - 32) * 5 / 9).toFixed(1));
                state.minTemp = parseFloat(((r.min_tf - 32) * 5 / 9).toFixed(1));
                state.maxWindSpeed = parseFloat((r.max_ws * 1.60934).toFixed(1));
                state.maxGust = parseFloat((r.max_wg * 1.60934).toFixed(1));
                state.maxRainRate = parseFloat((r.max_rr || 0).toFixed(1));
                state.currentDate = today;
            }
        } catch (err) { console.error("Recovery Error:", err); }
    }

    if (state.cachedData && (now - state.lastFetchTime < 35000)) return state.cachedData;

    try {
        const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}`;
        const response = await fetch(url);
        const json = await response.json();
        if (!json || !json.data) throw new Error("API Data Unavailable");
        const d = json.data;

        const tempC = parseFloat(((d.outdoor.temperature.value - 32) * 5 / 9).toFixed(1));
        const hum = d.outdoor.humidity.value || 0;
        const press = parseFloat((d.pressure.relative.value * 33.8639).toFixed(1));
        const dailyRain = parseFloat((d.rainfall.daily.value * 25.4).toFixed(1));
        
        let instantRR = 0;
        if (dailyRain > state.lastRainfall) {
            const timeDiffMin = (now - state.lastRainTime) / 60000;
            if (timeDiffMin > 0) instantRR = parseFloat(((0.254 / timeDiffMin) * 60).toFixed(1));
            state.lastRainfall = dailyRain;
            state.lastRainTime = now;
        } else if ((now - state.lastRainTime) > 15 * 60000) { instantRR = 0; }

        const windKmh = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));
        const gustKmh = parseFloat((d.wind.wind_gust.value * 1.60934).toFixed(1));
        const currentTimeStr = new Date(now).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });

        if (tempC > state.maxTemp) { state.maxTemp = tempC; state.maxTempTime = currentTimeStr; }
        if (tempC < state.minTemp) { state.minTemp = tempC; state.minTempTime = currentTimeStr; }
        if (windKmh > state.maxWindSpeed) state.maxWindSpeed = windKmh;
        if (gustKmh > state.maxGust) state.maxGust = gustKmh;
        if (instantRR > state.maxRainRate) state.maxRainRate = instantRR;

        if (now - state.lastDbWrite > 120000) {
            await pool.query(`INSERT INTO weather_history (temp_f, humidity, wind_speed_mph, wind_gust_mph, rain_rate_in, daily_rain_in, solar_radiation, press_rel) 
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, 
                            [d.outdoor.temperature.value, hum, d.wind.wind_speed.value, d.wind.wind_gust.value, instantRR, dailyRain, d.solar_and_uvi?.solar?.value || 0, press]);
            state.lastDbWrite = now;
        }

        const historyRes = await pool.query(`SELECT time, temp_f, humidity as hum, wind_speed_mph as wind, rain_rate_in as rain, press_rel as press 
                                             FROM weather_history WHERE time > NOW() - INTERVAL '24 hours' ORDER BY time ASC`);
        const history = (historyRes.rows || []).map(r => ({
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
            temp: { current: tempC, max: state.maxTemp, maxTime: state.maxTempTime, min: state.minTemp, minTime: state.minTempTime, trend: tTrend, realFeel: calculateRealFeel(tempC, hum) },
            atmo: { hum: hum, hTrend: hTrend, press: press, pTrend: pTrend, dew: parseFloat(((d.outdoor.dew_point.value - 32) * 5 / 9).toFixed(1)) },
            wind: { speed: windKmh, gust: gustKmh, maxS: state.maxWindSpeed, maxG: state.maxGust, card: getCard(d.wind.wind_direction.value), deg: d.wind.wind_direction.value },
            rain: { total: dailyRain, rate: instantRR, maxR: state.maxRainRate },
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
        :root { 
            --bg-1: #020617; --bg-2: #0f172a; --bg-3: #1e293b;
            --card: rgba(15, 23, 42, 0.45); --accent: #38bdf8; 
            --max-t: #fb7185; --min-t: #60a5fa; --wind: #fbbf24; 
            --rain: #818cf8; --border: rgba(255, 255, 255, 0.08);
        }
        * { box-sizing: border-box; -webkit-font-smoothing: antialiased; }
        body { 
            margin: 0; font-family: 'Outfit', sans-serif; background: var(--bg-1);
            background: linear-gradient(-45deg, var(--bg-1), var(--bg-2), var(--bg-3), var(--bg-1));
            background-size: 400% 400%; animation: gradient-pan 20s ease infinite;
            color: #f8fafc; padding: 32px 24px; display: flex; flex-direction: column; align-items: center; min-height: 100vh;
        }
        @keyframes gradient-pan { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }
        .container { width: 100%; max-width: 1200px; z-index: 1; }
        .header { margin-bottom: 40px; display: flex; justify-content: space-between; align-items: center; }
        .live-container { display: inline-flex; align-items: center; gap: 10px; background: rgba(34, 197, 94, 0.1); padding: 8px 18px; border-radius: 100px; border: 1px solid rgba(34, 197, 94, 0.3); backdrop-filter: blur(12px); }
        .dot { width: 10px; height: 10px; background: #22c55e; border-radius: 50%; box-shadow: 0 0 12px #22c55e; animation: pulse 2s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(1.2); } }
        .grid-system { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 24px; margin-bottom: 24px; }
        .card, .graph-card { 
            background: var(--card); padding: 32px; border-radius: 28px; border: 1px solid var(--border); 
            backdrop-filter: blur(24px); box-shadow: 0 24px 40px -10px rgba(0,0,0,0.4); 
            position: relative; transition: transform 0.3s ease;
        }
        .card:hover { transform: translateY(-4px); }
        .label { color: #94a3b8; font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 2px; }
        .main-val { font-size: 56px; font-weight: 900; margin: 8px 0; display: flex; align-items: baseline; }
        .unit { font-size: 22px; color: #64748b; margin-left: 8px; }
        
        /* Modern Trend Icons */
        .trend-pill { 
            display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; 
            border-radius: 12px; font-size: 13px; font-weight: 800; background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.1); margin-bottom: 20px;
        }
        .trend-up { color: #fb7185; text-shadow: 0 0 10px rgba(251,113,131,0.3); }
        .trend-down { color: #34d399; text-shadow: 0 0 10px rgba(52,211,153,0.3); }
        .trend-flat { color: #94a3b8; }

        .sub-box-4 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding-top: 24px; border-top: 1px solid rgba(255,255,255,0.1); }
        .badge { padding: 16px; border-radius: 20px; background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.03); }
        .badge-label { font-size: 11px; color: #64748b; text-transform: uppercase; font-weight: 800; }
        .badge-val { font-size: 16px; font-weight: 700; color: #f1f5f9; display: block; margin-top: 4px; }
        .time-mark { font-size: 10px; color: #64748b; background: rgba(255,255,255,0.05); padding: 2px 5px; border-radius: 4px; margin-left: 4px; }
        
        .compass-ui { position: absolute; top: 32px; right: 32px; width: 60px; height: 60px; border: 2px solid rgba(255,255,255,0.1); border-radius: 50%; background: rgba(0,0,0,0.3); }
        #needle { position: absolute; top: 50%; left: 50%; width: 4px; height: 30px; background: #fb7185; transform-origin: 50% 0; transition: transform 1.5s cubic-bezier(0.34, 1.56, 0.64, 1); clip-path: polygon(50% 100%, 0% 0%, 100% 0%); }
        .graph-card { height: 350px; }
        body.solar-low { background: #010409; animation: none; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div><h1 style="margin:0">Weather Hub</h1><div class="live-container"><div class="dot"></div><span style="color:#22c55e; font-weight:800; font-size:12px">LIVE</span><span id="ts" style="margin-left:8px; font-family:monospace; color:#94a3b8">--:--:--</span></div></div>
        </div>
        <div class="grid-system">
            <div class="card">
                <div class="label">Temperature</div>
                <div class="main-val"><span id="t">--</span><span class="unit">°C</span></div>
                <div id="tr" class="trend-pill">--</div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Today Max</span><span id="mx" class="badge-val" style="color:var(--max-t)">--</span></div>
                    <div class="badge"><span class="badge-label">Today Min</span><span id="mn" class="badge-val" style="color:var(--min-t)">--</span></div>
                    <div class="badge"><span class="badge-label">Humidity</span><span id="h" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Feels Like</span><span id="rf" class="badge-val">--</span></div>
                </div>
            </div>
            <div class="card">
                <div class="label">Wind Dynamics</div>
                <div class="compass-ui"><div id="needle"></div></div>
                <div class="main-val"><span id="w">--</span><span class="unit">km/h</span></div>
                <div id="wg" style="font-weight:700; color:var(--wind); margin-bottom:20px">--</div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Max Wind</span><span id="mw" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Max Gust</span><span id="mg" class="badge-val">--</span></div>
                </div>
            </div>
            <div class="card">
                <div class="label">Atmospheric</div>
                <div class="main-val"><span id="pr">--</span><span class="unit">hPa</span></div>
                <div id="p_status" class="trend-pill">--</div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Solar</span><span id="sol" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">UV Index</span><span id="uv" class="badge-val">--</span></div>
                </div>
            </div>
            <div class="card">
                <div class="label">Precipitation</div>
                <div class="main-val"><span id="r">--</span><span class="unit">mm</span></div>
                <div id="rr" style="font-weight:700; color:var(--rain); margin-bottom:20px">Rate: --</div>
                <div class="sub-box-4" style="grid-template-columns:1fr">
                    <div class="badge"><span class="badge-label">Today Peak Intensity</span><span id="mr" class="badge-val">--</span></div>
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
            const ctx = document.getElementById(id).getContext('2d');
            return new Chart(ctx, {
                type: 'line',
                data: { labels: [], datasets: [{ label: label, data: [], borderColor: col, tension: 0.4, pointRadius: 0, fill: true, backgroundColor: col+'22' }]},
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { grid: { color: 'rgba(255,255,255,0.05)' } } } }
            });
        }

        async function update() {
            try {
                const res = await fetch('/weather?v=' + Date.now());
                const d = await res.json();
                document.getElementById('t').innerText = d.temp.current;
                document.getElementById('mx').innerHTML = d.temp.max + '°' + (d.temp.maxTime ? '<span class="time-mark">'+d.temp.maxTime+'</span>' : '');
                document.getElementById('mn').innerHTML = d.temp.min + '°' + (d.temp.minTime ? '<span class="time-mark">'+d.temp.minTime+'</span>' : '');
                document.getElementById('rf').innerText = d.temp.realFeel + '°C';
                document.getElementById('h').innerText = d.atmo.hum + '%';
                document.getElementById('pr').innerText = d.atmo.press;
                document.getElementById('w').innerText = d.wind.speed;
                document.getElementById('mw').innerText = d.wind.maxS + ' km/h';
                document.getElementById('mg').innerText = d.wind.maxG + ' km/h';
                document.getElementById('wg').innerText = d.wind.card + ' | Gust ' + d.wind.gust + ' km/h';
                document.getElementById('needle').style.transform = 'translate(-50%, -100%) rotate('+d.wind.deg+'deg)';
                document.getElementById('sol').innerText = d.solar.rad + ' W/m²';
                document.getElementById('uv').innerText = d.solar.uvi;
                document.getElementById('r').innerText = d.rain.total;
                document.getElementById('rr').innerText = 'Rain Rate: ' + d.rain.rate + ' mm/h';
                document.getElementById('mr').innerText = d.rain.maxR + ' mm/h';
                document.getElementById('ts').innerText = new Date(d.lastSync).toLocaleTimeString('en-IN', {hour12:false});

                // Modern Trends
                const tTrend = d.temp.trend;
                const trEl = document.getElementById('tr');
                if(tTrend > 0.1) trEl.className = 'trend-pill trend-up', trEl.innerHTML = '▲ ' + tTrend + '°/hr Rising';
                else if(tTrend < -0.1) trEl.className = 'trend-pill trend-down', trEl.innerHTML = '▼ ' + Math.abs(tTrend) + '°/hr Cooling';
                else trEl.className = 'trend-pill trend-flat', trEl.innerHTML = '● Stable';

                const pTrend = d.atmo.pTrend;
                const prEl = document.getElementById('p_status');
                if(pTrend > 0.05) prEl.className = 'trend-pill trend-down', prEl.innerText = 'High Pressure Rising';
                else if(pTrend < -0.05) prEl.className = 'trend-pill trend-up', prEl.innerText = 'Storm Warning / Falling';
                else prEl.className = 'trend-pill trend-flat', prEl.innerText = 'Pressure Stable';

                document.body.classList.toggle('solar-low', d.solar.rad <= 5);

                // Charts
                if(!charts.cT) { charts.cT = setupChart('cT', 'Temp', '#38bdf8'); charts.cH = setupChart('cH', 'Humidity', '#10b981'); }
                const labels = d.history.map(h => new Date(h.time).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}));
                charts.cT.data.labels = labels; charts.cT.data.datasets[0].data = d.history.map(h => h.temp); charts.cT.update();
                charts.cH.data.labels = labels; charts.cH.data.datasets[0].data = d.history.map(h => h.hum); charts.cH.update();

            } catch (e) { console.log(e); }
        }
        setInterval(update, 35000); update();
    </script>
</body>
</html>
    `);
});

module.exports = app;
