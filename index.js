const express = require("express"); 
const fetch = require("node-fetch");
const { Pool } = require('pg');
const path = require("path");
const app = express();

const pool = new Pool({
    connectionString: process.env.POSTGRES_URL + "?sslmode=require",
    ssl: { rejectUnauthorized: false }
});

const APPLICATION_KEY = process.env.APPLICATION_KEY;
const API_KEY = process.env.API_KEY;
const MAC = process.env.MAC;

/**
 * GLOBAL STATE ENGINE
 */
let state = { 
    cachedData: null, 
    lastFetchTime: 0, 
    lastDbWrite: 0,
    lastRainRaw: null, 
    lastCalculatedRate: 0, 
    lastRainTime: 0, 
    bufW: 0, 
    bufG: 0, 
    bufMaxT: -999, 
    bufMinT: 999, 
    bufRR: 0,
    tW: null, 
    tG: null, 
    tMaxT: null, 
    tMinT: null, 
    tRR: null,
    lastArchivedDate: null,
    dataChangedSinceLastRead: false,
    summaryCache: null,
    lastSummaryFetchDate: null,
};

function resetStateBuffers() {
    state.bufW = 0; state.bufG = 0; state.bufMaxT = -999; state.bufMinT = 999; state.bufRR = 0;
    state.tW = null; state.tG = null; state.tMaxT = null; state.tMinT = null; state.tRR = null;
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
        hi = -42.379 + 2.04901523*T + 10.14333127*R - 0.22475541*T*R - 0.00683783*T*T - 0.05481717*R*R + 0.00122874*T*T*R + 0.00085282*T*R*R - 0.00000199*T*T*R*R;
    }
    return parseFloat(((hi - 32) * 5 / 9).toFixed(1));
}

