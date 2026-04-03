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
    if (state.cachedData && (now - state.lastFetchTime < 35000)) return state.cachedData;

    try {
        const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}`;
        const response = await fetch(url);
        const json = await response.json();
        if (!json.data) throw new Error("API Response Empty");
        const d = json.data;

        const tempC = parseFloat(((d.outdoor.temperature.value - 32) * 5 / 9).toFixed(1));
        const hum = parseInt(d.outdoor.humidity.value);
        const press = parseFloat((d.pressure.relative.value * 33.8639).toFixed(1));
        const dailyRain = parseFloat(((d.rain?.daily?.value || d.rainfall?.daily?.value || 0) * 25.4).toFixed(1));
        const windKmh = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));
        const gustKmh = parseFloat((d.wind.wind_gust.value * 1.60934).toFixed(1));
        const solar = d.solar_and_uvi?.solar?.value || 0;
        const uvi = d.solar_and_uvi?.uvi?.value || 0;

        let instantRR = 0;
        if (dailyRain > state.lastRainfall) {
            const timeDiffMin = (now - state.lastRainTime) / 60000;
            if (timeDiffMin > 0) instantRR = parseFloat(((0.254 / timeDiffMin) * 60).toFixed(1));
            state.lastRainfall = dailyRain;
            state.lastRainTime = now;
        } else if ((now - state.lastRainTime) > 15 * 60000) { instantRR = 0; }

        const today = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
        const currentTimeStr = new Date(now).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });

        if (state.currentDate !== today) {
            state.currentDate = today;
            state.maxTemp = -999; state.minTemp = 999; state.maxWindSpeed = 0; state.maxGust = 0; state.maxRainRate = 0;
        }

        if (tempC > state.maxTemp || state.maxTemp === -999) { state.maxTemp = tempC; state.maxTempTime = currentTimeStr; }
        if (tempC < state.minTemp || state.minTemp === 999) { state.minTemp = tempC; state.minTempTime = currentTimeStr; }
        if (windKmh > state.maxWindSpeed) state.maxWindSpeed = windKmh;
        if (gustKmh > state.maxGust) state.maxGust = gustKmh;
        if (instantRR > state.maxRainRate) state.maxRainRate = instantRR;

        pool.query(`INSERT INTO weather_history (temp_f, humidity, wind_speed_mph, wind_gust_mph, rain_rate_in, daily_rain_in, solar_radiation, press_rel) 
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, 
                    [d.outdoor.temperature.value, hum, d.wind.wind_speed.value, d.wind.wind_gust.value, instantRR, dailyRain, solar, press]).catch(e => console.error("DB Insert", e));

        const historyRes = await pool.query(`SELECT time, temp_f, humidity as hum, wind_speed_mph as wind, rain_rate_in as rain, press_rel as press 
                                             FROM weather_history WHERE time > NOW() - INTERVAL '24 hours' ORDER BY time ASC`);

        const history = historyRes.rows.map(r => ({
            time: r.time,
            temp: parseFloat(((r.temp_f - 32) * 5 / 9).toFixed(1)),
            hum: r.hum,
            press: r.press || press,
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
            solar: { rad: solar, uvi: uvi },
            lastSync: d.time || new Date().toISOString(),
            history: history
        };
        state.lastFetchTime = now;
        return state.cachedData;
    } catch (e) { 
        console.error("Sync Error:", e);
        return state.cachedData || { error: "Update failed" }; 
    }
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
        body.solar-low { background: #000; color: #cbd5e1; animation: none; }
        .container { width: 100%; max-width: 1200px; z-index: 1; position: relative; }
        .header { margin-bottom: 40px; display: flex; justify-content: space-between; align-items: center; width: 100%; }
        .header h1 { margin: 0; font-size: 32px; font-weight: 900; letter-spacing: -1px; }
        .live-container { 
            display: inline-flex; align-items: center; gap: 10px; background: rgba(34, 197, 94, 0.1); 
            padding: 8px 18px; border-radius: 100px; border: 1px solid rgba(34, 197, 94, 0.3); backdrop-filter: blur(12px);
        }
        .dot { width: 10px; height: 10px; background: #22c55e; border-radius: 50%; animation: pulse 2s infinite; }
        @keyframes pulse { 0% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.3); opacity: 0.6; } 100% { transform: scale(1); opacity: 1; } }
        .grid-system { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: var(--gap); width: 100%; margin-bottom: var(--gap); }
        .card, .graph-card { 
            background: var(--card); padding: 32px; border-radius: 28px; border: 1px solid var(--border); 
            backdrop-filter: blur(24px); box-shadow: 0 24px 40px -10px rgba(0, 0, 0, 0.4); 
            animation: fade-in-up 0.6s ease-out forwards; opacity: 0; transition: transform 0.3s ease;
        }
        .card:hover { transform: translateY(-4px); }
        .label { color: #94a3b8; font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 2px; }
        .main-val { font-size: 56px; font-weight: 900; margin: 4px 0; display: flex; align-items: baseline; letter-spacing: -2px; }
        .unit { font-size: 22px; font-weight: 600; color: #64748b; margin-left: 8px; }
        
        /* MODERN TREND BADGE */
        .trend-pill { 
            font-size: 12px; font-weight: 900; margin-bottom: 24px; 
            display: inline-flex; align-items: center; gap: 6px; 
            padding: 6px 14px; border-radius: 100px;
            background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
        }
        .trend-up { color: #f87171; background: rgba(248, 113, 113, 0.1); border-color: rgba(248, 113, 113, 0.2); }
        .trend-down { color: #38bdf8; background: rgba(56, 189, 248, 0.1); border-color: rgba(56, 189, 248, 0.2); }
        .indicator-small { font-size: 11px; font-weight: 800; padding: 4px 10px; border-radius: 6px; margin-top: 8px; display: inline-block; }
        .inc { background: rgba(248, 113, 113, 0.15); color: #f87171; }
        .dec { background: rgba(56, 189, 248, 0.15); color: #38bdf8; }
        .neu { background: rgba(255,255,255,0.05); color: #94a3b8; }

        .sub-box-4 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding-top: 24px; border-top: 1px solid rgba(255, 255, 255, 0.08); }
        .badge { padding: 16px; border-radius: 20px; background: rgba(0, 0, 0, 0.2); display: flex; flex-direction: column; gap: 8px; border: 1px solid rgba(255,255,255,0.03); }
        .badge-label { font-size: 11px; color: #64748b; font-weight: 800; }
        .badge-val { font-size: 16px; font-weight: 700; color: #f1f5f9; }
        .time-mark { font-size: 10px; font-weight: 800; color: #94a3b8; background: rgba(255,255,255,0.08); padding: 2px 6px; border-radius: 6px; margin-left: 4px; }
        .compass-ui { position: absolute; top: 32px; right: 32px; width: 60px; height: 60px; border: 2px solid rgba(255,255,255,0.1); border-radius: 50%; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.4); }
        #needle { width: 4px; height: 38px; background: linear-gradient(to bottom, var(--max-t) 50%, #e2e8f0 50%); clip-path: polygon(50% 0%, 100% 100%, 50% 85%, 0% 100%); transition: transform 1.5s cubic-bezier(0.34, 1.56, 0.64, 1); }
        .graph-card { height: 360px; }
        .glow-wind { border-color: rgba(251, 191, 36, 0.4); box-shadow: 0 0 20px rgba(251, 191, 36, 0.1); }
        .glow-rain { border-color: rgba(129, 140, 248, 0.4); box-shadow: 0 0 20px rgba(129, 140, 248, 0.1); }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div>
                <h1>Kk Nagar Weather Hub</h1>
                <div class="live-container">
                    <div class="dot"></div><span style="color:#22c55e; font-weight:800; font-size:13px">LIVE</span><span id="ts" style="margin-left:10px; font-family:monospace; color:#94a3b8">--:--:--</span>
                </div>
            </div>
        </div>
        <div class="grid-system">
            <div class="card" id="card-temp" style="opacity:1">
                <div class="label">Temperature</div>
                <div class="main-val"><span id="t">--</span><span class="unit">°C</span></div>
                <div style="color:var(--accent); font-weight:600; margin-bottom:12px; font-size:14px">RealFeel: <span id="rf">--</span>°C</div>
                <div id="tr_pill" class="trend-pill">--</div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Today High</span><span id="mx" class="badge-val" style="color:var(--max-t)">--</span></div>
                    <div class="badge"><span class="badge-label">Today Low</span><span id="mn" class="badge-val" style="color:var(--min-t)">--</span></div>
                    <div class="badge">
                        <span class="badge-label">Humidity</span><span id="h" class="badge-val">--</span>
                        <span id="h_ind" class="indicator-small">--</span>
                    </div>
                    <div class="badge"><span class="badge-label">Dew Point</span><span id="dp" class="badge-val">--</span></div>
                </div>
            </div>
            <div class="card" id="card-wind" style="opacity:1">
                <div class="label">Wind Dynamics</div>
                <div class="compass-ui"><div id="needle"></div></div>
                <div class="main-val"><span id="w">--</span><span class="unit">km/h</span></div>
                <div id="wg" style="color:var(--wind); font-weight:600; font-size:14px">--</div>
                <div class="sub-box-4" style="margin-top:28px">
                    <div class="badge"><span class="badge-label">Max wind</span><span id="mw" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Max Gust</span><span id="mg" class="badge-val">--</span></div>
                </div>
            </div>
            <div class="card" style="opacity:1">
                <div class="label">Atmospheric</div>
                <div class="main-val"><span id="pr">--</span><span class="unit">hPa</span></div>
                <div id="p_ind" class="indicator-small" style="margin-bottom:15px">--</div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Solar Rad</span><span id="sol" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">UV Index</span><span id="uv" class="badge-val" style="color:#fbbf24">--</span></div>
                </div>
            </div>
            <div class="card" id="card-rain" style="opacity:1">
                <div class="label">Precipitation</div>
                <div class="main-val"><span id="r">--</span><span class="unit">mm</span></div>
                <div id="rr_main" style="color:var(--rain); font-weight:600; font-size:14px; margin-bottom:12px">Rate: -- mm/h</div>
                <div class="sub-box-4" style="grid-template-columns: 1fr;"><div class="badge"><span class="badge-label">Max Intensity</span><span id="mr" class="badge-val" style="color:var(--rain)">--</span></div></div>
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
        function setupChart(id, label, col, minZero = false) {
            const ctx = document.getElementById(id).getContext('2d');
            return new Chart(ctx, {
                type: 'line',
                data: { labels: [], datasets: [{ label: label, data: [], borderColor: col, tension: 0.4, pointRadius: 0, fill: true, backgroundColor: col + '22' }]},
                options: { 
                    responsive: true, maintainAspectRatio: false, 
                    plugins: { legend: { labels: { color: '#f8fafc', font: { family: 'Outfit', weight: '600' } } } },
                    scales: { x: { ticks: { color: '#64748b' }, grid: { display: false } }, y: { beginAtZero: minZero, ticks: { color: '#64748b' }, grid: { color: 'rgba(255,255,255,0.05)' } } }
                }
            });
        }

        async function update() {
            try {
                const res = await fetch('/weather');
                const d = await res.json();
                
                // Temp & Trend
                document.getElementById('t').innerText = d.temp.current;
                document.getElementById('rf').innerText = d.temp.realFeel;
                const tp = document.getElementById('tr_pill');
                tp.innerText = (d.temp.trend > 0 ? '↑ ' : '↓ ') + Math.abs(d.temp.trend).toFixed(1) + '°C/hr Trend';
                tp.className = 'trend-pill ' + (d.temp.trend > 0 ? 'trend-up' : 'trend-down');
                
                document.getElementById('mx').innerHTML = d.temp.max + '° <span class="time-mark">'+d.temp.maxTime+'</span>';
                document.getElementById('mn').innerHTML = d.temp.min + '° <span class="time-mark">'+d.temp.minTime+'</span>';
                
                // Humidity & Trend
                document.getElementById('h').innerText = d.atmo.hum + '%';
                const hInd = document.getElementById('h_ind');
                if(d.atmo.hTrend > 0.5) { hInd.innerText = 'Increasing'; hInd.className = 'indicator-small inc'; }
                else if(d.atmo.hTrend < -0.5) { hInd.innerText = 'Decreasing'; hInd.className = 'indicator-small dec'; }
                else { hInd.innerText = 'Stable'; hInd.className = 'indicator-small neu'; }

                document.getElementById('dp').innerText = d.atmo.dew + '°C';
                
                // Pressure & Trend
                document.getElementById('pr').innerText = Math.round(d.atmo.press);
                const pInd = document.getElementById('p_ind');
                if(d.atmo.pTrend > 0.1) { pInd.innerText = 'High Pressure Rising'; pInd.className = 'indicator-small inc'; }
                else if(d.atmo.pTrend < -0.1) { pInd.innerText = 'Low Pressure Falling'; pInd.className = 'indicator-small dec'; }
                else { pInd.innerText = 'Barometer Stable'; pInd.className = 'indicator-small neu'; }

                document.getElementById('w').innerText = d.wind.speed;
                document.getElementById('wg').innerText = d.wind.card + ' | Gust ' + d.wind.gust;
                document.getElementById('mw').innerText = d.wind.maxS + ' km/h';
                document.getElementById('mg').innerText = d.wind.maxG + ' km/h';
                document.getElementById('needle').style.transform = 'rotate('+d.wind.deg+'deg)';
                
                document.getElementById('sol').innerText = d.solar.rad + ' W/m²';
                document.getElementById('uv').innerText = d.solar.uvi;
                document.getElementById('r').innerText = d.rain.total;
                document.getElementById('rr_main').innerText = 'Rate: ' + d.rain.rate + ' mm/h';
                document.getElementById('mr').innerText = d.rain.maxR + ' mm/h';
                document.getElementById('ts').innerText = new Date(d.lastSync).toLocaleTimeString('en-IN', { hour12: false });
                
                document.body.classList.toggle('solar-low', d.solar.rad <= 0);
                document.getElementById('card-wind').classList.toggle('glow-wind', d.wind.speed > 12);
                document.getElementById('card-rain').classList.toggle('glow-rain', d.rain.rate > 0);

                const labels = d.history.map(h => new Date(h.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }));
                if (!charts.cT) {
                    charts.cT = setupChart('cT', 'Temp (°C)', '#38bdf8');
                    charts.cH = setupChart('cH', 'Humidity (%)', '#10b981', true);
                    charts.cW = setupChart('cW', 'Wind (km/h)', '#fbbf24', true);
                    charts.cR = setupChart('cR', 'Rain (mm/h)', '#818cf8', true);
                }
                charts.cT.data.labels = labels; charts.cT.data.datasets[0].data = d.history.map(h => h.temp); charts.cT.update();
                charts.cH.data.labels = labels; charts.cH.data.datasets[0].data = d.history.map(h => h.hum); charts.cH.update();
                charts.cW.data.labels = labels; charts.cW.data.datasets[0].data = d.history.map(h => h.wind); charts.cW.update();
                charts.cR.data.labels = labels; charts.cR.data.datasets[0].data = d.history.map(h => h.rain); charts.cR.update();
            } catch (e) {}
        }
        setInterval(update, 40000); update();
    </script>
</body>
</html>
    `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Station ready on port", PORT));
