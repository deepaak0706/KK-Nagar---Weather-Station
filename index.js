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
        const liveDew = parseFloat(((d.outdoor.dew_point.value - 32) * 5 / 9).toFixed(1)); // Added Dew Point
        const liveHum = d.outdoor.humidity.value || 0;
        const livePress = parseFloat((d.pressure.relative.value * 33.8639).toFixed(1));
        const liveWind = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));
        const liveGust = parseFloat((d.wind.wind_gust.value * 1.60934).toFixed(1));
        
        const liveRain24h = parseFloat((d.rainfall.daily.value * 25.4).toFixed(1));
        const liveRainWeekly = parseFloat((d.rainfall.weekly.value * 25.4).toFixed(1));
        const liveRainMonthly = parseFloat((d.rainfall.monthly.value * 25.4).toFixed(1));
        const liveRainYearly = parseFloat((d.rainfall.yearly.value * 25.4).toFixed(1));
        const liveRainRate = parseFloat(((d.rainfall.rain_rate?.value || 0) * 25.4).toFixed(1));

        // DB Write Check (2 Minutes)
        if (forceWrite || (now - state.lastDbWrite > 120000)) {
            try {
                await pool.query(
                    `INSERT INTO weather_history (time, temp_f, humidity, wind_speed_mph, wind_gust_mph, daily_rain_in, solar_radiation, press_rel, rain_rate_in) 
                     VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8)`, 
                    [d.outdoor.temperature.value, liveHum, d.wind.wind_speed.value, d.wind.wind_gust.value, d.rainfall.daily.value, d.solar_and_uvi?.solar?.value || 0, livePress, d.rainfall.rain_rate?.value || 0]
                );
                state.lastDbWrite = now;
            } catch (err) { console.error("Database Write Error:", err.message); }
        }

        const historyRes = await pool.query(`SELECT * FROM weather_history WHERE time >= (CURRENT_DATE AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') ORDER BY time ASC`);
        const oneHourAgoRes = await pool.query(`SELECT temp_f FROM weather_history WHERE time >= NOW() - INTERVAL '1 hour' ORDER BY time ASC LIMIT 1`);
        
        let mx_t = -999, mn_t = 999, mx_t_time = "--:--", mn_t_time = "--:--", mx_w = 0, mx_w_t = "--:--", mx_g = 0, mx_g_t = "--:--", mx_r = 0, mx_r_t = "--:--", pTrend = 0, tRate = 0;
        let graphHistory = [];

        if (historyRes.rows.length > 0) {
            const lastRow = historyRes.rows[historyRes.rows.length - 1];
            pTrend = parseFloat((livePress - (lastRow.press_rel || livePress)).toFixed(1));
            const baseTempF = oneHourAgoRes.rows.length > 0 ? oneHourAgoRes.rows[0].temp_f : (historyRes.rows[0].temp_f || d.outdoor.temperature.value);
            tRate = parseFloat((liveTemp - parseFloat(((baseTempF - 32) * 5 / 9).toFixed(1))).toFixed(1));

            historyRes.rows.forEach(r => {
                const r_time = new Date(r.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
                const r_temp = parseFloat(((r.temp_f - 32) * 5 / 9).toFixed(1));
                const r_wind = parseFloat((r.wind_speed_mph * 1.60934).toFixed(1));
                const r_gust = parseFloat((r.wind_gust_mph * 1.60934).toFixed(1));
                const r_rain_rate = parseFloat((r.rain_rate_in * 25.4).toFixed(1));

                if (r_temp >= mx_t) { mx_t = r_temp; mx_t_time = r_time; }
                if (r_temp <= mn_t) { mn_t = r_temp; mn_t_time = r_time; }
                if (r_wind >= mx_w) { mx_w = r_wind; mx_w_t = r_time; }
                if (r_gust >= mx_g) { mx_g = r_gust; mx_g_t = r_time; }
                if (r_rain_rate > mx_r) { mx_r = r_rain_rate; mx_r_t = r_time; }
                graphHistory.push({ time: r.time, temp: r_temp, hum: r.humidity, wind: r_wind, rain: parseFloat((r.daily_rain_in * 25.4).toFixed(1)) });
            });
        }

        state.cachedData = {
            temp: { current: liveTemp, dew: liveDew, max: mx_t, maxTime: mx_t_time, min: mn_t, minTime: mn_t_time, realFeel: calculateRealFeel(liveTemp, liveHum), rate: tRate },
            atmo: { hum: liveHum, press: livePress, pTrend, sol: d.solar_and_uvi?.solar?.value || 0, uv: d.solar_and_uvi?.uvi?.value || 0 },
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
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>KK Nagar Weather Hub</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;700;900&display=swap" rel="stylesheet">
    <style>
        :root { 
            --bg-grad: linear-gradient(135deg, #e0f2fe 0%, #f0f9ff 50%, #e0eafc 100%);
            --card-bg: rgba(255, 255, 255, 0.65); 
            --accent: #0ea5e9; 
            --max-t: #e11d48; 
            --min-t: #0284c7; 
            --border-light: rgba(255, 255, 255, 1); 
            --text-main: #0f172a;
            --text-muted: #475569;
            --shadow-soft: 0 12px 32px rgba(15, 23, 42, 0.06);
        }
        
        * { box-sizing: border-box; }
        
        body { 
            margin: 0; 
            font-family: 'Outfit', sans-serif; 
            background: var(--bg-grad);
            color: var(--text-main); 
            padding: 40px 24px; 
            display: flex; 
            flex-direction: column; 
            align-items: center; 
            min-height: 100vh;
        }

        .container { width: 100%; max-width: 1300px; }

        @keyframes fadeUp {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .header { 
            margin-bottom: 48px; 
            display: flex; 
            justify-content: space-between; 
            align-items: center; 
            width: 100%; 
            animation: fadeUp 0.6s ease-out both;
        }
        
        .header h1 { 
            font-size: 34px; 
            font-weight: 900; 
            margin: 0; 
            color: #0f172a;
            letter-spacing: -1px;
        }
        
        .status-bar { 
            display: flex; 
            align-items: center; 
            gap: 12px; 
            background: rgba(255, 255, 255, 0.8); 
            padding: 10px 20px; 
            border-radius: 100px; 
            border: 1px solid var(--border-light); 
            box-shadow: 0 4px 15px rgba(0,0,0,0.05);
        }
        
        .live-dot { 
            width: 10px; height: 10px; 
            background: #10b981; 
            border-radius: 50%; 
            box-shadow: 0 0 10px rgba(16, 185, 129, 0.6); 
            animation: blink 2s infinite cubic-bezier(0.4, 0, 0.6, 1); 
        }
        @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        
        .timestamp { font-size: 14px; font-weight: 700; color: var(--text-muted); }
        
        .grid-system { 
            display: grid; 
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); 
            gap: 24px; 
            margin-bottom: 32px; 
        }
        
        .card { 
            background: var(--card-bg); 
            padding: 32px; 
            border-radius: 32px; 
            border: 1px solid var(--border-light); 
            backdrop-filter: blur(24px) saturate(150%); 
            -webkit-backdrop-filter: blur(24px) saturate(150%);
            position: relative; 
            box-shadow: var(--shadow-soft);
            transition: all 0.3s ease;
            animation: fadeUp 0.6s ease-out both;
        }
        
        .card:nth-child(1) { animation-delay: 0.1s; }
        .card:nth-child(2) { animation-delay: 0.2s; }
        .card:nth-child(3) { animation-delay: 0.3s; }
        .card:nth-child(4) { animation-delay: 0.4s; }

        .card:hover {
            transform: translateY(-4px);
            box-shadow: 0 20px 40px rgba(15, 23, 42, 0.08);
            background: rgba(255, 255, 255, 0.85);
        }
        
        .label { 
            color: var(--accent); 
            font-size: 14px; 
            font-weight: 800; 
            text-transform: uppercase; 
            letter-spacing: 2px; 
            margin-bottom: 12px; 
        }
        
        .main-val { 
            font-size: 64px; 
            font-weight: 900; 
            margin: 4px 0 12px 0; 
            display: flex; 
            align-items: baseline; 
            letter-spacing: -3px; 
            color: #0f172a;
        }
        
        .unit { 
            font-size: 24px; 
            font-weight: 700; 
            color: #64748b; 
            margin-left: 8px; 
            letter-spacing: normal;
        }
        
        .sub-pill { 
            font-size: 13px; 
            font-weight: 700; 
            padding: 6px 14px; 
            border-radius: 12px; 
            background: rgba(255,255,255,0.7); 
            border: 1px solid var(--border-light);
            display: inline-flex; 
            align-items: center; 
            gap: 6px; 
            margin-bottom: 16px; 
            color: #334155;
            box-shadow: 0 2px 6px rgba(0,0,0,0.02);
        }
        
        .trend-up { color: var(--max-t); } 
        .trend-down { color: var(--min-t); }
        
        .sub-box-4 { 
            display: grid; 
            grid-template-columns: 1fr 1fr; 
            gap: 16px; 
            padding-top: 24px; 
            border-top: 1px solid rgba(0,0,0,0.06); 
        }
        
        .badge { 
            padding: 16px; 
            border-radius: 20px; 
            background: rgba(255, 255, 255, 0.5); 
            border: 1px solid var(--border-light);
            display: flex; 
            flex-direction: column; 
            gap: 6px; 
            box-shadow: inset 0 2px 10px rgba(255,255,255,0.8);
        }
        
        .badge-label { font-size: 11px; color: #64748b; text-transform: uppercase; font-weight: 800; letter-spacing: 1px; }
        .badge-val { font-size: 18px; font-weight: 800; color: #1e293b; }
        .time-mark { font-size: 10px; font-weight: 800; color: #64748b; background: rgba(0,0,0,0.04); padding: 3px 8px; border-radius: 6px; margin-left: 6px; }
        
        .compass-ui { 
            position: absolute; 
            top: 32px; right: 32px; 
            width: 68px; height: 68px; 
            border: 2px solid rgba(0,0,0,0.05); 
            border-radius: 50%; 
            display: flex; align-items: center; justify-content: center; 
            background: rgba(255,255,255,0.4);
            box-shadow: 0 4px 10px rgba(0,0,0,0.03);
        }
        .compass-ui span { position: absolute; font-size: 10px; font-weight: 900; color: rgba(0,0,0,0.3); }
        .c-n { top: 4px; color: var(--max-t) !important; } .c-e { right: 4px; } .c-s { bottom: 4px; } .c-w { left: 4px; }
        
        #needle { 
            width: 4px; height: 44px; 
            background: linear-gradient(to bottom, var(--max-t) 50%, #94a3b8 50%); 
            clip-path: polygon(50% 0%, 100% 100%, 50% 85%, 0% 100%); 
            transition: transform 1.5s cubic-bezier(0.34, 1.56, 0.64, 1); 
            filter: drop-shadow(0 2px 4px rgba(0,0,0,0.2));
        }

        .graphs-wrapper {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(450px, 1fr));
            gap: 24px;
            width: 100%;
        }
        
        .graph-card { 
            background: var(--card-bg); 
            padding: 24px; 
            border-radius: 32px; 
            border: 1px solid var(--border-light); 
            backdrop-filter: blur(24px) saturate(150%); 
            height: 380px; 
            box-shadow: var(--shadow-soft);
            animation: fadeUp 0.8s ease-out both;
            animation-delay: 0.5s;
        }

        @media (max-width: 768px) {
            .header { flex-direction: column; gap: 16px; align-items: flex-start; }
            .graphs-wrapper { grid-template-columns: 1fr; }
            .main-val { font-size: 48px; }
            .graph-card { height: 300px; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>KK Nagar Weather Hub</h1>
            <div class="status-bar">
                <div class="live-dot"></div>
                <div class="timestamp">LIVE SYSTEM SYNC: <span id="ts">--:--:--</span></div>
            </div>
        </div>
        
        <div class="grid-system">
            <div class="card">
                <div class="label">Temperature</div>
                <div class="main-val"><span id="t">--</span><span class="unit">°C</span></div>
                <div id="tTrendBox" class="sub-pill">--</div>
                <div class="sub-box-4" style="grid-template-columns: repeat(2, 1fr);">
                    <div class="badge"><span class="badge-label">Today High</span><span id="mx" class="badge-val" style="color:var(--max-t)">--</span></div>
                    <div class="badge"><span class="badge-label">Today Low</span><span id="mn" class="badge-val" style="color:var(--min-t)">--</span></div>
                    <div class="badge"><span class="badge-label">RealFeel</span><span id="rf" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Humidity</span><span id="h" class="badge-val">--</span></div>
                    <div class="badge" style="grid-column: span 2;"><span class="badge-label">Dew Point</span><span id="dp" class="badge-val" style="color:var(--accent)">--</span></div>
                </div>
            </div>
            
            <div class="card">
                <div class="label">Wind Dynamics</div>
                <div class="compass-ui"><span class="c-n">N</span><span class="c-e">E</span><span class="c-s">S</span><span class="c-w">W</span><div id="needle"></div></div>
                <div class="main-val"><span id="w">--</span><span id="wd_bracket" style="font-size:24px; color:#64748b; margin-left:12px; font-weight:700">(--)</span><span class="unit">km/h</span></div>
                <div class="sub-pill">● Gusting <span id="wg" style="margin-left:4px; color: #1e293b;">--</span></div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Max Wind</span><span id="mw" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Max Gust</span><span id="mg" class="badge-val">--</span></div>
                </div>
            </div>
            
            <div class="card">
                <div class="label">Rainfall (24h)</div>
                <div class="main-val"><span id="r_tot">--</span><span class="unit">mm</span></div>
                <div style="display:flex; gap:8px; flex-wrap: wrap;">
                    <div class="sub-pill">● Rate: <span id="r_rate" style="margin-left:4px; color: #1e293b;">--</span> mm/h</div>
                    <div class="sub-pill">● Max: <span id="mr" style="margin-left:4px; color: #1e293b;">--</span></div>
                </div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Weekly</span><span id="r_week" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Monthly</span><span id="r_month" class="badge-val">--</span></div>
                    <div class="badge" style="grid-column: span 2;"><span class="badge-label">Yearly Total</span><span id="r_year" class="badge-val">--</span></div>
                </div>
            </div>
            
            <div class="card">
                <div class="label">Atmospheric <span id="pIcon" style="margin-left:8px;"></span></div>
                <div class="main-val"><span id="pr">--</span><span class="unit">hPa</span></div>
                <div class="sub-box-4" style="margin-top: auto;">
                    <div class="badge"><span class="badge-label">Solar Rad</span><span id="sol" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">UV Index</span><span id="uv" class="badge-val">--</span></div>
                </div>
            </div>
        </div>

        <div class="graphs-wrapper">
            <div class="graph-card"><canvas id="cT"></canvas></div>
            <div class="graph-card"><canvas id="cH"></canvas></div>
            <div class="graph-card"><canvas id="cW"></canvas></div>
            <div class="graph-card"><canvas id="cR"></canvas></div>
        </div>
    </div>
    
    <script>
        let charts = {};
        function setupChart(id, label, color) {
            const ctx = document.getElementById(id); if (!ctx) return null;
            return new Chart(ctx, { type: 'line', data: { labels: [], datasets: [{ label: label, data: [], borderColor: color, backgroundColor: color+'22', fill: true, tension: 0.4, pointRadius: 0 }] }, options: { animation: false, responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, min: 0, ticks: { precision: 1 } } } } });
        }
        async function update() {
            try {
                const res = await fetch('/weather?v=' + Date.now()); const d = await res.json(); if (!d || d.error) return;
                
                // Temp Mapping
                document.getElementById('t').innerText = d.temp.current;
                document.getElementById('dp').innerText = d.temp.dew + '°C';
                document.getElementById('tTrendBox').innerHTML = d.temp.rate > 0 ? '<span class="trend-up">▲</span> +' + d.temp.rate + '°C /hr' : d.temp.rate < 0 ? '<span class="trend-down">▼</span> ' + d.temp.rate + '°C /hr' : '● Steady';
                document.getElementById('mx').innerHTML = d.temp.max + '°C <span class="time-mark">' + d.temp.maxTime + '</span>';
                document.getElementById('mn').innerHTML = d.temp.min + '°C <span class="time-mark">' + d.temp.minTime + '</span>';
                document.getElementById('rf').innerText = d.temp.realFeel + '°'; document.getElementById('h').innerText = d.atmo.hum + '%';
                
                // Wind Mapping
                document.getElementById('w').innerText = d.wind.speed; document.getElementById('wd_bracket').innerText = '(' + d.wind.card + ')';
                document.getElementById('wg').innerText = d.wind.gust + ' km/h';
                document.getElementById('mw').innerHTML = d.wind.maxS + ' km/h <span class="time-mark">' + d.wind.maxSTime + '</span>';
                document.getElementById('mg').innerHTML = d.wind.maxG + ' km/h <span class="time-mark">' + d.wind.maxGTime + '</span>';
                document.getElementById('needle').style.transform = 'rotate(' + d.wind.deg + 'deg)';
                
                // Rain Mapping
                document.getElementById('r_tot').innerText = d.rain.total; document.getElementById('r_rate').innerText = d.rain.rate;
                document.getElementById('mr').innerHTML = d.rain.maxR > 0 ? d.rain.maxR + ' mm/h <span class="time-mark">' + d.rain.maxRTime + '</span>' : '0';
                document.getElementById('r_week').innerText = d.rain.weekly + ' mm'; 
                document.getElementById('r_month').innerText = d.rain.monthly + ' mm';
                document.getElementById('r_year').innerText = d.rain.yearly + ' mm';
                
                // Barometer Trend Icon
                document.getElementById('pr').innerText = d.atmo.press;
                const pIcon = document.getElementById('pIcon');
                if (d.atmo.pTrend > 0) pIcon.innerHTML = '<span class="trend-up" style="font-size:14px">▲</span>';
                else if (d.atmo.pTrend < 0) pIcon.innerHTML = '<span class="trend-down" style="font-size:14px">▼</span>';
                else pIcon.innerHTML = '<span style="color:#64748b; font-size:10px">●</span>';

                document.getElementById('sol').innerText = d.atmo.sol + ' W/m²'; document.getElementById('uv').innerText = d.atmo.uv;
                document.getElementById('ts').innerText = new Date(d.lastSync).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

                // Automatic Graph Update Logic
                const labels = d.history.map(h => new Date(h.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }));
                if(!charts.cT) { 
                    charts.cT = setupChart('cT', 'Temperature (°C)', '#0ea5e9'); charts.cH = setupChart('cH', 'Humidity (%)', '#10b981'); 
                    charts.cW = setupChart('cW', 'Wind Speed (km/h)', '#f59e0b'); charts.cR = setupChart('cR', 'Rain (mm)', '#6366f1'); 
                }
                charts.cT.data.labels = labels; charts.cT.data.datasets[0].data = d.history.map(h => h.temp); charts.cT.update('none');
                charts.cH.data.labels = labels; charts.cH.data.datasets[0].data = d.history.map(h => h.hum); charts.cH.update('none');
                charts.cW.data.labels = labels; charts.cW.data.datasets[0].data = d.history.map(h => h.wind); charts.cW.update('none');
                charts.cW.data.labels = labels; charts.cR.data.datasets[0].data = d.history.map(h => Math.max(0, h.rain)); charts.cR.update('none');
            } catch (e) { console.error(e); }
        }
        setInterval(update, 45000); update();
    </script>
</body>
</html>
    `);
});

app.listen(3000);
