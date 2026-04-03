const express = require("express");
const fetch = require("node-fetch");
const { Pool } = require('pg'); 
const app = express();

/**
 * DATABASE CONFIGURATION
 * Connects to your Neon PostgreSQL instance
 */
const pool = new Pool({
    connectionString: process.env.POSTGRES_URL + "?sslmode=require",
});

const APPLICATION_KEY = process.env.APPLICATION_KEY;
const API_KEY = process.env.API_KEY;
const MAC = process.env.MAC;

// Persistent state for calculations within a single server session
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

/**
 * HELPER: Get Wind Cardinal Direction
 */
const getCard = (a) => {
    const directions = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
    return directions[Math.round(a / 22.5) % 16];
};

/**
 * HELPER: Calculate RealFeel (Heat Index)
 */
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

/**
 * MAIN LOGIC: Sync with Ecowitt API and Database
 */
async function syncWithEcowitt() {
    const now = Date.now();
    
    // Throttle API calls to every 35 seconds to stay within rate limits
    if (state.cachedData && (now - state.lastFetchTime < 35000)) {
        return state.cachedData;
    }

    try {
        const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}`;
        const response = await fetch(url);
        const json = await response.json();
        
        if (!json.data) throw new Error("API returned no data");
        const d = json.data;

        // Unit Conversions
        const tempC = parseFloat(((d.outdoor.temperature.value - 32) * 5 / 9).toFixed(1));
        const hum = d.outdoor.humidity.value || 0;
        const press = parseFloat((d.pressure.relative.value * 33.8639).toFixed(1));
        const dailyRain = parseFloat((d.rainfall.daily.value * 25.4).toFixed(1));
        const curWind = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));
        const curGust = parseFloat((d.wind.wind_gust.value * 1.60934).toFixed(1));
        const solar = d.solar_and_uvi?.solar?.value || 0;
        const uvi = d.solar_and_uvi?.uvi?.value || 0;

        // Davis-Style Instantaneous Rain Rate Calculation
        let instantRR = 0;
        if (dailyRain > state.lastRainfall) {
            const timeDiffMin = (now - state.lastRainTime) / 60000;
            if (timeDiffMin > 0) {
                instantRR = parseFloat(((0.254 / timeDiffMin) * 60).toFixed(1));
            }
            state.lastRainfall = dailyRain;
            state.lastRainTime = now;
        } else if ((now - state.lastRainTime) > 15 * 60000) {
            instantRR = 0; // Reset if no rain for 15 mins
        }

        // Daily Resets and High/Low Tracking
        const today = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
        const currentTimeStr = new Date(now).toLocaleTimeString('en-IN', { 
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' 
        });

        if (state.currentDate !== today) {
            state.currentDate = today;
            state.maxTemp = -999; state.minTemp = 999; 
            state.maxWindSpeed = 0; state.maxGust = 0; state.maxRainRate = 0;
        }

        if (tempC > state.maxTemp || state.maxTemp === -999) { state.maxTemp = tempC; state.maxTempTime = currentTimeStr; }
        if (tempC < state.minTemp || state.minTemp === 999) { state.minTemp = tempC; state.minTempTime = currentTimeStr; }
        if (curWind > state.maxWindSpeed) state.maxWindSpeed = curWind;
        if (curGust > state.maxGust) state.maxGust = curGust;
        if (instantRR > state.maxRainRate) state.maxRainRate = instantRR;

        // Write to Database every 2 minutes
        if (now - state.lastDbWrite >= 120000) {
            try {
                await pool.query(`
                    INSERT INTO weather_history (temp_f, humidity, wind_speed_mph, wind_gust_mph, rain_rate_in, daily_rain_in, solar_radiation, press_rel) 
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, 
                    [d.outdoor.temperature.value, hum, d.wind.wind_speed.value, d.wind.wind_gust.value, instantRR, dailyRain, solar, press]
                );
                state.lastDbWrite = now;
            } catch (dbError) {
                console.error("Database Insert Failed:", dbError);
            }
        }

        // Fetch Clean History for Graphs (Grouped by Minute)
        const historyRes = await pool.query(`
            SELECT date_trunc('minute', time) as time, AVG(temp_f) as t, AVG(humidity) as h, AVG(wind_speed_mph) as w, AVG(rain_rate_in) as r, AVG(press_rel) as p
            FROM weather_history 
            WHERE time > NOW() - INTERVAL '24 hours'
            GROUP BY 1 ORDER BY 1 ASC
        `);

        const history = (historyRes.rows || []).map(r => ({
            time: r.time,
            temp: parseFloat(((r.t - 32) * 5 / 9).toFixed(1)),
            hum: Math.round(r.h || 0),
            press: parseFloat((r.p || 0).toFixed(1)),
            wind: parseFloat(((r.w || 0) * 1.60934).toFixed(1)),
            rain: parseFloat((r.r || 0).toFixed(1))
        }));

        // Trend Calculations (Units per hour)
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
                max: state.maxTemp, maxTime: state.maxTempTime, 
                min: state.minTemp, minTime: state.minTempTime, 
                trend: tTrend, realFeel: calculateRealFeel(tempC, hum) 
            },
            atmo: { hum: hum, hTrend: hTrend, press: press, pTrend: pTrend, dew: parseFloat(((d.outdoor.dew_point.value - 32) * 5 / 9).toFixed(1)) },
            wind: { speed: curWind, gust: curGust, maxS: state.maxWindSpeed, maxG: state.maxGust, card: getCard(d.wind.wind_direction.value), deg: d.wind.wind_direction.value },
            rain: { total: dailyRain, rate: instantRR, maxR: state.maxRainRate },
            solar: { rad: solar, uvi: uvi },
            lastSync: d.time || new Date().toISOString(),
            history: history
        };

        state.lastFetchTime = now;
        return state.cachedData;

    } catch (e) {
        console.error("Sync Error:", e);
        return state.cachedData || { error: "Update failed", history: [] };
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
            --rain: #818cf8; --border: rgba(255, 255, 255, 0.08);
            --gap: 24px;
        }

        * { box-sizing: border-box; -webkit-font-smoothing: antialiased; }
        
        @keyframes gradient-pan {
            0% { background-position: 0% 50%; }
            50% { background-position: 100% 50%; }
            100% { background-position: 0% 50%; }
        }

        @keyframes fade-in-up {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }

        body { 
            margin: 0; font-family: 'Outfit', sans-serif; 
            background: linear-gradient(-45deg, var(--bg-1), var(--bg-2), var(--bg-3), var(--bg-1));
            background-size: 400% 400%; animation: gradient-pan 20s ease infinite;
            color: #f8fafc; padding: 32px 24px; display: flex; flex-direction: column; align-items: center; min-height: 100vh;
        }

        body::before {
            content: ''; position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background-image: radial-gradient(rgba(255, 255, 255, 0.03) 1px, transparent 1px);
            background-size: 24px 24px; pointer-events: none; z-index: 0;
        }

        body.solar-low { background: #000; color: #cbd5e1; animation: none; }
        body.solar-low .card, body.solar-low .graph-card { background: rgba(5, 10, 20, 0.7); }

        .container { width: 100%; max-width: 1200px; z-index: 1; position: relative; }
        
        .header { margin-bottom: 40px; display: flex; justify-content: space-between; align-items: center; width: 100%; }
        .header h1 { margin: 0; font-size: 32px; font-weight: 900; letter-spacing: -1px; text-shadow: 0 4px 24px rgba(0,0,0,0.5); }
        
        .live-container { 
            display: inline-flex; align-items: center; gap: 10px; 
            background: rgba(34, 197, 94, 0.1); padding: 8px 18px; 
            border-radius: 100px; border: 1px solid rgba(34, 197, 94, 0.3); 
            backdrop-filter: blur(12px); box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        }
        
        .dot { width: 10px; height: 10px; background: #22c55e; border-radius: 50%; box-shadow: 0 0 12px rgba(34, 197, 94, 0.8); animation: pulse 2s infinite; }
        @keyframes pulse { 0% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.3); opacity: 0.6; } 100% { transform: scale(1); opacity: 1; } }
        
        .live-text { font-family: monospace; font-size: 13px; font-weight: 800; color: #22c55e; letter-spacing: 1px; }
        .timestamp { font-family: monospace; font-size: 12px; color: #94a3b8; }
        
        .grid-system { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: var(--gap); width: 100%; margin-bottom: var(--gap); }
        
        .card, .graph-card { 
            background: var(--card); padding: 32px; border-radius: 28px; 
            border: 1px solid var(--border); border-top: 1px solid rgba(255,255,255,0.15);
            backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
            box-shadow: 0 24px 40px -10px rgba(0, 0, 0, 0.4); 
            transition: transform 0.3s ease, box-shadow 0.3s ease;
            animation: fade-in-up 0.6s ease-out forwards; opacity: 0;
        }

        .card:nth-child(1) { animation-delay: 0.1s; } .card:nth-child(2) { animation-delay: 0.2s; }
        .card:nth-child(3) { animation-delay: 0.3s; } .card:nth-child(4) { animation-delay: 0.4s; }

        .card:hover, .graph-card:hover { transform: translateY(-4px); box-shadow: 0 30px 50px -12px rgba(0, 0, 0, 0.5); }

        .label { color: #94a3b8; font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 8px; }
        .main-val { font-size: 56px; font-weight: 900; margin: 4px 0; display: flex; align-items: baseline; letter-spacing: -2px; text-shadow: 0 4px 12px rgba(0,0,0,0.3); }
        .unit { font-size: 22px; font-weight: 600; color: #64748b; margin-left: 8px; }
        
        .minor-line { font-size: 16px; font-weight: 600; margin: 4px 0 16px 0; display: flex; align-items: center; gap: 8px; }
        .trend-badge { font-size: 13px; font-weight: 800; margin-bottom: 24px; display: inline-flex; align-items: center; gap: 8px; padding: 6px 14px; background: rgba(255,255,255,0.06); border-radius: 12px; border: 1px solid rgba(255,255,255,0.08); }
        
        .sub-box-4 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding-top: 24px; border-top: 1px solid rgba(255, 255, 255, 0.08); }
        
        .badge { 
            padding: 16px; border-radius: 20px; background: rgba(0, 0, 0, 0.2); 
            display: flex; flex-direction: column; gap: 8px; border: 1px solid rgba(255,255,255,0.03);
            box-shadow: inset 0 2px 4px rgba(0,0,0,0.2);
        }
        
        .badge-label { font-size: 11px; color: #64748b; text-transform: uppercase; font-weight: 800; }
        .badge-val { font-size: 16px; font-weight: 700; color: #f1f5f9; display: flex; align-items: center; gap: 6px; }
        
        .time-mark { font-size: 10px; font-weight: 800; color: #94a3b8; background: rgba(255,255,255,0.08); padding: 2px 6px; border-radius: 6px; margin-left: 4px; }
        
        .compass-ui { position: absolute; top: 32px; right: 32px; width: 60px; height: 60px; border: 2px solid rgba(255,255,255,0.1); border-radius: 50%; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.4); }
        #needle { width: 4px; height: 38px; background: linear-gradient(to bottom, var(--max-t) 50%, #e2e8f0 50%); clip-path: polygon(50% 0%, 100% 100%, 50% 85%, 0% 100%); transition: transform 1.5s cubic-bezier(0.34, 1.56, 0.64, 1); }
        
        .graph-card { height: 360px; padding: 25px 20px 20px 20px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div>
                <h1>Kk Nagar Weather Hub</h1>
                <div class="live-container">
                    <div class="dot"></div><span class="live-text">LIVE</span><span class="timestamp" id="ts">--:--:--</span>
                </div>
            </div>
        </div>

        <div class="grid-system">
            <div class="card" id="card-temp">
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

            <div class="card" id="card-wind">
                <div class="label">Wind Dynamics</div>
                <div class="compass-ui"><div id="needle"></div></div>
                <div class="main-val"><span id="w">--</span><span class="unit">km/h</span></div>
                <div id="wg" class="minor-line" style="color:var(--wind)">--</div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Max wind</span><span id="mw" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Max Gust</span><span id="mg" class="badge-val">--</span></div>
                </div>
            </div>

            <div class="card" id="card-atmo">
                <div class="label">Atmospheric</div>
                <div class="main-val"><span id="pr">--</span><span class="unit">hPa</span></div>
                <div id="p_status" class="minor-line" style="color:#64748b">--</div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Solar Rad</span><span id="sol" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">UV Index</span><span id="uv" class="badge-val" style="color:#fbbf24">--</span></div>
                </div>
            </div>

            <div class="card" id="card-rain">
                <div class="label">Precipitation</div>
                <div class="main-val"><span id="r">--</span><span class="unit">mm</span></div>
                <div class="minor-line"><span id="rr_main" style="color:var(--rain)">Rate: --</span><span id="rain_status" style="font-size:10px; padding:2px 6px; border-radius:4px; font-weight:800; text-transform:uppercase">--</span></div>
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

        // Sync Plugin for multi-chart hover
        const syncPlugin = {
            id: 'syncPlugin',
            afterDraw: (chart) => {
                if (chart.tooltip?._active?.length) {
                    const x = chart.tooltip._active[0].element.x;
                    const yAxis = chart.scales.y;
                    const ctx = chart.ctx;
                    ctx.save();
                    ctx.beginPath();
                    ctx.moveTo(x, yAxis.top);
                    ctx.lineTo(x, yAxis.bottom);
                    ctx.lineWidth = 1;
                    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
                    ctx.setLineDash([5, 5]);
                    ctx.stroke();
                    ctx.restore();

                    Object.values(charts).forEach(otherChart => {
                        if (otherChart !== chart) {
                            const meta = otherChart.getDatasetMeta(0);
                            const points = meta.data;
                            const index = chart.tooltip.dataPoints[0].index;
                            if (points[index]) {
                                otherChart.tooltip.setActiveElements([{ datasetIndex: 0, index: index }], { x: points[index].x, y: points[index].y });
                                otherChart.draw();
                            }
                        }
                    });
                }
            }
        };
        Chart.register(syncPlugin);

        function setupChart(id, label, col, minZero = false) {
            const ctx = document.getElementById(id).getContext('2d');
            const grad = ctx.createLinearGradient(0, 0, 0, 300);
            grad.addColorStop(0, col + '44'); grad.addColorStop(1, col + '00');
            return new Chart(ctx, {
                type: 'line',
                data: { labels: [], datasets: [{ label: label, data: [], borderColor: col, tension: 0.4, pointRadius: 0, borderWidth: 3, fill: true, backgroundColor: grad }]},
                options: { 
                    responsive: true, maintainAspectRatio: false, 
                    interaction: { mode: 'index', intersect: false },
                    plugins: { 
                        legend: { labels: { color: '#f8fafc', font: { family: "'Outfit'", weight: '700' } } },
                        tooltip: { enabled: true, backgroundColor: 'rgba(15, 23, 42, 0.9)' }
                    },
                    scales: { 
                        x: { ticks: { font: { size: 10 }, color: '#94a3b8' }, grid: { display: false } }, 
                        y: { beginAtZero: minZero, ticks: { font: { size: 10 }, color: '#94a3b8' }, grid: { color: 'rgba(255,255,255,0.03)' } } 
                    }
                }
            });
        }

        async function update() {
            try {
                const res = await fetch('/weather?v=' + Date.now());
                const d = await res.json();
                if(!d || d.error) return;

                // Update Text
                document.getElementById('t').innerText = d.temp.current;
                document.getElementById('rf').innerText = d.temp.realFeel;
                const tIcon = d.temp.trend > 0 ? '↗' : d.temp.trend < 0 ? '↘' : '→';
                document.getElementById('tr').innerHTML = '<span style="color:'+(d.temp.trend > 0 ? 'var(--max-t)' : '#22c55e')+'">'+tIcon+' '+Math.abs(d.temp.trend)+'°C/hr Trend</span>';
                document.getElementById('mx').innerHTML = d.temp.max + '°C <span class="time-mark">'+(d.temp.maxTime||'')+'</span>';
                document.getElementById('mn').innerHTML = d.temp.min + '°C <span class="time-mark">'+(d.temp.minTime||'')+'</span>';
                document.getElementById('h').innerText = d.atmo.hum + '%';
                document.getElementById('pr').innerText = d.atmo.press;
                document.getElementById('p_status').innerText = d.atmo.pTrend > 0 ? 'Rising Pressure' : d.atmo.pTrend < 0 ? 'Falling Pressure' : 'Stable';
                document.getElementById('dp').innerText = d.atmo.dew + '°C';
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

                // Status Classes
                document.body.classList.toggle('solar-low', d.solar.rad <= 0);
                const rStat = d.rain.rate > 0 ? {t:'Raining', c:'#38bdf8', b:'rgba(56,189,248,0.1)'} : {t:'Dry', c:'#64748b', b:'rgba(255,255,255,0.06)'};
                const rsEl = document.getElementById('rain_status');
                rsEl.innerText = rStat.t; rsEl.style.color = rStat.c; rsEl.style.background = rStat.b;
                document.getElementById('ts').innerText = new Date(d.lastSync).toLocaleTimeString('en-IN', { hour12: false });

                // Update Charts
                if (d.history && d.history.length > 0) {
                    const labs = d.history.map(h => new Date(h.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }));
                    if (!charts.cT) {
                        charts.cT = setupChart('cT', 'Temp (°C)', '#38bdf8');
                        charts.cH = setupChart('cH', 'Humidity (%)', '#10b981', true);
                        charts.cW = setupChart('cW', 'Wind (km/h)', '#fbbf24', true);
                        charts.cR = setupChart('cR', 'Rain (mm/h)', '#818cf8', true);
                    }
                    charts.cT.data.labels = labs; charts.cT.data.datasets[0].data = d.history.map(h => h.temp); charts.cT.update('none');
                    charts.cH.data.labels = labs; charts.cH.data.datasets[0].data = d.history.map(h => h.hum); charts.cH.update('none');
                    charts.cW.data.labels = labs; charts.cW.data.datasets[0].data = d.history.map(h => h.wind); charts.cW.update('none');
                    charts.cR.data.labels = labs; charts.cR.data.datasets[0].data = d.history.map(h => h.rain); charts.cR.update('none');
                }
            } catch (e) { console.error("UI Update Failed", e); }
        }
        setInterval(update, 36000); 
        update();
    </script>
</body>
</html>
    `);
});

module.exports = app;
