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
    maxTempTime: null,
    minTemp: 999,
    minTempTime: null,
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
            state.maxTempTime = saved.maxTempTime ?? null;
            state.minTemp = saved.minTemp ?? 999;
            state.minTempTime = saved.minTempTime ?? null;
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
            maxTempTime: state.maxTempTime,
            minTemp: state.minTemp,
            minTempTime: state.minTempTime,
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
        const d = json.data;

        const tempC = parseFloat(((d.outdoor.temperature.value - 32) * 5 / 9).toFixed(1));
        const hum = d.outdoor.humidity.value;
        const press = parseFloat((d.pressure.relative.value * 33.8639).toFixed(1));
        const dailyRain = parseFloat((d.rainfall.daily.value * 25.4).toFixed(1));
        
        let instantRR = 0;
        if (state.todayHistory.length > 0) {
            const oneMinAgo = now - 70000; 
            const pastRecord = state.todayHistory.find(h => new Date(h.time).getTime() >= oneMinAgo);
            if (pastRecord && dailyRain > pastRecord.rainTotal) {
                const rainDiff = dailyRain - pastRecord.rainTotal;
                const timeDiffMin = (now - new Date(pastRecord.time).getTime()) / 60000;
                instantRR = parseFloat(((rainDiff / timeDiffMin) * 60).toFixed(1));
            }
        }

        const dewC = parseFloat(((d.outdoor.dew_point.value - 32) * 5 / 9).toFixed(1));
        const realFeel = calculateRealFeel(tempC, hum);
        const windKmh = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));
        const gustKmh = parseFloat((d.wind.wind_gust.value * 1.60934).toFixed(1));
        const solar = d.solar_and_uvi?.solar?.value || 0;
        const uvi = d.solar_and_uvi?.uvi?.value || 0;

        const today = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
        const currentTimeStr = new Date(now).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });

        if (state.currentDate !== today) {
            state.currentDate = today;
            state.maxTemp = -999; state.maxTempTime = null; state.minTemp = 999; state.minTempTime = null;
            state.maxWindSpeed = 0; state.maxGust = 0; state.maxRainRate = 0;
            state.todayHistory = [];
        }

        if (tempC > state.maxTemp || state.maxTemp === -999) { state.maxTemp = tempC; state.maxTempTime = currentTimeStr; }
        if (tempC < state.minTemp || state.minTemp === 999) { state.minTemp = tempC; state.minTempTime = currentTimeStr; }
        if (windKmh > state.maxWindSpeed) state.maxWindSpeed = windKmh;
        if (gustKmh > state.maxGust) state.maxGust = gustKmh;
        if (instantRR > state.maxRainRate) state.maxRainRate = instantRR;
        saveToDisk();

        let tTrend = 0, hTrend = 0, pTrend = 0;
        if (state.todayHistory.length >= 2) {
            const first = state.todayHistory[0];
            const timeDiffHrs = (now - new Date(first.time).getTime()) / 3600000;
            if (timeDiffHrs > 0.02) {
                tTrend = parseFloat(((tempC - first.temp) / timeDiffHrs).toFixed(1));
                hTrend = parseFloat(((hum - first.hum) / timeDiffHrs).toFixed(1));
                pTrend = parseFloat(((press - first.press) / timeDiffHrs).toFixed(1));
            }
        }
 
        state.todayHistory.push({ time: new Date().toISOString(), temp: tempC, hum: hum, press: press, wind: windKmh, rain: instantRR, rainTotal: dailyRain, solar: solar });
        if (state.todayHistory.length > 400) state.todayHistory.shift();

        state.cachedData = {
            temp: { current: tempC, max: state.maxTemp, maxTime: state.maxTempTime, min: state.minTemp, minTime: state.minTempTime, trend: tTrend, realFeel: realFeel },
            atmo: { hum: hum, hTrend: hTrend, press: press, pTrend: pTrend, dew: dewC },
            wind: { speed: windKmh, gust: gustKmh, maxS: state.maxWindSpeed, maxG: state.maxGust, card: getCard(d.wind.wind_direction.value), deg: d.wind.wind_direction.value },
            rain: { total: dailyRain, rate: instantRR, maxR: state.maxRainRate },
            solar: { rad: solar, uvi: uvi },
            lastSync: d.time || new Date().toISOString(),
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
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <title>Kk Nagar Hub</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root { 
            --bg: #020617; --card: rgba(15, 23, 42, 0.6); --accent: #38bdf8; 
            --max-t: #fb7185; --min-t: #60a5fa; --wind: #fbbf24; 
            --rain: #818cf8; --border: rgba(255, 255, 255, 0.08);
            --gap: 20px;
        }
        * { box-sizing: border-box; -webkit-font-smoothing: antialiased; }
        body { 
            margin: 0; font-family: 'Inter', sans-serif; 
            background: #020617;
            background-image: radial-gradient(at 0% 0%, rgba(56, 189, 248, 0.08) 0, transparent 50%), 
                              radial-gradient(at 100% 100%, rgba(129, 140, 248, 0.08) 0, transparent 50%);
            color: #f8fafc; padding: 40px 24px; min-height: 100vh;
            display: flex; flex-direction: column; align-items: center;
        }
        body.solar-low { background: #000; }
        .container { width: 100%; max-width: 1200px; }
        
        .header { margin-bottom: 40px; display: flex; justify-content: space-between; align-items: flex-end; }
        .header h1 { margin: 0; font-size: 32px; font-weight: 900; letter-spacing: -1.5px; background: linear-gradient(to bottom right, #fff, #64748b); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        
        .live-pill { background: rgba(34, 197, 94, 0.1); border: 1px solid rgba(34, 197, 94, 0.2); padding: 6px 12px; border-radius: 12px; display: flex; align-items: center; gap: 8px; backdrop-filter: blur(10px); }
        .dot { width: 8px; height: 8px; background: #22c55e; border-radius: 50%; box-shadow: 0 0 10px #22c55e; animation: pulse 2s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        .live-pill span { font-family: 'JetBrains Mono', monospace; font-size: 11px; font-weight: 800; color: #22c55e; letter-spacing: 1px; }

        .grid-system { display: grid; grid-template-columns: repeat(12, 1fr); gap: var(--gap); margin-bottom: var(--gap); }
        
        /* Modern Card Styling */
        .card, .graph-card { 
            background: var(--card); border: 1px solid var(--border); border-radius: 28px; 
            padding: 28px; backdrop-filter: blur(20px); position: relative; overflow: hidden;
            transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.3s ease, border-color 0.4s ease;
        }
        .card:hover { transform: translateY(-4px); border-color: rgba(255,255,255,0.15); }
        
        /* Bento Sizes */
        .col-6 { grid-column: span 6; }
        .col-4 { grid-column: span 4; }
        .col-3 { grid-column: span 3; }
        .col-12 { grid-column: span 12; }

        .label { color: #64748b; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
        .main-val { font-size: 56px; font-weight: 900; letter-spacing: -3px; margin: 0; transition: all 0.5s ease; }
        .unit { font-size: 24px; color: #475569; font-weight: 600; margin-left: 4px; letter-spacing: 0; }
        
        .badge-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-top: 24px; }
        .mini-badge { background: rgba(0,0,0,0.2); padding: 16px; border-radius: 20px; border: 1px solid rgba(255,255,255,0.03); }
        .mini-label { font-size: 9px; color: #64748b; text-transform: uppercase; font-weight: 800; display: block; margin-bottom: 4px; }
        .mini-val { font-size: 15px; font-weight: 700; color: #f1f5f9; }

        .compass-wrap { position: absolute; top: 24px; right: 24px; width: 60px; height: 60px; border: 1px solid var(--border); border-radius: 50%; display: flex; align-items: center; justify-content: center; }
        #needle { width: 3px; height: 40px; background: linear-gradient(to bottom, var(--max-t) 50%, #fff 50%); clip-path: polygon(50% 0%, 100% 100%, 50% 80%, 0% 100%); transition: transform 1.2s ease-out; }

        .graph-card { height: 320px; padding: 20px; grid-column: span 6; }
        canvas { filter: drop-shadow(0 10px 10px rgba(0,0,0,0.2)); }

        /* Status Glows */
        .glow-wind { box-shadow: 0 0 40px rgba(251, 191, 36, 0.1); border-color: rgba(251, 191, 36, 0.2); }
        .glow-rain { box-shadow: 0 0 40px rgba(129, 140, 248, 0.15); border-color: rgba(129, 140, 248, 0.3); }

        @media (max-width: 1024px) { .col-6, .col-4, .col-3 { grid-column: span 12; } .graph-card { grid-column: span 12; } }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div>
                <h1>Kk Nagar Weather</h1>
                <div id="sync-time" style="font-family: 'JetBrains Mono'; font-size: 12px; color: #475569; margin-top: 4px;">--:--:--</div>
            </div>
            <div class="live-pill"><div class="dot"></div><span>LIVE STATION</span></div>
        </div>

        <div class="grid-system">
            <div class="card col-6" id="card-temp">
                <div class="label">Temperature & Trends</div>
                <div style="display: flex; align-items: baseline; gap: 20px;">
                    <div class="main-val"><span id="t">--</span><span class="unit">°C</span></div>
                    <div id="tr" style="font-weight: 800; font-size: 14px;"></div>
                </div>
                <div style="color:var(--accent); font-weight: 700; margin-top: 10px;">Feels like <span id="rf">--</span>°C</div>
                <div class="badge-grid">
                    <div class="mini-badge"><span class="mini-label">Day High</span><span id="mx" class="mini-val" style="color:var(--max-t)">--</span></div>
                    <div class="mini-badge"><span class="mini-label">Day Low</span><span id="mn" class="mini-val" style="color:var(--min-t)">--</span></div>
                    <div class="mini-badge"><span class="mini-label">Humidity</span><span id="h" class="mini-val">--</span></div>
                    <div class="mini-badge"><span class="mini-label">Dew Point</span><span id="dp" class="mini-val">--</span></div>
                </div>
            </div>

            <div class="card col-6" id="card-wind">
                <div class="label">Wind Dynamics</div>
                <div class="compass-wrap"><div id="needle"></div></div>
                <div class="main-val"><span id="w">--</span><span class="unit">km/h</span></div>
                <div id="wg" style="color:var(--wind); font-weight: 800; margin-top: 10px;">--</div>
                <div class="badge-grid">
                    <div class="mini-badge"><span class="mini-label">Peak Wind</span><span id="mw" class="mini-val">--</span></div>
                    <div class="mini-badge"><span class="mini-label">Peak Gust</span><span id="mg" class="mini-val">--</span></div>
                    <div class="mini-badge"><span class="mini-label">Solar</span><span id="sol" class="mini-val">--</span></div>
                    <div class="mini-badge"><span class="mini-label">UV Index</span><span id="uv" class="mini-val" style="color:var(--wind)">--</span></div>
                </div>
            </div>

            <div class="card col-4">
                <div class="label">Barometer <span id="p_tr"></span></div>
                <div class="main-val" style="font-size: 38px;"><span id="pr">--</span><span class="unit">hPa</span></div>
                <div id="p_status" style="font-size: 12px; color: #64748b; font-weight: 700; margin-top: 8px;">--</div>
            </div>

            <div class="card col-8" id="card-rain">
                <div class="label">Precipitation</div>
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div class="main-val"><span id="r">--</span><span class="unit">mm Today</span></div>
                    <div id="rain_status" style="padding: 8px 16px; border-radius: 12px; font-weight: 900; font-size: 12px;">--</div>
                </div>
                <div style="display: flex; gap: 40px; margin-top: 20px;">
                    <div><span class="mini-label">Current Rate</span><span id="rr_main" style="color:var(--rain); font-weight: 800;">--</span></div>
                    <div><span class="mini-label">Max Rate</span><span id="mr" style="color:var(--rain); font-weight: 800;">--</span></div>
                </div>
            </div>

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
                    ctx.save();
                    ctx.beginPath(); ctx.moveTo(x, yAxis.top); ctx.lineTo(x, yAxis.bottom);
                    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)'; ctx.setLineDash([5, 5]); ctx.stroke();
                    ctx.restore();
                    Object.values(charts).forEach(o => {
                        if (o !== chart) {
                            const idx = chart.tooltip.dataPoints[0].index;
                            if (o.getDatasetMeta(0).data[idx]) {
                                o.tooltip.setActiveElements([{ datasetIndex: 0, index: idx }], { x: o.getDatasetMeta(0).data[idx].x, y: o.getDatasetMeta(0).data[idx].y });
                                o.draw();
                            }
                        }
                    });
                }
            }
        };
        Chart.register(syncPlugin);

        function setupChart(id, label, col) {
            const ctx = document.getElementById(id).getContext('2d');
            const g = ctx.createLinearGradient(0, 0, 0, 300); g.addColorStop(0, col + '22'); g.addColorStop(1, col + '00');
            return new Chart(ctx, {
                type: 'line',
                data: { labels: [], datasets: [{ label: label, data: [], borderColor: col, tension: 0.4, pointRadius: 0, borderWidth: 3, fill: true, backgroundColor: g }]},
                options: { 
                    responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
                    plugins: { legend: { display: false }, tooltip: { enabled: true, backgroundColor: 'rgba(15,23,42,0.9)', titleFont: {size: 10}, bodyFont: {size: 12, weight: 'bold'} } },
                    scales: { x: { display: false }, y: { ticks: { color: '#475569', font: {size: 10} }, grid: { color: 'rgba(255,255,255,0.03)' } } }
                }
            });
        }

        async function update() {
            try {
                const res = await fetch('/weather?v=' + Date.now());
                const d = await res.json();
                
                // Numbers
                document.getElementById('t').innerText = d.temp.current;
                document.getElementById('rf').innerText = d.temp.realFeel;
                document.getElementById('mx').innerText = d.temp.max + '°';
                document.getElementById('mn').innerText = d.temp.min + '°';
                document.getElementById('h').innerText = d.atmo.hum + '%';
                document.getElementById('dp').innerText = d.atmo.dew + '°C';
                document.getElementById('w').innerText = d.wind.speed;
                document.getElementById('wg').innerText = d.wind.card + ' / Gust ' + d.wind.gust;
                document.getElementById('mw').innerText = d.wind.maxS + ' km/h';
                document.getElementById('mg').innerText = d.wind.maxG + ' km/h';
                document.getElementById('pr').innerText = d.atmo.press;
                document.getElementById('sol').innerText = d.solar.rad + ' W';
                document.getElementById('uv').innerText = d.solar.uvi;
                document.getElementById('r').innerText = d.rain.total;
                document.getElementById('rr_main').innerText = d.rain.rate + ' mm/h';
                document.getElementById('mr').innerText = d.rain.maxR + ' mm/h';
                
                // Trend Arrow
                const tI = d.temp.trend > 0 ? '↗' : d.temp.trend < 0 ? '↘' : '→';
                document.getElementById('tr').innerHTML = '<span style="color:'+(d.temp.trend >= 0 ? '#fb7185':'#22c55e')+'">'+tI+' '+Math.abs(d.temp.trend)+'°/h</span>';
                
                // Needle
                document.getElementById('needle').style.transform = 'rotate('+d.wind.deg+'deg)';
                
                // UI States
                document.body.classList.toggle('solar-low', d.solar.rad <= 0);
                document.getElementById('card-wind').classList.toggle('glow-wind', d.wind.speed > 15);
                document.getElementById('card-rain').classList.toggle('glow-rain', d.rain.rate > 0);
                
                const rS = d.rain.rate > 0 ? {t:'RAINING', c:'#38bdf8', b:'rgba(56,189,248,0.1)'} : {t:'STABLE', c:'#64748b', b:'rgba(255,255,255,0.05)'};
                const rsEl = document.getElementById('rain_status');
                rsEl.innerText = rS.t; rsEl.style.color = rS.c; rsEl.style.background = rS.b;
                
                const sD = new Date(d.lastSync);
                document.getElementById('sync-time').innerText = 'Last Updated: ' + sD.toLocaleTimeString('en-IN', { hour12: false });

                // Charts
                const lbls = d.history.map(h => new Date(h.time).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', hour12: false}));
                if (!charts.cT) {
                    charts.cT = setupChart('cT', 'Temp', '#38bdf8');
                    charts.cH = setupChart('cH', 'Humidity', '#10b981');
                    charts.cW = setupChart('cW', 'Wind', '#fbbf24');
                    charts.cR = setupChart('cR', 'Rain Rate', '#818cf8');
                }
                charts.cT.data.labels = lbls; charts.cT.data.datasets[0].data = d.history.map(h => h.temp); charts.cT.update('none');
                charts.cH.data.labels = lbls; charts.cH.data.datasets[0].data = d.history.map(h => h.hum); charts.cH.update('none');
                charts.cW.data.labels = lbls; charts.cW.data.datasets[0].data = d.history.map(h => h.wind); charts.cW.update('none');
                charts.cR.data.labels = lbls; charts.cR.data.datasets[0].data = d.history.map(h => h.rain); charts.cR.update('none');
                
            } catch (e) {}
        }
        setInterval(update, 36000); update();
    </script>
</body>
</html>
    `);
});

module.exports = app;
