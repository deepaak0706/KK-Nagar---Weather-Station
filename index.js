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

function calculateDewPoint(tempC, humidity) {
    const a = 17.27; const b = 237.7;
    const alpha = ((a * tempC) / (b + tempC)) + Math.log(humidity / 100.0);
    return parseFloat(((b * alpha) / (a - alpha)).toFixed(1));
}

function getBaroStatus(trend) {
    if (Math.abs(trend) < 0.1) return "Stable";
    return trend > 0 ? "Rising" : "Falling";
}

async function syncWithEcowitt(forceWrite = false) {
    const now = Date.now();
    if (!forceWrite && state.cachedData && (now - state.lastFetchTime < 45000)) return state.cachedData;

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
        const liveRainRate = parseFloat(((d.rainfall.rain_rate?.value || 0) * 25.4).toFixed(1));

        if (forceWrite || (now - state.lastDbWrite > 120000)) {
            await pool.query(`INSERT INTO weather_history (time, temp_f, humidity, wind_speed_mph, wind_gust_mph, daily_rain_in, solar_radiation, press_rel, rain_rate_in) VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8)`, [d.outdoor.temperature.value, liveHum, d.wind.wind_speed.value, d.wind.wind_gust.value, d.rainfall.daily.value, d.solar_and_uvi?.solar?.value || 0, livePress, d.rainfall.rain_rate?.value || 0]);
            state.lastDbWrite = now;
        }

        const historyRes = await pool.query(`SELECT * FROM weather_history WHERE time >= (CURRENT_DATE AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') ORDER BY time ASC`);
        
        let mx_t = -999, mn_t = 999, mx_t_time = "--:--", mx_w = 0, mx_w_t = "--:--", mx_g = 0, mx_g_t = "--:--", mx_r = 0, mx_r_t = "--:--";
        let tTrend = 0, pTrend = 0, graphHistory = [];

        if (historyRes.rows.length > 0) {
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
                if (r_rain_rate >= mx_r) { mx_r = r_rain_rate; mx_r_t = r_time; }

                graphHistory.push({ time: r.time, temp: r_temp, hum: r.humidity, wind: r_wind, rain: r_rain_rate });
            });
            const last = historyRes.rows[historyRes.rows.length-1];
            const timeDiff = (now - new Date(last.time)) / 60000;
            if(timeDiff > 0) {
                tTrend = parseFloat(((liveTemp - parseFloat(((last.temp_f-32)*5/9).toFixed(1))) * (60/timeDiff)).toFixed(1));
                pTrend = parseFloat((livePress - (last.press_rel || livePress)).toFixed(1));
            }
        }

        state.cachedData = {
            temp: { current: liveTemp, max: mx_t, maxTime: mx_t_time, min: mn_t, minTime: mn_t_time, trend: tTrend, realFeel: calculateRealFeel(liveTemp, liveHum) },
            atmo: { hum: liveHum, press: livePress, dew: calculateDewPoint(liveTemp, liveHum), pTrend: pTrend, pStatus: getBaroStatus(pTrend) },
            wind: { speed: liveWind, gust: liveGust, maxS: mx_w, maxSTime: mx_w_t, maxG: mx_g, maxGTime: mx_g_t, deg: d.wind.wind_direction.value, card: getCard(d.wind.wind_direction.value) },
            rain: { total: parseFloat((d.rainfall.daily.value * 25.4).toFixed(1)), rate: liveRainRate, maxR: mx_r, maxRTime: mx_r_t },
            solar: { rad: d.solar_and_uvi?.solar?.value || 0, uvi: d.solar_and_uvi?.uvi?.value || 0 },
            history: graphHistory,
            lastSync: new Date().toISOString()
        };
        state.lastFetchTime = now;
        return state.cachedData;
    } catch (e) { return state.cachedData || { error: "Sync Error" }; }
}