async function bufferOnlyUpdate() {
    const now = Date.now();
    const currentTimeStamp = new Date().toISOString();
    try {
        const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}`;
        const response = await fetch(url);
        const json = await response.json();
        const d = json.data;
        const apiW = parseFloat(d.wind.wind_speed.value);
        const apiG = parseFloat(d.wind.wind_gust.value);
        const apiT = parseFloat(d.outdoor.temperature.value);

        if (state.tW === null || apiW > state.bufW)       { state.bufW = apiW; state.tW = currentTimeStamp; }
        if (state.tG === null || apiG > state.bufG)       { state.bufG = apiG; state.tG = currentTimeStamp; }
        if (state.tMaxT === null || apiT > state.bufMaxT) { state.bufMaxT = apiT; state.tMaxT = currentTimeStamp; }
        if (state.tMinT === null || apiT < state.bufMinT) { state.bufMinT = apiT; state.tMinT = currentTimeStamp; }

        const rawDailyInches = d.rainfall.daily.value;
        const timeElapsedSec = state.lastFetchTime ? (now - state.lastFetchTime) / 1000 : 0;
        let customRateIn = 0;
        if (state.lastRainRaw !== null && timeElapsedSec > 0) {
            const deltaRain = rawDailyInches - state.lastRainRaw;
            if (deltaRain < 0) { state.lastRainTime = now; state.lastCalculatedRate = 0; state.lastRainRaw = rawDailyInches; }
            else if (deltaRain > 0 && timeElapsedSec >= 30) { customRateIn = deltaRain * (3600 / timeElapsedSec); state.lastCalculatedRate = customRateIn; state.lastRainTime = now; }
            else if (state.lastCalculatedRate > 0) {
                const timeSinceLastRain = (now - state.lastRainTime) / 1000;
                const decayRate = 0.01 * (3600 / timeSinceLastRain);
                if (timeSinceLastRain > 900) { state.lastCalculatedRate = 0; }
                else if (decayRate < state.lastCalculatedRate) { state.lastCalculatedRate = decayRate; }
                customRateIn = state.lastCalculatedRate;
            }
        }
        state.lastRainRaw = rawDailyInches;
        if (state.tRR === null || customRateIn > state.bufRR) { state.bufRR = customRateIn; state.tRR = currentTimeStamp; }
        state.lastFetchTime = now;
        return { ok: true };
    } catch (e) { return { error: e.message }; }
}

async function syncWithEcowitt(forceWrite = false) {
    const now = Date.now();
    const nowIST = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const todayISTStr = nowIST.toLocaleDateString('en-CA'); 
    if (state.lastArchivedDate && state.lastArchivedDate !== todayISTStr) state.cachedData = null;

    try {
        const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}`;
        const response = await fetch(url);
        const json = await response.json();
        const d = json.data;

        const liveTemp = parseFloat(((d.outdoor.temperature.value - 32) * 5 / 9).toFixed(1));
        const liveHum = d.outdoor.humidity.value || 0;
        const livePress = parseFloat((d.pressure.relative.value * 33.8639).toFixed(1));

        if (forceWrite) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const dbMaxT = state.bufMaxT === -999 ? d.outdoor.temperature.value : state.bufMaxT;
                const dbMinT = state.bufMinT === 999 ? d.outdoor.temperature.value : state.bufMinT;
                const dbW = state.tW === null ? d.wind.wind_speed.value : state.bufW;
                const dbG = state.tG === null ? d.wind.wind_gust.value : state.bufG;
                const dbRR = state.tRR === null ? (state.lastCalculatedRate || 0) : state.bufRR;

                await client.query(`INSERT INTO weather_history (time, temp_f, temp_min_f, humidity, wind_speed_mph, wind_gust_mph, rain_rate_in, daily_rain_in, max_w_time, max_t_time, min_t_time, max_r_time, max_g_time, solar_radiation, press_rel) VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`, 
                [dbMaxT, dbMinT, liveHum, dbW, dbG, dbRR, d.rainfall.daily.value, state.tW || new Date().toISOString(), state.tMaxT || new Date().toISOString(), state.tMinT || new Date().toISOString(), state.tRR || new Date().toISOString(), state.tG || new Date().toISOString(), d.solar_and_uvi?.solar?.value || 0, d.pressure.relative.value || 0]);
                
                await client.query('COMMIT');
                state.dataChangedSinceLastRead = true;
                resetStateBuffers();
            } finally { client.release(); }
        }

        let history = [];
        const histRes = await pool.query(`SELECT * FROM weather_history WHERE (time AT TIME ZONE 'Asia/Kolkata')::date = $1::date ORDER BY time ASC`, [todayISTStr]);
        histRes.rows.forEach(r => {
            history.push({
                time: r.time,
                temp: parseFloat(((r.temp_f - 32) * 5 / 9).toFixed(1)),
                hum: r.humidity,
                wind: parseFloat((r.wind_speed_mph * 1.60934).toFixed(1)),
                rain: parseFloat((r.daily_rain_in * 25.4).toFixed(1)),
                press: r.press_rel ? parseFloat((r.press_rel * 33.8639).toFixed(1)) : livePress
            });
        });

        // RESTORED TREND LOGIC
        let tRate = 0, hRate = 0, pRate = 0;
        if (history.length > 1) {
            const past = history.find(r => new Date(r.time) >= (now - 3600000)) || history[0];
            tRate = parseFloat((liveTemp - past.temp).toFixed(1));
            hRate = liveHum - past.hum;
            pRate = parseFloat((livePress - past.press).toFixed(1));
        }

        state.cachedData = {
            temp: { current: liveTemp, max: Math.max(...history.map(h => h.temp), liveTemp), min: Math.min(...history.map(h => h.temp), liveTemp), rate: tRate, realFeel: calculateRealFeel(liveTemp, liveHum) },
            atmo: { hum: liveHum, hTrend: hRate, press: livePress, pTrend: pRate, sol: d.solar_and_uvi?.solar?.value || 0, uv: d.solar_and_uvi?.uvi?.value || 0 },
            wind: { speed: parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1)), gust: parseFloat((d.wind.wind_gust.value * 1.60934).toFixed(1)), deg: d.wind.wind_direction.value, card: getCard(d.wind.wind_direction.value) },
            rain: { total: parseFloat((d.rainfall.daily.value * 25.4).toFixed(1)), rate: parseFloat((state.lastCalculatedRate * 25.4).toFixed(1)) },
            history: history,
            lastSync: new Date().toISOString()
        };
        return state.cachedData;
    } catch (e) { return state.cachedData; }
}

