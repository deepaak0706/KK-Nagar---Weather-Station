const express = require("express"), fetch = require("node-fetch"), fs = require("fs"), app = express();
const { APPLICATION_KEY, API_KEY, MAC } = process.env, STORAGE_FILE = "/tmp/weather_stats.json";

let state = { cachedData: null, todayHistory: [], maxTemp: -999, minTemp: 999, maxWindSpeed: 0, maxGust: 0, maxRainRate: 0, lastFetchTime: 0, currentDate: new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }) };

if (fs.existsSync(STORAGE_FILE)) { try { const s = JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf-8')); if (s.currentDate === state.currentDate) Object.assign(state, s); } catch (e) {} }
const save = () => { try { const { cachedData, lastFetchTime, ...d } = state; fs.writeFileSync(STORAGE_FILE, JSON.stringify(d), 'utf-8'); } catch (e) {} };
const getCard = a => ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"][Math.round(a / 22.5) % 16];
const calcRF = (tc, h) => { let t = (tc * 1.8) + 32, hi = 0.5 * (t + 61 + ((t - 68) * 1.2) + (h * 0.094)); if (hi > 79) hi = -42.379 + 2.049*t + 10.14*h - 0.224*t*h - 0.0068*t*t - 0.054*h*h + 0.0012*t*t*h + 0.00085*t*h*h - 0.00000199*t*t*h*h; return parseFloat(((hi - 32) / 1.8).toFixed(1)); };

async function sync() {
    const now = Date.now(); if (state.cachedData && (now - state.lastFetchTime < 35000)) return state.cachedData;
    try {
        const d = (await (await fetch(`https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}`)).json()).data;
        const tc = parseFloat(((d.outdoor.temperature.value - 32) / 1.8).toFixed(1)), h = d.outdoor.humidity.value, rR = parseFloat((d.rainfall.rain_rate.value * 25.4).toFixed(1)), wK = parseFloat((d.wind.wind_speed.value * 1.609).toFixed(1)), gK = parseFloat((d.wind.wind_gust.value * 1.609).toFixed(1));
        const today = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
        if (state.currentDate !== today) Object.assign(state, { currentDate: today, maxTemp: -999, minTemp: 999, maxWindSpeed: 0, maxGust: 0, maxRainRate: 0, todayHistory: [] });
        state.maxTemp = Math.max(state.maxTemp, tc); state.minTemp = Math.min(state.minTemp === 999 ? tc : state.minTemp, tc);
        state.maxWindSpeed = Math.max(state.maxWindSpeed, wK); state.maxGust = Math.max(state.maxGust, gK); state.maxRainRate = Math.max(state.maxRainRate, rR);
        let tr = 0; if (state.todayHistory.length >= 2) { const old = state.todayHistory[0], hrs = (now - new Date(old.time).getTime()) / 3600000; if (hrs > 0.02) tr = parseFloat(((tc - old.temp) / hrs).toFixed(1)); }
        state.todayHistory.push({ time: new Date().toISOString(), temp: tc, hum: h, wind: wK, rain: rR }); if (state.todayHistory.length > 200) state.todayHistory.shift();
        save();
        return state.cachedData = {
            temp: { current: tc, max: state.maxTemp, min: state.minTemp, trend: tr, realFeel: calcRF(tc, h) },
            atmo: { hum: h, dew: parseFloat(((d.outdoor.dew_point.value - 32) / 1.8).toFixed(1)), press: (d.pressure.relative.value * 33.86).toFixed(1) },
            wind: { speed: wK, gust: gK, maxS: state.maxWindSpeed, maxG: state.maxGust, card: getCard(d.wind.wind_direction.value), deg: d.wind.wind_direction.value },
            rain: { total: parseFloat((d.rainfall.daily.value * 25.4).toFixed(1)), rate: rR, maxR: state.maxRainRate },
            solar: { rad: d.solar_and_uvi?.solar?.value || 0, uvi: d.solar_and_uvi?.uvi?.value || 0 },
            lastSync: new Date().toISOString(), history: state.todayHistory, lastFetchTime: now
        };
    } catch (e) { return state.cachedData || { error: "err" }; }
}

app.get("/weather", async (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(await sync()); });
app.get("/", (req, res) => {
    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Kk Nagar Weather</title><script src="https://cdn.jsdelivr.net/npm/chart.js"></script><style>
    :root { --bg: #020617; --card: rgba(30, 41, 59, 0.7); --accent: #38bdf8; --max-t: #fb7185; --min-t: #60a5fa; --wind: #fbbf24; --rain: #818cf8; --border: rgba(255, 255, 255, 0.1); }
    body { margin: 0; font-family: 'Inter', sans-serif; background: radial-gradient(circle at top left, #0f172a, #020617); color: #f8fafc; padding: 20px; display: flex; flex-direction: column; align-items: center; min-height: 100vh; }
    .container { width: 100%; max-width: 1200px; } .header { margin-bottom: 30px; display: flex; justify-content: space-between; align-items: center; }
    .live { display: inline-flex; align-items: center; gap: 8px; background: rgba(34, 197, 94, 0.1); padding: 6px 12px; border-radius: 100px; border: 1px solid rgba(34, 197, 94, 0.2); font-size: 12px; font-weight: 800; color: #22c55e; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; width: 100%; margin-bottom: 20px; }
    .card, .g-card { background: var(--card); padding: 25px; border-radius: 24px; border: 1px solid var(--border); backdrop-filter: blur(10px); position: relative; }
    .label { color: #94a3b8; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 1px; }
    .val { font-size: 42px; font-weight: 900; margin: 5px 0; display: flex; align-items: baseline; } .unit { font-size: 18px; color: #64748b; margin-left: 5px; }
    .sub { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding-top: 15px; border-top: 1px solid rgba(255,255,255,0.1); }
    .b { padding: 10px; border-radius: 15px; background: rgba(0,0,0,0.2); display: flex; flex-direction: column; } .bl { font-size: 9px; color: #64748b; text-transform: uppercase; } .bv { font-size: 14px; font-weight: 700; }
    .compass { position: absolute; top: 20px; right: 20px; width: 40px; height: 40px; border: 2px solid rgba(255,255,255,0.1); border-radius: 50%; display: flex; align-items: center; justify-content: center; }
    #needle { width: 3px; height: 25px; background: linear-gradient(to bottom, var(--max-t) 50%, #fff 50%); clip-path: polygon(50% 0%, 100% 100%, 50% 85%, 0% 100%); transition: 1s; } .g-card { height: 280px; }
    </style></head><body><div class="container"><div class="header"><h1>Kk Nagar Weather</h1><div class="live"><div id="ts">--:--</div></div></div>
    <div class="grid">
        <div class="card"><div class="label">Temp</div><div class="val"><span id="t">--</span><span class="unit">°C</span></div><div style="font-size:13px;margin-bottom:15px">Feel <span id="rf">--</span> | <span id="tr">--</span></div><div class="sub"><div class="b"><span class="bl">High</span><span id="mx" class="bv" style="color:var(--max-t)">--</span></div><div class="b"><span class="bl">Low</span><span id="mn" class="bv" style="color:var(--min-t)">--</span></div><div class="b"><span class="bl">Hum</span><span id="h" class="bv">--</span></div><div class="b"><span class="bl">Dew</span><span id="dp" class="bv">--</span></div></div></div>
        <div class="card"><div class="label">Wind</div><div class="compass"><div id="needle"></div></div><div class="val"><span id="w">--</span><span class="unit">km/h</span></div><div id="wg" style="font-size:13px;margin-bottom:15px">--</div><div class="sub"><div class="b"><span class="bl">Peak</span><span id="mw" class="bv">--</span></div><div class="b"><span class="bl">Gust</span><span id="mg" class="bv">--</span></div></div></div>
        <div class="card"><div class="label">Atmo & Solar</div><div class="val"><span id="pr">--</span><span class="unit">hPa</span></div><div style="font-size:13px;margin-bottom:15px;color:var(--wind)">UV Index: <span id="uv">--</span></div><div class="sub"><div class="b"><span class="bl">Solar</span><span id="sol" class="bv">--</span></div><div class="b"><span class="bl">Pressure</span><span id="pr2" class="bv">--</span></div></div></div>
        <div class="card"><div class="label">Rain</div><div class="val"><span id="r">--</span><span class="unit">mm</span></div><div style="font-size:13px;margin-bottom:15px;color:var(--rain)">Rate: <span id="rr">--</span> mm/h</div><div class="sub" style="grid-template-columns:1fr"><div class="b"><span class="bl">Max Rate</span><span id="mr" class="bv">--</span></div></div></div>
    </div>
    <div class="grid"><div class="g-card"><canvas id="cT"></canvas></div><div class="g-card"><canvas id="cH"></canvas></div><div class="g-card"><canvas id="cW"></canvas></div><div class="g-card"><canvas id="cR"></canvas></div></div></div><script>
    let charts = {}; const setup = (id, l, c) => new Chart(document.getElementById(id), { type:'line', data:{labels:[], datasets:[{label:l, data:[], borderColor:c, tension:0.4, pointRadius:0, fill:true, backgroundColor:c+'22'}]}, options:{responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{x:{ticks:{display:false}},y:{ticks:{color:'#64748b'}}}}});
    async function up() {
        try { const d = await (await fetch('/weather?v='+Date.now())).json();
        document.getElementById('t').innerText = d.temp.current; document.getElementById('rf').innerText = d.temp.realFeel;
        document.getElementById('tr').innerText = (d.temp.trend > 0 ? '↗ ' : d.temp.trend < 0 ? '↘ ' : '→ ') + Math.abs(d.temp.trend) + '°C/hr';
        document.getElementById('mx').innerText = d.temp.max; document.getElementById('mn').innerText = d.temp.min;
        document.getElementById('h').innerText = d.atmo.hum+'%'; document.getElementById('dp').innerText = d.atmo.dew;
        document.getElementById('w').innerText = d.wind.speed; document.getElementById('wg').innerText = d.wind.card+' | Gust '+d.wind.gust;
        document.getElementById('mw').innerText = d.wind.maxS; document.getElementById('mg').innerText = d.wind.maxG;
        document.getElementById('sol').innerText = d.solar.rad; document.getElementById('uv').innerText = d.solar.uvi;
        document.getElementById('pr').innerText = Math.round(d.atmo.press); document.getElementById('pr2').innerText = d.atmo.press;
        document.getElementById('needle').style.transform = 'rotate('+d.wind.deg+'deg)';
        document.getElementById('r').innerText = d.rain.total; document.getElementById('rr').innerText = d.rain.rate; document.getElementById('mr').innerText = d.rain.maxR;
        document.getElementById('ts').innerText = new Date(d.lastSync).toLocaleTimeString();
        if(!charts.cT){ charts.cT = setup('cT','Temp','#38bdf8'); charts.cH = setup('cH','Hum','#10b981'); charts.cW = setup('cW','Wind','#fbbf24'); charts.cR = setup('cR','Rain','#818cf8'); }
        const lbs = d.history.map(h => ''); charts.cT.data.labels = lbs; charts.cT.data.datasets[0].data = d.history.map(h => h.temp); charts.cT.update('none');
        charts.cH.data.labels = lbs; charts.cH.data.datasets[0].data = d.history.map(h => h.hum); charts.cH.update('none');
        charts.cW.data.labels = lbs; charts.cW.data.datasets[0].data = d.history.map(h => h.wind); charts.cW.update('none');
        charts.cR.data.labels = lbs; charts.cR.data.datasets[0].data = d.history.map(h => h.rain); charts.cR.update('none');
        } catch(e) {}
    } setInterval(up, 35000); up();
    </script></body></html>`);
});
module.exports = app;
