const express = require("express");
const fetch = require("node-fetch");
const fs = require("fs");
const app = express();

const APPLICATION_KEY = process.env.APPLICATION_KEY;
const API_KEY = process.env.API_KEY;
const MAC = process.env.MAC;

const STORAGE_FILE = "/tmp/weather_stats.json";

let state = {
    cachedData: null,
    todayHistory: [],
    maxTemp: -999,
    minTemp: 999,
    maxWindSpeed: 0,
    maxGust: 0,
    maxRainRate: 0,
    lastFetchTime: 0,
    currentDate: new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })
};

if (fs.existsSync(STORAGE_FILE)) {
    try {
        const saved = JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf-8'));
        if (saved.currentDate === state.currentDate) {
            state.maxTemp = saved.maxTemp ?? -999;
            state.minTemp = saved.minTemp ?? 999;
            state.maxWindSpeed = saved.maxWindSpeed ?? 0;
            state.maxGust = saved.maxGust ?? 0;
            state.maxRainRate = saved.maxRainRate ?? 0;
        }
    } catch (e) {}
}

function saveToDisk() {
    try {
        const data = {
            currentDate: state.currentDate,
            maxTemp: state.maxTemp,
            minTemp: state.minTemp,
            maxWindSpeed: state.maxWindSpeed,
            maxGust: state.maxGust,
            maxRainRate: state.maxRainRate
        };
        fs.writeFileSync(STORAGE_FILE, JSON.stringify(data), 'utf-8');
    } catch (e) {}
}

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

