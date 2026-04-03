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
    <title>Kk Nagar Weather Hub</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root { 
            --bg: #020617; --card: rgba(30, 41, 59, 0.6); --accent: #38bdf8; 
            --max-t: #fb7185; --min-t: #60a5fa; --wind: #fbbf24; 
            --rain: #818cf8; --border: rgba(255, 255, 255, 0.1);
            --gap: 24px;
        }
        * { box-sizing: border-box; -webkit-font-smoothing: antialiased; }
        body { 
            margin: 0; font-family: 'Inter', system-ui, sans-serif; 
            background: #020617; color: #f8fafc; padding: 32px 24px; min-height: 100vh;
            display: flex; flex-direction: column; align-items: center;
        }
        body.solar-low { background: #000; }
        .container { width: 100%; max-width: 1200px; }
        
        .header { margin-bottom: 30px; display: flex; justify-content: space-between; align-items: center; width: 100%; }
        .header h1 { margin: 0; font-size: 26px; font-weight: 800; letter-spacing: -1px; }
        .timestamp { font-family: 'JetBrains Mono', monospace; font-size: 12px; color: #64748b; }

        .grid-system { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: var(--gap); width: 100%; margin-bottom: var(--gap); }
        
        @media (max-width: 768px) {
            .grid-system { display: flex; flex-direction: column; }
            .main-val { font-size: 48px !important; }
        }

        .card, .graph-card { 
            background: var(--card); border: 1px solid var(--border); border-radius: 32px; 
            padding: 32px; backdrop-filter: blur(16px); position: relative;
        }

        .label { color: #94a3b8; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
        .main-val { font-size: 52px; font-weight: 900; margin: 4px 0; display: flex; align-items: baseline; letter-spacing: -2px; }
        .unit { font-size: 22px; font-weight: 600; color: #64748b; margin-left: 6px; }
        .minor-line { font-size: 15px; font-weight: 700; margin-top: 8px; display: flex; align-items: center; gap: 8px; }

        .sub-box-4 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 24px; padding-top: 20px; border-top: 1px solid rgba(255, 255, 255, 0.08); }
        .badge { padding: 14px; border-radius: 20px; background: rgba(15, 23, 42, 0.4); display: flex; flex-direction: column; gap: 6px; border: 1px solid rgba(255,255,255,0.02); }
        .badge-label { font-size: 10px; color: #64748b; text-transform: uppercase; font-weight: 800; }
        .badge-val { font-size: 16px; font-weight: 700; color: #f1f5f9; display: flex; align-items: center; gap: 4px; }
        .time-mark { font-size: 9px; font-weight: 700; color: #64748b; background: rgba(0,0,0,0.2); padding: 2px 5px; border-radius: 5px; }

        .compass-ui { position: absolute; top: 30px; right: 30px; width: 54px; height: 54px; border: 2px solid var(--border); border-radius: 50%; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.2); }
        #needle { width: 4px; height: 34px; background: linear-gradient(to bottom, var(--max-t) 50%, #fff 50%); clip-path: polygon(50% 0%, 100% 100%, 50% 85%, 0% 100%); transition: transform 1.5s ease-out; }
        
        .graph-card { height: 340px; padding: 25px 20px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Kk Nagar Station</h1>
            <div class="timestamp" id="ts">--:--:--</div>
        </div>

        <div class="grid-system">
            <div class="card" id="card-temp">
                <div class="label">Temperature</div>
                <div class="main-val"><span id="t">--</span><span class="unit">°C</span></div>
                <div class="minor-line" style="color:var(--accent)">RealFeel: <span id="rf">--</span>°C</div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Today High</span><span id="mx" class="badge-val" style="color:var(--max-t)">--</span></div>
                    <div class="badge"><span class="badge-label">Today Low</span><span id="mn" class="badge-val" style="color:var(--min-t)">--</span></div>
                    <div class="badge">
                        <div style="display:flex; align-items:center; gap:6px"><span class="badge-label">Humidity</span><span id="h_tr"></span></div>
                        <span id="h" class="badge-val">--</span>
                    </div>
                    <div class="badge"><span class="badge-label">Dew Point</span><span id="dp" class="badge-val">--</span></div>
                </div>
            </div>

            <div class="card" id="card-wind">
                <div class="label">Wind Dynamics</div>
                <div class="compass-ui"><div id="needle"></div></div>
                <div class="main-val"><span id="w">--</span><span class="unit">km/h</span></div>
                <div id="wg" class="minor-line" style="color:var(--wind)">--</div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Peak Wind</span><span id="mw" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Peak Gust</span><span id="mg" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Solar Rad</span><span id="sol" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">UV Index</span><span id="uv" class="badge-val">--</span></div>
                </div>
            </div>

            <div class="card" id="card-rain">
                <div class="label">Atmospheric <span id="p_tr"></span></div>
                <div class="main-val"><span id="pr">--</span><span class="unit">hPa</span></div>
                <div id="p_status" class="minor-line" style="color:#64748b; font-size:13px">Barometer Stable</div>
                <div class="sub-box-4">
                    <div class="badge">
                        <span class="badge-label">Rain Total</span>
                        <span id="r" class="badge-val" style="color:var(--rain)">--</span>
                    </div>
                    <div class="badge">
                        <span class="badge-label">Current Rate</span>
                        <span id="rr_main" class="badge-val" style="color:var(--rain)">--</span>
                    </div>
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
        
        const syncPlugin = {
            id: 'syncPlugin',
            afterDraw: (chart) => {
                if (chart.tooltip?._active?.length) {
                    const x = chart.tooltip._active[0].element.x;
                    const yAxis = chart.scales.y;
                    const ctx = chart.ctx;
                    ctx.save();
                    ctx.beginPath(); ctx.moveTo(x, yAxis.top); ctx.lineTo(x, yAxis.bottom);
                    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)'; ctx.setLineDash([5, 5]); ctx.stroke();
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
            const g = ctx.createLinearGradient(0, 0, 0, 300); g.addColorStop(0, col + '33'); g.addColorStop(1, col + '00');
            return new Chart(ctx, {
                type: 'line',
                data: { labels: [], datasets: [{ label: label, data: [], borderColor: col, tension: 0.4, pointRadius: 0, borderWidth: 3, fill: true, backgroundColor: g }]},
                options: { 
                    responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
                    plugins: { legend: { labels: { color: '#f8fafc', font: { weight: '700' } } } },
                    scales: { 
                        x: { ticks: { color: '#64748b', font: { size: 10 } }, grid: { display: false } }, 
                        y: { ticks: { color: '#64748b', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.03)' } } 
                    }
                }
            });
        }

        async function update() {
            try {
                const res = await fetch('/weather?v=' + Date.now());
                const d = await res.json();
                
                document.getElementById('t').innerText = d.temp.current;
                document.getElementById('rf').innerText = d.temp.realFeel;
                
                // High/Low Typography fix
                const mxT = d.temp.maxTime ? '<span class="time-mark">'+d.temp.maxTime+'</span>' : '';
                const mnT = d.temp.minTime ? '<span class="time-mark">'+d.temp.minTime+'</span>' : '';
                document.getElementById('mx').innerHTML = d.temp.max + '°' + mxT;
                document.getElementById('mn').innerHTML = d.temp.min + '°' + mnT;
                
                // Humidity Trend
                const hT = d.atmo.hTrend > 0 ? {i:'▲',c:'#10b981'} : d.atmo.hTrend < 0 ? {i:'▼',c:'#fb7185'} : {i:'●',c:'#475569'};
                document.getElementById('h_tr').innerHTML = '<span style="color:'+hT.c+'; font-size:10px">'+hT.i+'</span>';
                document.getElementById('h').innerText = d.atmo.hum + '%';
                document.getElementById('dp').innerText = d.atmo.dew + '°C';
                
                // Wind
                document.getElementById('w').innerText = d.wind.speed;
                document.getElementById('wg').innerText = d.wind.card + ' | Gust ' + d.wind.gust;
                document.getElementById('mw').innerText = d.wind.maxS + ' km/h';
                document.getElementById('mg').innerText = d.wind.maxG + ' km/h';
                document.getElementById('needle').style.transform = 'rotate('+d.wind.deg+'deg)';
                document.getElementById('sol').innerText = d.solar.rad + ' W';
                document.getElementById('uv').innerText = d.solar.uvi;

                // Barometer Trend
                const pT = d.atmo.pTrend > 0 ? {i:'▲',c:'#10b981',s:'Rising Pressure'} : d.atmo.pTrend < 0 ? {i:'▼',c:'#fb7185',s:'Falling Pressure'} : {i:'●',c:'#475569',s:'Stable Barometer'};
                document.getElementById('p_tr').innerHTML = '<span style="color:'+pT.c+'; font-size:10px">'+pT.i+'</span>';
                document.getElementById('pr').innerText = d.atmo.press;
                document.getElementById('p_status').innerText = pT.s;
                document.getElementById('p_status').style.color = pT.c;

                // Rain
                document.getElementById('r').innerText = d.rain.total + ' mm';
                document.getElementById('rr_main').innerText = d.rain.rate + ' mm/h';

                const syncDate = new Date(d.lastSync);
                document.getElementById('ts').innerText = syncDate.toLocaleTimeString('en-IN', { hour12: false });

                const labels = d.history.map(h => new Date(h.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }));
                if (!charts.cT) {
                    charts.cT = setupChart('cT', 'Temp (°C)', '#38bdf8');
                    charts.cH = setupChart('cH', 'Humidity (%)', '#10b981');
                    charts.cW = setupChart('cW', 'Wind (km/h)', '#fbbf24');
                    charts.cR = setupChart('cR', 'Rain Rate (mm/h)', '#818cf8');
                }
                charts.cT.data.labels = labels; charts.cT.data.datasets[0].data = d.history.map(h => h.temp); charts.cT.update('none');
                charts.cH.data.labels = labels; charts.cH.data.datasets[0].data = d.history.map(h => h.hum); charts.cH.update('none');
                charts.cW.data.labels = labels; charts.cW.data.datasets[0].data = d.history.map(h => h.wind); charts.cW.update('none');
                charts.cR.data.labels = labels; charts.cR.data.datasets[0].data = d.history.map(h => h.rain); charts.cR.update('none');
                
            } catch (e) {}
        }
        setInterval(update, 36000); update();
    </script>
</body>
</html>
    `);
});

module.exports = app;
