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
        const oneHourAgoRes = await pool.query(`SELECT temp_f, humidity FROM weather_history WHERE time >= NOW() - INTERVAL '1 hour' ORDER BY time ASC LIMIT 1`);
        
        let mx_t = -999, mn_t = 999, mx_t_time = "--:--", mn_t_time = "--:--", mx_w = 0, mx_w_t = "--:--", mx_g = 0, mx_g_t = "--:--", mx_r = 0, mx_r_t = "--:--", pTrend = 0, tRate = 0, hTrend = 0;
        let graphHistory = [];

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
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>KK Nagar Weather Hub</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;700;900&display=swap" rel="stylesheet">
    <style>
        :root { 
            --bg: #fdfcf7; --card: rgba(255, 255, 255, 0.85); --border: rgba(0, 0, 0, 0.04);
            --text: #0f172a; --muted: #64748b; --accent: #0284c7; --glow: 0 10px 40px -10px rgba(0,0,0,0.04);
        }

        body.is-night {
            --bg: #020617; --card: rgba(15, 23, 42, 0.75); --border: rgba(255, 255, 255, 0.08);
            --text: #f1f5f9; --muted: #94a3b8; --accent: #38bdf8; --glow: 0 15px 50px -12px rgba(0,0,0,0.6);
        }

        body { margin: 0; font-family: 'Outfit', sans-serif; background: var(--bg); color: var(--text); padding: 40px 24px; transition: all 0.5s ease; min-height: 100vh; }
        .container { width: 100%; max-width: 1200px; margin: 0 auto; }
        
        .header { margin-bottom: 40px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 20px; }
        .header h1 { font-size: 30px; font-weight: 900; margin: 0; letter-spacing: -1.5px; }

        .header-actions { display: flex; align-items: center; gap: 16px; }
        
        .theme-toggle {
            background: var(--card); border: 1px solid var(--border); padding: 4px; border-radius: 12px;
            display: flex; gap: 4px; box-shadow: var(--glow); cursor: pointer;
        }
        .theme-btn { 
            padding: 6px 12px; border-radius: 8px; font-size: 12px; font-weight: 700; 
            transition: 0.3s; color: var(--muted); 
        }
        .theme-btn.active { background: var(--accent); color: white; }

        .status-bar { display: flex; align-items: center; gap: 12px; background: var(--card); padding: 8px 20px; border-radius: 100px; border: 1px solid var(--border); box-shadow: var(--glow); }
        .live-dot { width: 8px; height: 8px; background: #10b981; border-radius: 50%; animation: blink 2s infinite; }
        @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        
        .grid-system { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 24px; }
        .card { background: var(--card); padding: 32px; border-radius: 36px; border: 1px solid var(--border); backdrop-filter: blur(15px); box-shadow: var(--glow); position: relative; }

                 .label { 
            color: var(--accent); font-size: 11px; font-weight: 800; text-transform: uppercase; 
            letter-spacing: 2.5px; margin-bottom: 16px; padding-left: 12px; 
            border-left: 3px solid var(--accent); line-height: 1;
        }

        .main-val { font-size: 64px; font-weight: 900; margin: 2px 0; letter-spacing: -3px; display: flex; align-items: baseline; }
        .unit { font-size: 22px; font-weight: 600; color: var(--muted); margin-left: 6px; letter-spacing: 0; }

        .sub-pill { font-size: 12px; font-weight: 800; padding: 6px 14px; border-radius: 12px; background: rgba(0,0,0,0.03); display: inline-flex; align-items: center; gap: 6px; margin-bottom: 24px; }
        body.is-night .sub-pill { background: rgba(255,255,255,0.05); }

        .sub-box-4 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding-top: 24px; border-top: 1px solid var(--border); }
                .badge { 
            padding: 14px; border-radius: 16px; 
            background: rgba(0, 0, 0, 0.02); 
            border: 1px solid var(--border); 
            display: flex; flex-direction: column; gap: 4px; 
        }

        body.is-night .badge { background: rgba(255,255,255,0.04); }
        .badge-label { font-size: 10px; color: var(--muted); text-transform: uppercase; font-weight: 800; }
        .badge-val { font-size: 18px; font-weight: 800; }

        .compass-ui { position: absolute; top: 32px; right: 32px; width: 60px; height: 60px; border: 2px solid var(--border); border-radius: 50%; display: flex; align-items: center; justify-content: center; }
        #needle { width: 3px; height: 38px; background: linear-gradient(to bottom, #ef4444 50%, var(--muted) 50%); clip-path: polygon(50% 0%, 100% 100%, 50% 85%, 0% 100%); transition: transform 2s cubic-bezier(0.1, 0.9, 0.2, 1); }

        .graphs-wrapper { display: grid; grid-template-columns: repeat(auto-fit, minmax(450px, 1fr)); gap: 24px; margin-top: 24px; }
        .graph-card { background: var(--card); padding: 24px; border-radius: 36px; border: 1px solid var(--border); height: 360px; box-shadow: var(--glow); }

        .trend-up { color: #f43f5e; } .trend-down { color: #0ea5e9; }
        .time-mark { font-size: 10px; color: var(--muted); font-weight: 600; margin-left: 4px; background: rgba(0,0,0,0.04); padding: 2px 6px; border-radius: 6px; }
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
                    <div class="timestamp">LIVE: <span id="ts">--:--:--</span></div>
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
                <div class="label">Wind Dynamics</div>
                <div class="compass-ui"><div id="needle"></div></div>
                <div class="main-val">
                    <span id="w">--</span>
                    <span id="wd_bracket" style="font-size:22px; color:var(--muted); margin-left:12px; font-weight:700">(--)</span>
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
            <div class="graph-card"><canvas id="cT"></canvas></div>
            <div class="graph-card"><canvas id="cH"></canvas></div>
            <div class="graph-card"><canvas id="cW"></canvas></div>
            <div class="graph-card"><canvas id="cR"></canvas></div>
        </div>
    </div>


    <script>
        let currentMode = localStorage.getItem('weatherMode') || 'auto';

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

        let charts = {};
        function setupChart(id, label, color, minVal = null) {
            const ctx = document.getElementById(id);
            return new Chart(ctx, { 
                type: 'line', 
                data: { labels: [], datasets: [{ label: label, data: [], borderColor: color, backgroundColor: color+'15', fill: true, tension: 0.4, pointRadius: 0, borderWidth: 3 }] }, 
                options: { 
                    animation: false, responsive: true, maintainAspectRatio: false, 
                    scales: { 
                        y: { 
                            grid: { color: 'rgba(0,0,0,0.03)' }, 
                            ticks: { font: { family: 'Outfit' } },
                            min: minVal
                        }, 
                        x: { grid: { display: false }, ticks: { font: { family: 'Outfit' } } } 
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

        applyTheme();
        setInterval(update, 45000); 
        update();
    </script>
</body>
</html>
    `);
});

app.listen(3000);