async function syncWithEcowitt() {
    const now = Date.now();
    if (state.cachedData && (now - state.lastFetchTime < 35000)) return state.cachedData;

    try {
        const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}`;
        const response = await fetch(url);
        const json = await response.json();
        const d = json.data;

        const tempC = parseFloat(((d.outdoor.temperature.value - 32) * 5 / 9).toFixed(1));
        const hum = d.outdoor.humidity.value;
        const dailyRain = parseFloat((d.rainfall.daily.value * 25.4).toFixed(1));
        const pressure = parseFloat((d.pressure.relative.value * 33.8639).toFixed(1));
        
        let instantRR = 0;
        if (state.todayHistory.length > 0) {
            const oneMinAgo = now - 75000; 
            const pastRecord = state.todayHistory.find(h => new Date(h.time).getTime() >= oneMinAgo);
            
            if (pastRecord && dailyRain > pastRecord.rainTotal) {
                const rainDiff = dailyRain - pastRecord.rainTotal;
                const timeDiffMin = (now - new Date(pastRecord.time).getTime()) / 60000;
                instantRR = parseFloat(((rainDiff / timeDiffMin) * 60).toFixed(1));
            } else {
                const lastRainCheck = now - 150000;
                const recentRain = state.todayHistory.some(h => h.rain > 0 && new Date(h.time).getTime() >= lastRainCheck);
                if (!recentRain) instantRR = 0;
            }
        }

        const dewC = parseFloat(((d.outdoor.dew_point.value - 32) * 5 / 9).toFixed(1));
        const realFeel = calculateRealFeel(tempC, hum);
        const windKmh = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));
        const gustKmh = parseFloat((d.wind.wind_gust.value * 1.60934).toFixed(1));

        const today = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
        if (state.currentDate !== today) {
            state.currentDate = today;
            state.maxTemp = -999; state.minTemp = 999;
            state.maxWindSpeed = 0; state.maxGust = 0; state.maxRainRate = 0;
            state.todayHistory = [];
        }

        let changed = false;
        if (tempC > state.maxTemp || state.maxTemp === -999) { state.maxTemp = tempC; changed = true; }
        if (tempC < state.minTemp || state.minTemp === 999) { state.minTemp = tempC; changed = true; }
        if (windKmh > state.maxWindSpeed) { state.maxWindSpeed = windKmh; changed = true; }
        if (gustKmh > state.maxGust) { state.maxGust = gustKmh; changed = true; }
        if (instantRR > state.maxRainRate) { state.maxRainRate = instantRR; changed = true; }
        if (changed) saveToDisk();

        let tTrend = 0;
        let pTrend = "Stable";
        if (state.todayHistory.length >= 2) {
            const first = state.todayHistory[0];
            const last = state.todayHistory[state.todayHistory.length - 1];
            const timeDiffHrs = (new Date(last.time) - new Date(first.time)) / 3600000;
            if (timeDiffHrs > 0.02) tTrend = parseFloat(((last.temp - first.temp) / timeDiffHrs).toFixed(1));

            const threeHrsAgo = now - 10800000;
            const pBase = state.todayHistory.find(h => new Date(h.time).getTime() >= threeHrsAgo);
            if (pBase) {
                const pDiff = pressure - pBase.press;
                pTrend = pDiff >= 1 ? "Rising" : pDiff <= -1 ? "Falling" : "Stable";
            }
        }

        state.todayHistory.push({ 
            time: new Date().toISOString(), temp: tempC, hum: hum, wind: windKmh, 
            rain: instantRR, rainTotal: dailyRain, press: pressure, solar: d.solar_and_uvi?.solar?.value || 0 
        });
        if (state.todayHistory.length > 480) state.todayHistory.shift();

        state.cachedData = {
            temp: { current: tempC, max: state.maxTemp, min: state.minTemp, trend: tTrend, realFeel: realFeel },
            atmo: { hum: hum, dew: dewC, press: pressure, pTrend: pTrend },
            wind: { speed: windKmh, gust: gustKmh, maxS: state.maxWindSpeed, maxG: state.maxGust, card: getCard(d.wind.wind_direction.value), deg: d.wind.wind_direction.value },
            rain: { total: dailyRain, rate: instantRR, maxR: state.maxRainRate },
            solar: { rad: d.solar_and_uvi?.solar?.value || 0, uvi: d.solar_and_uvi?.uvi?.value || 0 },
            lastSync: new Date().toISOString(),
            history: state.todayHistory
        };
        state.lastFetchTime = now;
        return state.cachedData;
    } catch (e) { return state.cachedData || { error: "Update failed" }; }
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
    <title>Kk Nagar Weather Hub Pro</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root { 
            --bg: #020617; --card: rgba(15, 23, 42, 0.65); --accent: #38bdf8; 
            --max-t: #f43f5e; --min-t: #3b82f6; --wind: #f59e0b; 
            --rain: #6366f1; --border: rgba(255, 255, 255, 0.08);
            --gap: 24px;
        }
        * { box-sizing: border-box; -webkit-font-smoothing: antialiased; }
        body { 
            margin: 0; font-family: 'Inter', system-ui, -apple-system, sans-serif; 
            background: #020617;
            background-image: 
                radial-gradient(at 0% 0%, rgba(56, 189, 248, 0.12) 0px, transparent 50%),
                radial-gradient(at 100% 0%, rgba(99, 102, 241, 0.12) 0px, transparent 50%);
            color: #f8fafc; padding: 40px 24px; min-height: 100vh;
        }
        .container { width: 100%; max-width: 1200px; margin: 0 auto; }
        .header { margin-bottom: 48px; display: flex; justify-content: space-between; align-items: flex-end; }
        .header h1 { margin: 0; font-size: 32px; font-weight: 900; letter-spacing: -1.5px; }
        
        .grid-system { 
            display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); 
            gap: var(--gap); margin-bottom: var(--gap); 
        }

        .card, .graph-card { 
            background: var(--card); padding: 32px; border-radius: 32px; 
            border: 1px solid var(--border); backdrop-filter: blur(24px);
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
            transition: all 0.3s ease;
        }
        .card:hover { transform: translateY(-5px); border-color: rgba(255, 255, 255, 0.2); }

        .icon-box { margin-bottom: 20px; }
        .icon-box svg { width: 32px; height: 32px; stroke: currentColor; stroke-width: 2.5; fill: none; }

        .label { color: #64748b; font-size: 11px; font-weight: 900; text-transform: uppercase; letter-spacing: 1.5px; }
        .main-val { font-size: 56px; font-weight: 900; margin: 8px 0; letter-spacing: -3px; display: flex; align-items: baseline; }
        .unit { font-size: 20px; font-weight: 500; color: #475569; margin-left: 6px; }

        .sub-box { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 24px; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 20px; }
        .badge { padding: 12px; border-radius: 16px; background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.03); }
        .badge-label { font-size: 9px; color: #475569; text-transform: uppercase; font-weight: 800; display: block; margin-bottom: 4px; }
        .badge-val { font-size: 14px; font-weight: 700; color: #f1f5f9; }

        .dot { width: 8px; height: 8px; background: #22c55e; border-radius: 50%; display: inline-block; margin-right: 8px; box-shadow: 0 0 10px #22c55e; animation: blink 2s infinite; }
        @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

        .graph-card { height: 340px; }

        @media (max-width: 768px) { .header { flex-direction: column; align-items: flex-start; gap: 16px; } .main-val { font-size: 44px; } }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div>
                <p style="color:var(--accent); font-weight: 800; font-size: 12px; margin-bottom: 4px; text-transform: uppercase;">Real-Time Weather Analytics</p>
                <h1>KK Nagar <span style="font-weight: 300; color:#475569;">Digital Station</span></h1>
            </div>
            <div style="text-align: right; font-family: 'JetBrains Mono', monospace; font-size: 12px; color:#475569;">
                <div class="dot"></div> POLLING ACTIVE<br><span id="ts">--:--:--</span>
            </div>
        </div>

        <div class="grid-system">
            <div class="card">
                <div class="icon-box" style="color:var(--max-t)"><svg viewBox="0 0 24 24"><path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/></svg></div>
                <div class="label">Temperature</div>
                <div class="main-val"><span id="t">--</span><span class="unit">°C</span></div>
                <div id="tr" style="font-size: 13px; font-weight: 700;">--</div>
                <div class="sub-box">
                    <div class="badge"><span class="badge-label">RealFeel</span><span id="rf" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Today High</span><span id="mx" class="badge-val" style="color:var(--max-t)">--</span></div>
                    <div class="badge"><span class="badge-label">Humidity</span><span id="h" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Dew Point</span><span id="dp" class="badge-val">--</span></div>
                </div>
            </div>

            <div class="card">
                <div class="icon-box" style="color:var(--wind)"><svg viewBox="0 0 24 24"><path d="M17.7 7.7A7.1 7.1 0 1 1 5 8M7 21l-4-4 4-4M3 17h18"/></svg></div>
                <div class="label">Wind Dynamics</div>
                <div class="main-val"><span id="w">--</span><span class="unit">km/h</span></div>
                <div id="wg" style="font-size: 13px; font-weight: 700; color:var(--wind)">--</div>
                <div class="sub-box">
                    <div class="badge"><span class="badge-label">Peak Speed</span><span id="mw" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Max Gust</span><span id="mg" class="badge-val">--</span></div>
                </div>
            </div>

            <div class="card">
                <div class="icon-box" style="color:var(--accent)"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="m16 12-4-4-4 4M12 8v8"/></svg></div>
                <div class="label">Atmospheric</div>
                <div class="main-val"><span id="pr">--</span><span class="unit">hPa</span></div>
                <div id="p_desc" style="font-size: 13px; font-weight: 700; color:#64748b;">Barometer Stable</div>
                <div class="sub-box">
                    <div class="badge"><span class="badge-label">Solar Rad</span><span id="sol" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">UV Index</span><span id="uv" class="badge-val">--</span></div>
                </div>
            </div>

            <div class="card">
                <div class="icon-box" style="color:var(--rain)"><svg viewBox="0 0 24 24"><path d="M4 14.89c0-4 5-9 5-9s5 5 5 9a5 5 0 1 1-10 0Z"/></svg></div>
                <div class="label">Precipitation</div>
                <div class="main-val"><span id="r">--</span><span class="unit">mm</span></div>
                <div id="rr_main" style="font-size: 13px; font-weight: 700; color:var(--rain)">Rate: 0.0 mm/h</div>
                <div class="sub-box">
                    <div class="badge"><span class="badge-label">Max Rate</span><span id="mr" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Status</span><span id="rain_status" class="badge-val">Dry</span></div>
                </div>
            </div>
        </div>

        <div class="grid-system" style="grid-template-columns: repeat(auto-fit, minmax(450px, 1fr));">
            <div class="graph-card"><canvas id="cT"></canvas></div>
            <div class="graph-card"><canvas id="cH"></canvas></div>
            <div class="graph-card"><canvas id="cW"></canvas></div>
            <div class="graph-card"><canvas id="cR"></canvas></div>
        </div>
    </div>

    <script>
        let charts = {};
        function setupChart(id, label, col, minZero = false) {
            const ctx = document.getElementById(id).getContext('2d');
            const grad = ctx.createLinearGradient(0, 0, 0, 300);
            grad.addColorStop(0, col + '22'); grad.addColorStop(1, col + '00');
            return new Chart(ctx, {
                type: 'line',
                data: { labels: [], datasets: [{ label: label, data: [], borderColor: col, tension: 0.4, pointRadius: 0, borderWidth: 2.5, fill: true, backgroundColor: grad }]},
                options: { 
                    responsive: true, maintainAspectRatio: false, 
                    plugins: { legend: { labels: { color: '#f8fafc', font: { weight: '700', size: 12 } } } },
                    scales: { 
                        x: { ticks: { color: '#475569', font: { size: 10 } }, grid: { display: false } }, 
                        y: { beginAtZero: minZero, grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { color: '#475569', font: { size: 10 } } } 
                    }
                }
            });
        }

        async function update() {
            try {
                const res = await fetch('/weather?v=' + Date.now());
                const d = await res.json();
                
                document.getElementById('t').innerText = d.temp.current;
                document.getElementById('rf').innerText = d.temp.realFeel + '°';
                document.getElementById('mx').innerText = d.temp.max + '°';
                document.getElementById('mx').style.color = 'var(--max-t)';
                document.getElementById('tr').innerText = (d.temp.trend > 0 ? '↗ ' : d.temp.trend < 0 ? '↘ ' : '→ ') + Math.abs(d.temp.trend) + '°C/hr Trend';
                document.getElementById('tr').style.color = d.temp.trend > 0 ? 'var(--max-t)' : d.temp.trend < 0 ? 'var(--min-t)' : '#64748b';

                document.getElementById('h').innerText = d.atmo.hum + '%';
                document.getElementById('dp').innerText = d.atmo.dew + '°';
                document.getElementById('w').innerText = d.wind.speed;
                document.getElementById('wg').innerText = d.wind.card + ' • GUST ' + d.wind.gust;
                document.getElementById('mw').innerText = d.wind.maxS + ' km/h';
                document.getElementById('mg').innerText = d.wind.maxG + ' km/h';
                
                document.getElementById('pr').innerText = d.atmo.press;
                document.getElementById('p_desc').innerText = "Barometer " + d.atmo.pTrend;
                document.getElementById('sol').innerText = d.solar.rad + ' W/m²';
                document.getElementById('uv').innerText = d.solar.uvi;

                document.getElementById('r').innerText = d.rain.total;
                document.getElementById('rr_main').innerText = 'RATE: ' + (d.rain.rate || 0) + ' mm/h';
                document.getElementById('mr').innerText = (d.rain.maxR || 0) + ' mm/h';
                document.getElementById('rain_status').innerText = d.rain.rate > 0 ? 'RAINING' : 'DRY';
                document.getElementById('rain_status').style.color = d.rain.rate > 0 ? 'var(--accent)' : '#f1f5f9';

                document.getElementById('ts').innerText = new Date(d.lastSync).toLocaleTimeString('en-IN', { hour12: false });

                const labels = d.history.map(h => new Date(h.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }));
                if (!charts.cT) {
                    charts.cT = setupChart('cT', 'Temperature (°C)', '#38bdf8');
                    charts.cH = setupChart('cH', 'Humidity (%)', '#10b981', true);
                    charts.cW = setupChart('cW', 'Wind Speed (km/h)', '#f59e0b', true);
                    charts.cR = setupChart('cR', 'Rain Intensity (mm/h)', '#6366f1', true);
                }
                charts.cT.data.labels = labels; charts.cT.data.datasets[0].data = d.history.map(h => h.temp); charts.cT.update('none');
                charts.cH.data.labels = labels; charts.cH.data.datasets[0].data = d.history.map(h => h.hum); charts.cH.update('none');
                charts.cW.data.labels = labels; charts.cW.data.datasets[0].data = d.history.map(h => h.wind); charts.cW.update('none');
                charts.cR.data.labels = labels; charts.cR.data.datasets[0].data = d.history.map(h => h.rain); charts.cR.update('none');
            } catch (e) {}
        }
        setInterval(update, 30000); update();
    </script>
</body>
</html>
    `);
});

module.exports = app;
