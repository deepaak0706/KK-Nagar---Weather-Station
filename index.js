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
    if (state.cachedData && (now - state.lastFetchTime < 45000)) return state.cachedData;

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

        if (now - state.lastDbWrite > 120000) {
            pool.query(`INSERT INTO weather_history (temp_f, humidity, wind_speed_mph, wind_gust_mph, rain_rate_in, daily_rain_in, solar_radiation, press_rel) 
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, 
                        [d.outdoor.temperature.value, hum, d.wind.wind_speed.value, d.wind.wind_gust.value, instantRR, dailyRain, solar, press])
                .then(() => { state.lastDbWrite = now; })
                .catch(e => console.error("DB Write Failed:", e.message));
        }

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
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;900&display=swap" rel="stylesheet">
    <style>
        :root { 
            --bg-1: #020617; --bg-2: #0f172a; --card: rgba(15, 23, 42, 0.6); 
            --accent: #38bdf8; --max-t: #f43f5e; --min-t: #3b82f6; 
            --wind: #fbbf24; --rain: #818cf8; --border: rgba(255, 255, 255, 0.08); 
        }
        body { 
            margin: 0; font-family: 'Outfit', sans-serif; background: var(--bg-1); color: #f8fafc; 
            padding: 24px; display: flex; flex-direction: column; align-items: center;
        }
        .container { width: 100%; max-width: 1200px; }
        .header { margin-bottom: 30px; display: flex; justify-content: space-between; align-items: center; }
        .header h1 { font-size: 28px; font-weight: 900; margin:0; }
        .live-container { display: flex; align-items: center; gap: 8px; background: rgba(34, 197, 94, 0.1); padding: 6px 14px; border-radius: 50px; border: 1px solid rgba(34, 197, 94, 0.2); }
        .dot { width: 8px; height: 8px; background: #22c55e; border-radius: 50%; }
        
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; width: 100%; margin-bottom: 20px; }
        .card, .graph-card { background: var(--card); padding: 28px; border-radius: 24px; border: 1px solid var(--border); backdrop-filter: blur(10px); position: relative; }
        
        .label { color: #94a3b8; font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 1px; }
        .main-val { font-size: 48px; font-weight: 900; margin: 5px 0; letter-spacing: -1px; }
        .unit { font-size: 20px; color: #64748b; margin-left: 5px; }

        .trend-icon { font-size: 20px; font-weight: 900; display: inline-block; vertical-align: middle; margin-left: 5px; }
        .up { color: #f43f5e; }
        .down { color: #38bdf8; }
        .stable { color: #64748b; }

        .sub-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 20px; padding-top: 20px; border-top: 1px solid var(--border); }
        .badge { background: rgba(0,0,0,0.2); padding: 12px; border-radius: 16px; display: flex; flex-direction: column; gap: 4px; }
        .b-label { font-size: 10px; color: #64748b; font-weight: 800; text-transform: uppercase; }
        .b-val { font-size: 15px; font-weight: 700; }
        
        .compass { position: absolute; top: 25px; right: 25px; width: 50px; height: 50px; border: 1px solid var(--border); border-radius: 50%; display: flex; align-items: center; justify-content: center; background: #000; }
        #needle { width: 3px; height: 30px; background: linear-gradient(to bottom, var(--max-t) 50%, #fff 50%); clip-path: polygon(50% 0%, 100% 100%, 50% 80%, 0% 100%); transition: transform 1s; }
        .graph-card { height: 320px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>KK Nagar Hub</h1>
            <div class="live-container"><div class="dot"></div><span id="ts" style="font-size:12px; color:#94a3b8">--:--</span></div>
        </div>

        <div class="grid">
            <div class="card">
                <div class="label">Temperature <span id="t_icon" class="trend-icon">→</span></div>
                <div class="main-val"><span id="t">--</span><span class="unit">°C</span></div>
                <div style="font-size:13px; color:var(--accent); font-weight:600">Feels Like <span id="rf">--</span>°C</div>
                <div class="sub-grid">
                    <div class="badge"><span class="b-label">High</span><span id="mx" class="b-val" style="color:var(--max-t)">--</span></div>
                    <div class="badge"><span class="b-label">Low</span><span id="mn" class="b-val" style="color:var(--min-t)">--</span></div>
                </div>
            </div>

            <div class="card">
                <div class="label">Humidity <span id="h_icon" class="trend-icon">→</span></div>
                <div class="main-val"><span id="h">--</span><span class="unit">%</span></div>
                <div style="font-size:13px; color:#94a3b8">Dew point: <span id="dp">--</span>°C</div>
                <div class="sub-grid" style="grid-template-columns:1fr"><div class="badge"><span class="b-label">Comfort</span><span id="comf" class="b-val">--</span></div></div>
            </div>

            <div class="card">
                <div class="label">Wind Speed</div>
                <div class="compass"><div id="needle"></div></div>
                <div class="main-val"><span id="w">--</span><span class="unit">km/h</span></div>
                <div id="wg" style="font-size:13px; color:var(--wind); font-weight:600">--</div>
                <div class="sub-grid">
                    <div class="badge"><span class="b-label">Max S</span><span id="mw" class="b-val">--</span></div>
                    <div class="badge"><span class="b-label">Max G</span><span id="mg" class="b-val">--</span></div>
                </div>
            </div>

            <div class="card">
                <div class="label">Barometer <span id="p_icon" class="trend-icon">→</span></div>
                <div class="main-val"><span id="pr">--</span><span class="unit">hPa</span></div>
                <div class="sub-grid">
                    <div class="badge"><span class="b-label">Solar</span><span id="sol" class="b-val">--</span></div>
                    <div class="badge"><span class="b-label">UV</span><span id="uv" class="b-val">--</span></div>
                </div>
            </div>
        </div>

        <div class="grid">
            <div class="graph-card"><canvas id="cT"></canvas></div>
            <div class="graph-card"><canvas id="cH"></canvas></div>
            <div class="graph-card"><canvas id="cW"></canvas></div>
            <div class="graph-card"><canvas id="cR"></canvas></div>
        </div>
    </div>

    <script>
        let charts = {};
        function updateTrend(val, threshold, elementId) {
            const el = document.getElementById(elementId);
            if (val > threshold) { el.innerText = '↑'; el.className = 'trend-icon up'; }
            else if (val < -threshold) { el.innerText = '↓'; el.className = 'trend-icon down'; }
            else { el.innerText = '→'; el.className = 'trend-icon stable'; }
        }

        function setupChart(id, label, col) {
            const ctx = document.getElementById(id).getContext('2d');
            return new Chart(ctx, {
                type: 'line',
                data: { labels: [], datasets: [{ label: label, data: [], borderColor: col, tension: 0.3, pointRadius: 0, fill: true, backgroundColor: col + '11' }]},
                options: { 
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: { x: { ticks: { display: false }, grid: { display: false } }, y: { ticks: { color: '#64748b', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.03)' } } }
                }
            });
        }

        async function update() {
            try {
                const res = await fetch('/weather');
                const d = await res.json();
                document.getElementById('t').innerText = d.temp.current;
                document.getElementById('rf').innerText = d.temp.realFeel;
                updateTrend(d.temp.trend, 0.2, 't_icon');
                document.getElementById('mx').innerText = d.temp.max + '°';
                document.getElementById('mn').innerText = d.temp.min + '°';
                document.getElementById('h').innerText = d.atmo.hum;
                document.getElementById('dp').innerText = d.atmo.dew;
                updateTrend(d.atmo.hTrend, 0.5, 'h_icon');
                document.getElementById('comf').innerText = d.atmo.hum < 40 ? 'Dry' : (d.atmo.hum > 70 ? 'Humid' : 'Ideal');
                document.getElementById('pr').innerText = Math.round(d.atmo.press);
                updateTrend(d.atmo.pTrend, 0.1, 'p_icon');
                document.getElementById('w').innerText = d.wind.speed;
                document.getElementById('wg').innerText = d.wind.card + ' | Gust ' + d.wind.gust;
                document.getElementById('mw').innerText = d.wind.maxS + ' km/h';
                document.getElementById('mg').innerText = d.wind.maxG + ' km/h';
                document.getElementById('needle').style.transform = 'rotate('+d.wind.deg+'deg)';
                document.getElementById('sol').innerText = d.solar.rad;
                document.getElementById('uv').innerText = d.solar.uvi;
                document.getElementById('ts').innerText = 'Synced: ' + new Date(d.lastSync).toLocaleTimeString('en-IN', { hour12: false });

                const labels = d.history.map(h => '');
                if (!charts.cT) {
                    charts.cT = setupChart('cT', 'Temp', '#38bdf8');
                    charts.cH = setupChart('cH', 'Humid', '#10b981');
                    charts.cW = setupChart('cW', 'Wind', '#fbbf24');
                    charts.cR = setupChart('cR', 'Rain', '#818cf8');
                }
                charts.cT.data.labels = labels; charts.cT.data.datasets[0].data = d.history.map(h => h.temp); charts.cT.update();
                charts.cH.data.labels = labels; charts.cH.data.datasets[0].data = d.history.map(h => h.hum); charts.cH.update();
                charts.cW.data.labels = labels; charts.cW.data.datasets[0].data = d.history.map(h => h.wind); charts.cW.update();
                charts.cR.data.labels = labels; charts.cR.data.datasets[0].data = d.history.map(h => h.rain); charts.cR.update();
            } catch (e) {}
        }
        setInterval(update, 45000); 
        update();
    </script>
</body>
</html>
    `);
});

app.listen(process.env.PORT || 3000);