app.get("/weather", async (req, res) => res.json(await syncWithEcowitt(false)));
app.get("/api/summary", async (req, res) => {
    const resDb = await pool.query(`SELECT * FROM daily_max_records ORDER BY record_date DESC`);
    res.json(resDb.rows);
});

app.get("/", (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Weather Hub</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;700;900&display=swap" rel="stylesheet">
    <style>
        :root { --bg: #e0f2fe; --card: rgba(255, 255, 255, 0.85); --text: #0f172a; --accent: #0284c7; --muted: #64748b; }
        body.is-night { --bg: #0f172a; --card: rgba(30, 41, 59, 0.7); --text: #f1f5f9; --accent: #38bdf8; }
        body { margin: 0; font-family: 'Outfit', sans-serif; background: var(--bg); color: var(--text); padding: 20px; transition: 0.5s; }
        .card { background: var(--card); padding: 25px; border-radius: 24px; box-shadow: 0 10px 30px rgba(0,0,0,0.05); margin-bottom: 20px; position: relative; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; }
        .main-val { font-size: 48px; font-weight: 900; }
        .label { text-transform: uppercase; font-size: 11px; letter-spacing: 1px; color: var(--accent); }
        .sub-pill { font-size: 12px; background: rgba(0,0,0,0.05); padding: 5px 10px; border-radius: 10px; display: inline-block; margin: 10px 0; }
        .compass-ui { position: absolute; top: 20px; right: 20px; width: 40px; height: 40px; border: 2px solid var(--accent); border-radius: 50%; }
        #needle { width: 2px; height: 25px; background: red; position: absolute; left: 19px; top: 7px; transition: 2s; }
        .theme-toggle { display: flex; gap: 5px; background: var(--card); padding: 5px; border-radius: 10px; cursor: pointer; }
        .theme-btn { padding: 5px 10px; font-size: 10px; font-weight: 700; border-radius: 5px; }
        .theme-btn.active { background: var(--accent); color: #white; }
        .nav-tabs { display: flex; gap: 10px; margin-bottom: 20px; }
        .tab-btn { padding: 10px 20px; border-radius: 12px; border: none; cursor: pointer; font-weight: 700; background: var(--card); color: var(--text); }
        .tab-btn.active { background: var(--accent); color: white; }
        .graph-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-top: 20px; }
        .graph-card { height: 250px; }
        table { width: 100%; border-collapse: collapse; }
        th, td { text-align: left; padding: 12px; border-bottom: 1px solid rgba(0,0,0,0.05); }
    </style>
</head>
<body>
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:30px;">
        <h1>KK Nagar Hub</h1>
        <div class="theme-toggle">
            <div class="theme-btn" id="btn-light">LIGHT</div>
            <div class="theme-btn" id="btn-dark">DARK</div>
            <div class="theme-btn active" id="btn-auto">AUTO</div>
        </div>
    </div>

    <div class="nav-tabs">
        <button class="tab-btn active" onclick="showPage('dash')">Live</button>
        <button class="tab-btn" onclick="showPage('sum')">24h Summary</button>
    </div>

    <div id="page-dash">
        <div class="grid">
            <div class="card">
                <div class="label">Temperature</div>
                <div class="main-val"><span id="t">0.0</span>°C</div>
                <div id="tTrend" class="sub-pill">Steady</div>
                <div>Feels Like: <span id="rf">--</span></div>
            </div>
            <div class="card">
                <div class="compass-ui"><div id="needle"></div></div>
                <div class="label">Wind</div>
                <div class="main-val"><span id="w">0.0</span> <span id="wd" style="font-size:18px; color:var(--muted)">(--)</span></div>
                <div class="sub-pill">Gust: <span id="wg">0.0</span> km/h</div>
            </div>
            <div class="card">
                <div class="label">Rain</div>
                <div class="main-val"><span id="rt">0.0</span>mm</div>
                <div class="sub-pill">Rate: <span id="rr">0.0</span> mm/h</div>
            </div>
            <div class="card">
                <div class="label">Atmo <span id="pIcon"></span></div>
                <div class="main-val"><span id="pr">--</span></div>
                <div class="sub-pill">Hum: <span id="hum">--</span>% <span id="hTrend"></span></div>
            </div>
        </div>
        
        <div class="graph-grid">
            <div class="card graph-card"><canvas id="cT"></canvas></div>
            <div class="card graph-card"><canvas id="cW"></canvas></div>
        </div>
    </div>

    <div id="page-sum" style="display:none">
        <div class="card">
            <table>
                <thead><tr><th>Date</th><th>Temp High/Low</th><th>Wind/Gust</th><th>Rain</th></tr></thead>
                <tbody id="sum-body"></tbody>
            </table>
        </div>
    </div>

    <script>
        let mode = localStorage.getItem('mode') || 'auto';
        let charts = {};

        function applyTheme() {
            const isDark = mode === 'dark' || (mode === 'auto' && new Date().getHours() >= 18);
            document.body.classList.toggle('is-night', isDark);
            document.querySelectorAll('.theme-btn').forEach(b => b.classList.toggle('active', b.id === 'btn-'+mode));
        }

        document.getElementById('btn-light').onclick = () => { mode='light'; applyTheme(); };
        document.getElementById('btn-dark').onclick = () => { mode='dark'; applyTheme(); };
        document.getElementById('btn-auto').onclick = () => { mode='auto'; applyTheme(); };

        async function update() {
            const res = await fetch('/weather');
            const d = await res.json();
            document.getElementById('t').innerText = d.temp.current;
            document.getElementById('rf').innerText = d.temp.realFeel + '°C';
            document.getElementById('tTrend').innerHTML = d.temp.rate > 0 ? '▲ +' + d.temp.rate + '°C/h' : d.temp.rate < 0 ? '▼ ' + d.temp.rate + '°C/h' : '● Steady';
            
            document.getElementById('w').innerText = d.wind.speed;
            document.getElementById('wd').innerText = '(' + d.wind.card + ')';
            document.getElementById('wg').innerText = d.wind.gust;
            document.getElementById('needle').style.transform = 'rotate('+d.wind.deg+'deg)';
            
            document.getElementById('rt').innerText = d.rain.total;
            document.getElementById('rr').innerText = d.rain.rate > 0 ? d.rain.rate : '0.0';
            
            document.getElementById('pr').innerText = d.atmo.press + ' hPa';
            document.getElementById('hum').innerText = d.atmo.hum;
            document.getElementById('hTrend').innerText = d.atmo.hTrend > 0 ? '▲' : d.atmo.hTrend < 0 ? '▼' : '●';
            
            const pT = d.atmo.pTrend;
            document.getElementById('pIcon').innerHTML = pT >= 0.1 ? '▲' : pT <= -0.1 ? '▼' : '●';

            if(d.history.length > 0) {
                const labels = d.history.map(h => new Date(h.time).getHours() + ':00');
                if(!charts.cT) {
                    charts.cT = new Chart(document.getElementById('cT'), { type:'line', data:{labels, datasets:[{label:'Temp', data:d.history.map(h=>h.temp), borderColor:'red'}]} });
                    charts.cW = new Chart(document.getElementById('cW'), { type:'line', data:{labels, datasets:[{label:'Wind', data:d.history.map(h=>h.wind), borderColor:'orange'}]} });
                } else {
                    charts.cT.data.labels = labels; charts.cT.data.datasets[0].data = d.history.map(h=>h.temp); charts.cT.update();
                }
            }
        }

        function showPage(p) {
            document.getElementById('page-dash').style.display = p==='dash'?'block':'none';
            document.getElementById('page-sum').style.display = p==='sum'?'block':'none';
            if(p==='sum') fetchSum();
        }

        async function fetchSum() {
            const res = await fetch('/api/summary');
            const data = await res.json();
            document.getElementById('sum-body').innerHTML = data.map(r => \`
                <tr>
                    <td>\${new Date(r.record_date).toLocaleDateString()}</td>
                    <td>\${r.max_temp_c}° / \${r.min_temp_c}°</td>
                    <td>\${r.max_wind_kmh} / \${r.max_gust_kmh}</td>
                    <td>\${r.total_rain_mm} mm</td>
                </tr>
            \`).join('');
        }

        applyTheme(); update(); setInterval(update, 30000);
    </script>
</body>
</html>
    `);
});

app.listen(3000);
