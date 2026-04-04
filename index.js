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

let state = { cachedData: null, lastFetchTime: 0, lastDbWrite: 0 };

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
        const liveHum = d.outdoor.humidity.value || 0;
        const livePress = parseFloat((d.pressure.relative.value * 33.8639).toFixed(1));
        const liveWind = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));
        const liveGust = parseFloat((d.wind.wind_gust.value * 1.60934).toFixed(1));
        const liveRainTotal = parseFloat((d.rainfall.daily.value * 25.4).toFixed(1));
        const liveRainRate = parseFloat(((d.rainfall.rain_rate?.value || 0) * 25.4).toFixed(1));

        if (forceWrite || (now - state.lastDbWrite > 120000)) {
            await pool.query(`INSERT INTO weather_history (time, temp_f, humidity, wind_speed_mph, wind_gust_mph, daily_rain_in, solar_radiation, press_rel, rain_rate_in) VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8)`, 
            [d.outdoor.temperature.value, liveHum, d.wind.wind_speed.value, d.wind.wind_gust.value, d.rainfall.daily.value, d.solar_and_uvi?.solar?.value || 0, livePress, d.rainfall.rain_rate?.value || 0]);
            state.lastDbWrite = now;
        }

        const historyRes = await pool.query(`SELECT * FROM weather_history WHERE time >= (CURRENT_DATE AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') ORDER BY time ASC`);
        
        let mx_t = -999, mn_t = 999, mx_t_time = "--:--", mn_t_time = "--:--", mx_w = 0, mx_w_t = "--:--", mx_g = 0, mx_g_t = "--:--", mx_r = 0, mx_r_t = "--:--", pTrend = 0, hTrend = 0;
        let graphHistory = [];

        if (historyRes.rows.length > 0) {
            const lastRow = historyRes.rows[historyRes.rows.length - 1];
            pTrend = parseFloat((livePress - (lastRow.press_rel || livePress)).toFixed(1));
            hTrend = liveHum - (lastRow.humidity || liveHum);

            historyRes.rows.forEach(r => {
                const r_time = new Date(r.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
                const r_temp = parseFloat(((r.temp_f - 32) * 5 / 9).toFixed(1));
                const r_wind = parseFloat((r.wind_speed_mph * 1.60934).toFixed(1));
                const r_rain_daily = parseFloat((r.daily_rain_in * 25.4).toFixed(1));
                const r_rain_rate = parseFloat((r.rain_rate_in * 25.4).toFixed(1));

                if (r_temp >= mx_t) { mx_t = r_temp; mx_t_time = r_time; }
                if (r_temp <= mn_t) { mn_t = r_temp; mn_t_time = r_time; }
                if (r_wind >= mx_w) { mx_w = r_wind; mx_w_t = r_time; }
                if (r_rain_rate > mx_r) { mx_r = r_rain_rate; mx_r_t = r_time; }

                graphHistory.push({ time: r.time, temp: r_temp, hum: r.humidity, wind: r_wind, rain: r_rain_daily });
            });
        }

        state.cachedData = {
            temp: { current: liveTemp, max: mx_t, maxTime: mx_t_time, min: mn_t, minTime: mn_t_time, realFeel: calculateRealFeel(liveTemp, liveHum) },
            atmo: { hum: liveHum, hTrend, press: livePress, pTrend },
            wind: { speed: liveWind, gust: liveGust, maxS: mx_w, maxSTime: mx_w_t, maxG: mx_g, maxGTime: mx_g_t, deg: d.wind.wind_direction.value, card: getCard(d.wind.wind_direction.value) },
            rain: { total: liveRainTotal, rate: liveRainRate, maxR: mx_r, maxRTime: mx_r_t },
            solar: { rad: d.solar_and_uvi?.solar?.value || 0, uvi: d.solar_and_uvi?.uvi?.value || 0 },
            history: graphHistory,
            lastSync: new Date().toISOString()
        };
        state.lastFetchTime = now;
        return state.cachedData;
    } catch (e) { return state.cachedData || { error: e.message }; }
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
        :root { --bg-1: #020617; --card: rgba(15, 23, 42, 0.45); --accent: #38bdf8; --max-t: #fb7185; --min-t: #60a5fa; --border: rgba(255, 255, 255, 0.08); }
        body { margin: 0; font-family: 'Outfit', sans-serif; background: var(--bg-1); color: #f8fafc; padding: 32px 24px; display: flex; flex-direction: column; align-items: center; }
        .container { width: 100%; max-width: 1200px; }
        .header { margin-bottom: 40px; display: flex; justify-content: space-between; align-items: center; width: 100%; }
        .header h1 { font-size: 28px; font-weight: 800; margin: 0; background: linear-gradient(to right, #f8fafc, #94a3b8); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .status-bar { display: flex; align-items: center; gap: 12px; background: rgba(255,255,255,0.03); padding: 8px 16px; border-radius: 100px; border: 1px solid var(--border); }
        .live-dot { width: 8px; height: 8px; background: #10b981; border-radius: 50%; box-shadow: 0 0 12px #10b981; animation: blink 1.5s infinite; }
        @keyframes blink { 0% { opacity: 1; } 50% { opacity: 0.3; } 100% { opacity: 1; } }
        .timestamp { font-size: 13px; font-weight: 700; color: #94a3b8; font-variant-numeric: tabular-nums; }
        .grid-system { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 24px; margin-bottom: 24px; }
        .card, .graph-card { background: var(--card); padding: 32px; border-radius: 28px; border: 1px solid var(--border); backdrop-filter: blur(24px); position: relative; }
        .label { color: #94a3b8; font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 8px; }
        .main-val { font-size: 56px; font-weight: 900; margin: 4px 0; display: flex; align-items: baseline; letter-spacing: -2px; }
        .unit { font-size: 22px; font-weight: 600; color: #64748b; margin-left: 8px; }
        .sub-box-4 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding-top: 24px; border-top: 1px solid rgba(255, 255, 255, 0.08); }
        .badge { padding: 16px; border-radius: 20px; background: rgba(0, 0, 0, 0.2); display: flex; flex-direction: column; gap: 4px; }
        .badge-label { font-size: 11px; color: #64748b; text-transform: uppercase; font-weight: 800; }
        .badge-val { font-size: 16px; font-weight: 700; }
        .time-mark { font-size: 10px; font-weight: 800; color: #94a3b8; background: rgba(255,255,255,0.08); padding: 2px 6px; border-radius: 6px; margin-left: 4px; }
        .compass-ui { position: absolute; top: 32px; right: 32px; width: 64px; height: 64px; border: 2px solid rgba(255,255,255,0.1); border-radius: 50%; display: flex; align-items: center; justify-content: center; }
        #needle { width: 4px; height: 40px; background: linear-gradient(to bottom, var(--max-t) 50%, #e2e8f0 50%); clip-path: polygon(50% 0%, 100% 100%, 50% 85%, 0% 100%); transition: transform 1.5s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
        .graph-card { height: 360px; margin-bottom: 24px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>KK Nagar Weather Hub</h1>
            <div class="status-bar">
                <div class="live-dot"></div>
                <div class="timestamp">LIVE: <span id="ts">--:--:--</span></div>
            </div>
        </div>

        <div class="grid-system">
            <div class="card">
                <div class="label">Temperature</div>
                <div class="main-val"><span id="t">--</span><span class="unit">°C</span></div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Today High</span><span id="mx" class="badge-val" style="color:var(--max-t)">--</span></div>
                    <div class="badge"><span class="badge-label">Today Low</span><span id="mn" class="badge-val" style="color:var(--min-t)">--</span></div>
                    <div class="badge"><span class="badge-label">RealFeel</span><span id="rf" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Humidity <span id="hIcon"></span></span><span id="h" class="badge-val">--</span></div>
                </div>
            </div>
            
            <div class="card">
                <div class="label">Wind Dynamics</div>
                <div class="compass-ui"><div id="needle"></div></div>
                <div class="main-val"><span id="w">--</span><span class="unit">km/h</span></div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Gust</span><span id="wg" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Direction</span><span id="wd" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Max Wind</span><span id="mw" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Max Gust</span><span id="mg" class="badge-val">--</span></div>
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

            <div class="card">
                <div class="label">Precipitation</div>
                <div class="main-val"><span id="r_rate">--</span><span class="unit">mm/h</span></div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Daily Total</span><span id="r_tot" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Max Intensity</span><span id="mr" class="badge-val">--</span></div>
                </div>
            </div>
        </div>

        <div class="graph-card"><canvas id="cT"></canvas></div>
        <div class="graph-card"><canvas id="cH"></canvas></div>
        <div class="graph-card"><canvas id="cW"></canvas></div>
        <div class="graph-card"><canvas id="cR"></canvas></div>
    </div>

    <script>
        let charts = {};
        let lastGraphUpdate = 0;

        function setupChart(id, label, color, type='line') {
    const ctx = document.getElementById(id);
    if (!ctx) return null;
    return new Chart(ctx, {
        type: type,
        data: { labels: [], datasets: [{ label: label, data: [], borderColor: color, backgroundColor: color+'22', fill: true, tension: 0.4, pointRadius: 0 }] },
        options: { 
            responsive: true, 
            maintainAspectRatio: false,
            scales: {
                y: {
                    beginAtZero: true, // Forces the chart to start at 0
                    min: 0,            // Prevents negative numbers from showing
                    ticks: {
                        precision: 1    // Keeps the numbers clean
                    }
                }
            }
        }
    });
}


        async function update() {
            try {
                const now = Date.now();
                const res = await fetch('/weather?v=' + now);
                const d = await res.json();
                
                if (!d || d.error) return;

                document.getElementById('t').innerText = d.temp.current || '--';
                document.getElementById('mx').innerHTML = (d.temp.max || '--') + '°' + (d.temp.maxTime != "--:--" ? '<span class="time-mark">' + d.temp.maxTime + '</span>' : '');
                document.getElementById('mn').innerHTML = (d.temp.min || '--') + '°' + (d.temp.minTime != "--:--" ? '<span class="time-mark">' + d.temp.minTime + '</span>' : '');
                document.getElementById('rf').innerText = (d.temp.realFeel || '--') + '°';
                document.getElementById('h').innerText = (d.atmo.hum || '--') + '%';
                document.getElementById('hIcon').innerText = d.atmo.hTrend > 0 ? '▲' : d.atmo.hTrend < 0 ? '▼' : '●';
                
                document.getElementById('w').innerText = d.wind.speed || '0';
                document.getElementById('wg').innerText = (d.wind.gust || '0') + ' km/h';
                document.getElementById('wd').innerText = (d.wind.card || 'N') + ' (' + (d.wind.deg || '0') + '°)';
                document.getElementById('mw').innerHTML = (d.wind.maxS || '0') + ' <span class="time-mark">' + (d.wind.maxSTime || '--:--') + '</span>';
                document.getElementById('mg').innerHTML = (d.wind.maxG || '0') + ' <span class="time-mark">' + (d.wind.maxGTime || '--:--') + '</span>';
                document.getElementById('needle').style.transform = 'rotate(' + (d.wind.deg || 0) + 'deg)';

                document.getElementById('pr').innerText = d.atmo.press || '--';
                document.getElementById('pIcon').innerText = d.atmo.pTrend > 0 ? '▲' : d.atmo.pTrend < 0 ? '▼' : '●';
                document.getElementById('sol').innerText = (d.solar.rad || '0') + ' W/m²';
                document.getElementById('uv').innerText = d.solar.uvi || '0';
                
                document.getElementById('r_rate').innerText = d.rain.rate || '0';
                document.getElementById('r_tot').innerText = (d.rain.total || '0') + ' mm';
                
                if (d.rain.maxR > 0) {
                    document.getElementById('mr').innerHTML = d.rain.maxR + ' mm/h <span class="time-mark">' + d.rain.maxRTime + '</span>';
                } else {
                    document.getElementById('mr').innerText = '0 mm/h';
                }

                document.getElementById('ts').innerText = new Date(d.lastSync).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

                if (now - lastGraphUpdate >= 300000 || lastGraphUpdate === 0) {
                    const labels = d.history.map(h => new Date(h.time).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', hour12:false}));
                    if(!charts.cT) {
                        charts.cT = setupChart('cT', 'Temperature (°C)', '#38bdf8');
                        charts.cH = setupChart('cH', 'Humidity (%)', '#10b981');
                        charts.cW = setupChart('cW', 'Wind Speed (km/h)', '#fbbf24');
                        charts.cR = setupChart('cR', 'Daily Rain (mm)', '#818cf8');
                    }
                    if(charts.cT) { charts.cT.data.labels = labels; charts.cT.data.datasets[0].data = d.history.map(h => h.temp); charts.cT.update(); }
                    if(charts.cH) { charts.cH.data.labels = labels; charts.cH.data.datasets[0].data = d.history.map(h => h.hum); charts.cH.update(); }
                    if(charts.cW) { charts.cW.data.labels = labels; charts.cW.data.datasets[0].data = d.history.map(h => h.wind); charts.cW.update(); }
                    if(charts.cR) { charts.cR.data.labels = labels; charts.cR.data.datasets[0].data = d.history.map(h => h.rain); charts.cR.update(); }
                    lastGraphUpdate = now;
                }
            } catch (e) { console.error("Update Error:", e); }
        }
        setInterval(update, 45000); update();
    </script>
</body>
</html>
    `);
});

app.listen(3000);