// CRON JOB ROUTE - Fixes "Cannot GET /api/sync"
app.get("/api/sync", async (req, res) => {
    try {
        await syncWithEcowitt(true);
        res.status(200).json({ success: true, message: "CRON: Data saved to DB" });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

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
        :root { 
            --bg-1: #020617; --bg-2: #0f172a; 
            --card: rgba(15, 23, 42, 0.55); --accent: #38bdf8; 
            --max-t: #fb7185; --min-t: #60a5fa; --wind: #fbbf24; 
            --rain: #818cf8; --border: rgba(255, 255, 255, 0.1); 
        }
        body { margin: 0; font-family: 'Outfit', sans-serif; background: var(--bg-1); color: #f8fafc; padding: 24px; display: flex; flex-direction: column; align-items: center; min-height: 100vh; }
        .container { width: 100%; max-width: 1400px; }
        .header { margin-bottom: 32px; display: flex; justify-content: space-between; align-items: center; }
        .grid-system { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 24px; margin-bottom: 24px; }
        .card, .graph-card { background: var(--card); padding: 32px; border-radius: 28px; border: 1px solid var(--border); backdrop-filter: blur(15px); position: relative; }
        .label { color: #94a3b8; font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 10px; }
        .main-val { font-size: 52px; font-weight: 800; margin: 5px 0; display: flex; align-items: baseline; letter-spacing: -1px; }
        .unit { font-size: 20px; color: #64748b; margin-left: 8px; }
        .trend-badge { display: inline-flex; align-items: center; gap: 8px; padding: 8px 14px; border-radius: 12px; background: rgba(255,255,255,0.06); font-size: 13px; font-weight: 700; margin-bottom: 20px; border: 1px solid rgba(255,255,255,0.05); }
        .trend-icon { width: 18px; height: 18px; stroke-width: 3; fill: none; }
        .sub-box-4 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 20px; border-top: 1px solid var(--border); padding-top: 20px; }
        .badge { background: rgba(0,0,0,0.25); padding: 14px; border-radius: 18px; display: flex; flex-direction: column; gap: 4px; border: 1px solid rgba(255,255,255,0.03); }
        .badge-label { font-size: 10px; color: #64748b; text-transform: uppercase; font-weight: 800; }
        .badge-val { font-size: 15px; font-weight: 700; display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
        .time-mark { font-size: 10px; padding: 2px 6px; background: rgba(255,255,255,0.1); border-radius: 6px; color: #94a3b8; }
        #needle { width: 4px; height: 35px; background: var(--max-t); position: absolute; top: 35px; right: 35px; transform-origin: bottom center; clip-path: polygon(50% 0%, 100% 100%, 50% 80%, 0% 100%); transition: 1.5s cubic-bezier(0.4, 0, 0.2, 1); }
        .graph-card { height: 350px; padding: 25px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header"><h1>KK Nagar Weather</h1><div id="ts">--:--</div></div>
        
        <div class="grid-system">
            <div class="card">
                <div class="label">Temperature</div>
                <div class="main-val"><span id="t">--</span><span class="unit">°C</span></div>
                <div id="tr" class="trend-badge">--</div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Today High</span><span id="mx" class="badge-val" style="color:var(--max-t)">--</span></div>
                    <div class="badge"><span class="badge-label">Today Low</span><span id="mn" class="badge-val" style="color:var(--min-t)">--</span></div>
                    <div class="badge"><span class="badge-label">RealFeel</span><span id="rf" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Dew Point</span><span id="dp" class="badge-val">--</span></div>
                </div>
            </div>

            <div class="card">
                <div class="label">Wind Dynamics</div>
                <div id="needle"></div>
                <div class="main-val"><span id="w">--</span><span class="unit">km/h</span></div>
                <div class="trend-badge" id="wg">--</div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Max Wind</span><span id="mw" class="badge-val" style="color:var(--accent)">--</span></div>
                    <div class="badge"><span class="badge-label">Max Gust</span><span id="mg" class="badge-val" style="color:var(--wind)">--</span></div>
                </div>
            </div>

            <div class="card">
                <div class="label">Precipitation</div>
                <div class="main-val"><span id="rt">--</span><span class="unit">mm</span></div>
                <div class="trend-badge" id="rr_label">Rate: -- mm/h</div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Rain Rate</span><span id="rr" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Max Rate</span><span id="mr" class="badge-val" style="color:var(--rain)">--</span></div>
                </div>
            </div>

            <div class="card">
                <div class="label">Atmospheric</div>
                <div class="main-val"><span id="pr">--</span><span class="unit">hPa</span></div>
                <div class="trend-badge" id="pb">Barometer: --</div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Humidity</span><span id="h" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Solar Rad</span><span id="sol" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">UV Index</span><span id="uv" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Pressure Trend</span><span id="pt" class="badge-val">--</span></div>
                </div>
            </div>
        </div>

        <div class="grid-system">
            <div class="graph-card"><canvas id="cT"></canvas></div>
            <div class="graph-card"><canvas id="cR"></canvas></div>
        </div>
    </div>

    <script>
        let charts = {};
        function getTrendSVG(val) {
            const color = val > 0 ? '#fb7185' : '#10b981';
            const rot = val > 0 ? '0deg' : '180deg';
            return \`<svg class="trend-icon" style="stroke:\${color}; transform:rotate(\${rot})" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7" stroke-linecap="round" stroke-linejoin="round"/></svg> <span style="color:\${color}">\${Math.abs(val)}°C/h Trend</span>\`;
        }

        async function update() {
            try {
                const res = await fetch('/weather?v=' + Date.now());
                const d = await res.json();
                
                // Temp
                document.getElementById('t').innerText = d.temp.current;
                document.getElementById('tr').innerHTML = getTrendSVG(d.temp.trend);
                document.getElementById('mx').innerHTML = d.temp.max + '° <span class="time-mark">' + d.temp.maxTime + '</span>';
                document.getElementById('mn').innerHTML = d.temp.min + '° <span class="time-mark">' + d.temp.minTime + '</span>';
                document.getElementById('rf').innerText = d.temp.realFeel + '°';
                document.getElementById('dp').innerText = d.atmo.dew + '°';
                
                // Wind
                document.getElementById('w').innerText = d.wind.speed;
                document.getElementById('wg').innerText = d.wind.card + ' | Gust ' + d.wind.gust + ' km/h';
                document.getElementById('mw').innerHTML = d.wind.maxS + ' <span class="unit">km/h</span> <span class="time-mark">' + d.wind.maxSTime + '</span>';
                document.getElementById('mg').innerHTML = d.wind.maxG + ' <span class="unit">km/h</span> <span class="time-mark">' + d.wind.maxGTime + '</span>';
                document.getElementById('needle').style.transform = 'rotate(' + d.wind.deg + 'deg)';
                
                // Precipitation
                document.getElementById('rt').innerText = d.rain.total;
                document.getElementById('rr_label').innerText = 'Rate: ' + d.rain.rate + ' mm/h';
                document.getElementById('rr').innerText = d.rain.rate + ' mm/h';
                document.getElementById('mr').innerHTML = d.rain.maxR + ' <span class="time-mark">' + d.rain.maxRTime + '</span>';

                // Atmospheric
                document.getElementById('pr').innerText = d.atmo.press;
                document.getElementById('pb').innerText = 'Barometer: ' + d.atmo.pStatus;
                document.getElementById('pt').innerText = (d.atmo.pTrend > 0 ? '+' : '') + d.atmo.pTrend + ' hPa';
                document.getElementById('h').innerText = d.atmo.hum + '%';
                document.getElementById('sol').innerText = d.solar.rad + ' W/m²';
                document.getElementById('uv').innerText = d.solar.uvi;
                
                document.getElementById('ts').innerText = 'Last Sync: ' + new Date(d.lastSync).toLocaleTimeString('en-IN');

                const labels = d.history.map(h => new Date(h.time).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}));
                if(!charts.cT) {
                    charts.cT = new Chart(document.getElementById('cT'), { type:'line', data:{labels, datasets:[{label:'Temp', data:d.history.map(h=>h.temp), borderColor:'#38bdf8', tension:0.4, fill:true, backgroundColor:'rgba(56,189,248,0.1)', pointRadius:0}]}, options:{maintainAspectRatio:false, plugins:{legend:{display:false}}} });
                    charts.cR = new Chart(document.getElementById('cR'), { type:'bar', data:{labels, datasets:[{label:'Rain Rate', data:d.history.map(h=>h.rain), backgroundColor:'#818cf8', borderRadius:5}]}, options:{maintainAspectRatio:false, plugins:{legend:{display:false}}} });
                } else {
                    charts.cT.data.labels = labels; charts.cT.data.datasets[0].data = d.history.map(h=>h.temp); charts.cT.update();
                    charts.cR.data.labels = labels; charts.cR.data.datasets[0].data = d.history.map(h=>h.rain); charts.cR.update();
                }
            } catch (e) { console.error("Update Error:", e); }
        }
        setInterval(update, 45000); update();
    </script>
</body>
</html>
    `);
});

module.exports = app;
