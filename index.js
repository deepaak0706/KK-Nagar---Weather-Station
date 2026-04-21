<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>KK Nagar Weather Hub</title>

<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;700;900&display=swap" rel="stylesheet">

<style>
:root { 
    --bg: #e0f2fe !important; 
    --card: rgba(255, 255, 255, 0.85); 
    --border: rgba(2, 132, 199, 0.1);
    --text: #0f172a !important; 
    --muted: #64748b; 
    --accent: #0284c7; 
    --glow: 0 10px 40px -10px rgba(2, 132, 199, 0.15);
    --badge: rgba(2, 132, 199, 0.05);
}

body.is-night {
    --bg: #0f172a !important; 
    --card: rgba(30, 41, 59, 0.7); 
    --border: rgba(255, 255, 255, 0.08);
    --text: #f1f5f9 !important; 
    --muted: #94a3b8; 
    --accent: #38bdf8; 
    --glow: 0 15px 50px -12px rgba(0,0,0,0.6);
    --badge: rgba(255, 255, 255, 0.04);
}

body { 
    margin: 0; 
    font-family: 'Outfit', sans-serif; 
    background: var(--bg); 
    color: var(--text); 
    padding: 20px 16px 120px 16px; 
    transition: background 0.5s ease, color 0.5s ease; 
    min-height: 100vh; 
    overflow-x: hidden; 
}

.container { width: 100%; max-width: 1200px; margin: 0 auto; }

.header { 
    margin-bottom: 32px; 
    display: flex; 
    justify-content: space-between; 
    align-items: center; 
    flex-wrap: wrap; 
    gap: 16px; 
}

.header h1 { 
    font-size: 28px; 
    font-weight: 900; 
    margin: 0; 
}

.status-bar { 
    display: flex; 
    align-items: center; 
    gap: 8px; 
    background: var(--card); 
    padding: 6px 16px; 
    border-radius: 100px; 
    border: 1px solid var(--border); 
}

.live-dot { 
    width: 6px; 
    height: 6px; 
    background: #10b981; 
    border-radius: 50%; 
}

.grid-system { 
    display: grid; 
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); 
    gap: 20px; 
}

.card { 
    background: var(--card); 
    padding: 28px; 
    border-radius: 32px; 
    border: 1px solid var(--border); 
}

.label { 
    color: var(--accent); 
    font-size: 11px; 
    font-weight: 800; 
}

.main-val { 
    font-size: 56px; 
    font-weight: 900; 
}

.sub-box-4 { 
    display: grid; 
    grid-template-columns: 1fr 1fr; 
    gap: 12px; 
    margin-top: 20px; 
}

.badge { 
    padding: 12px; 
    border-radius: 18px; 
    background: var(--badge); 
}

.graphs-wrapper { 
    display: grid; 
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); 
    gap: 20px; 
    margin-top: 20px; 
}
</style>
</head>

<body>
<div class="container">

<div class="header">
<h1>KK Nagar Weather Hub</h1>
<div class="status-bar">
<div class="live-dot"></div>
<div id="ts">--:--</div>
</div>
</div>

<div class="grid-system">

<div class="card">
<div class="label">Temperature</div>
<div class="main-val"><span id="t">--</span>°C</div>
<div class="sub-box-4">
<div class="badge">Max: <span id="mx"></span></div>
<div class="badge">Min: <span id="mn"></span></div>
</div>
</div>

<div class="card">
<div class="label">Wind</div>
<div class="main-val"><span id="w">--</span> km/h</div>
</div>

<div class="card">
<div class="label">Rain</div>
<div class="main-val"><span id="r_tot">--</span> mm</div>
</div>

<div class="card">
<div class="label">Pressure</div>
<div class="main-val"><span id="pr">--</span> hPa</div>
</div>

</div>

<div class="graphs-wrapper">
<canvas id="cT"></canvas>
<canvas id="cH"></canvas>
<canvas id="cW"></canvas>
<canvas id="cR"></canvas>
</div>

async function syncWithEcowitt(forceWrite = false) {
    const now = Date.now();
    const nowIST = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const todayISTStr = nowIST.toLocaleDateString('en-CA'); 
    const hour = nowIST.getHours();
    const minute = nowIST.getMinutes();

    // Reset cache if day changed
    if (state.lastArchivedDate && state.lastArchivedDate !== todayISTStr) {
        state.cachedData = null;
    }

    /**
     * =========================
     * PART 1: VISITOR PATH
     * =========================
     */
    if (!forceWrite && state.cachedData && !state.dataChangedSinceLastRead && (now - state.lastFetchTime < 540000)) {
        try {
            const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}`;
            const response = await fetch(url);
            const json = await response.json();
            const d = json.data;

            const liveTemp = parseFloat(((d.outdoor.temperature.value - 32) * 5 / 9).toFixed(1));
            const liveWind = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));
            const liveGust = parseFloat((d.wind.wind_gust.value * 1.60934).toFixed(1));
            const liveHum = d.outdoor.humidity.value || 0;
            const livePress = parseFloat((d.pressure.relative.value * 33.8639).toFixed(1));

            state.cachedData.atmo.press = livePress;
            state.cachedData.atmo.hum = liveHum;
            state.cachedData.temp.realFeel = calculateRealFeel(liveTemp, liveHum);

            const fmtL = () => new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });

            if (liveTemp > state.cachedData.temp.max) { state.cachedData.temp.max = liveTemp; state.cachedData.temp.maxTime = fmtL(); }
            if (liveTemp < state.cachedData.temp.min) { state.cachedData.temp.min = liveTemp; state.cachedData.temp.minTime = fmtL(); }
            if (liveWind > state.cachedData.wind.maxS) { state.cachedData.wind.maxS = liveWind; state.cachedData.wind.maxSTime = fmtL(); }
            if (liveGust > state.cachedData.wind.maxG) { state.cachedData.wind.maxG = liveGust; state.cachedData.wind.maxGTime = fmtL(); }

            const liveRR = parseFloat((state.lastCalculatedRate * 25.4).toFixed(1));
            if (liveRR > state.cachedData.rain.maxR) { state.cachedData.rain.maxR = liveRR; state.cachedData.rain.maxRTime = fmtL(); }

            state.cachedData.temp.current = liveTemp;
            state.cachedData.wind.speed = liveWind;
            state.cachedData.wind.gust = liveGust;
            state.cachedData.lastSync = new Date().toISOString();

            state.lastFetchTime = now;
            return state.cachedData;

        } catch (e) { 
            return state.cachedData; 
        }
    }

    /**
     * =========================
     * PART 2: WRITER PATH
     * =========================
     */
    try {
        const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}`;
        const response = await fetch(url);
        const json = await response.json();
        const d = json.data;

        const liveTemp = parseFloat(((d.outdoor.temperature.value - 32) * 5 / 9).toFixed(1));
        const liveHum = d.outdoor.humidity.value || 0;
        const livePress = parseFloat((d.pressure.relative.value * 33.8639).toFixed(1));

        let writeSuccess = false;

        if (forceWrite) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                let timeSql = 'NOW()';

                if (hour === 0 && minute < 5) {
                    timeSql = "(date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata') - INTERVAL '1 second'";
                }

                const dbMaxT = state.bufMaxT === -999 ? d.outdoor.temperature.value : state.bufMaxT;
                const dbMinT = state.bufMinT === 999 ? d.outdoor.temperature.value : state.bufMinT;
                const dbW = state.tW === null ? d.wind.wind_speed.value : state.bufW;
                const dbG = state.tG === null ? d.wind.wind_gust.value : state.bufG;
                const dbRR = state.tRR === null ? (state.lastCalculatedRate || 0) : state.bufRR;

                await client.query(`
                    INSERT INTO weather_history 
                    (time, temp_f, temp_min_f, humidity, wind_speed_mph, wind_gust_mph, rain_rate_in, daily_rain_in, 
                     max_w_time, max_t_time, min_t_time, max_r_time, max_g_time, solar_radiation, press_rel)
                    VALUES (${timeSql}, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                `, [
                    dbMaxT, dbMinT, liveHum, dbW, dbG, dbRR, d.rainfall.daily.value,
                    state.tW || new Date().toISOString(), 
                    state.tMaxT || new Date().toISOString(), 
                    state.tMinT || new Date().toISOString(), 
                    state.tRR || new Date().toISOString(), 
                    state.tG || new Date().toISOString(), 
                    d.solar_and_uvi?.solar?.value || 0, 
                    d.pressure.relative.value || 0
                ]);

                /**
                 * MIDNIGHT ARCHIVE (UNCHANGED)
                 */
                if (hour === 0 && minute < 30 && state.lastArchivedDate !== todayISTStr) {
                    await client.query(`
                        INSERT INTO daily_max_records (record_date, max_temp_c, min_temp_c, max_wind_kmh, max_gust_kmh, total_rain_mm)
                        SELECT 
                            (time AT TIME ZONE 'Asia/Kolkata')::date, 
                            MAX((temp_f - 32) * 5/9), MIN((temp_min_f - 32) * 5/9), 
                            MAX(wind_speed_mph * 1.60934), MAX(wind_gust_mph * 1.60934), 
                            MAX(daily_rain_in * 25.4)
                        FROM weather_history 
                        WHERE (time AT TIME ZONE 'Asia/Kolkata')::date < $1::date
                        GROUP BY 1 
                        ON CONFLICT (record_date) DO UPDATE SET 
                            max_temp_c=EXCLUDED.max_temp_c, 
                            min_temp_c=EXCLUDED.min_temp_c, 
                            max_wind_kmh=EXCLUDED.max_wind_kmh, 
                            max_gust_kmh=EXCLUDED.max_gust_kmh, 
                            total_rain_mm=EXCLUDED.total_rain_mm;
                    `, [todayISTStr]);

                    await client.query(`
                        DELETE FROM weather_history 
                        WHERE (time AT TIME ZONE 'Asia/Kolkata')::date < $1::date
                    `, [todayISTStr]);

                    state.lastArchivedDate = todayISTStr;
                    state.cachedData = null;
                    resetStateBuffers();
                }

                await client.query('COMMIT');

                state.dataChangedSinceLastRead = true;
                resetStateBuffers();
                writeSuccess = true;

            } catch (err) {
                await client.query('ROLLBACK');
                console.error("CRITICAL: DB Write Failed.", err);
            } finally {
                client.release();
            }

            state.lastFetchTime = now;
            return writeSuccess 
                ? { status: "success", msg: "DB write complete. Read deferred." } 
                : { status: "error", msg: "Write failed." };
        }

        /**
 * =========================
 * PART 3: GRAPH REBUILDER
 * (Runs only when visitor OR cache invalid)
 * =========================
 */

        let graphHistory = state.cachedData?.history || [];
        let tempRate = state.cachedData?.temp?.rate || 0;
        let humRate = state.cachedData?.atmo?.hTrend || 0;
        let pressRate = state.cachedData?.atmo?.pTrend || 0;

        let mx_t = state.cachedData?.temp?.max || liveTemp;
        let mn_t = state.cachedData?.temp?.min || liveTemp;
        let mx_w = state.cachedData?.wind?.maxS || 0;
        let mx_g = state.cachedData?.wind?.maxG || 0;
        let mx_r = state.cachedData?.rain?.maxR || 0;

        const fmtL = () => new Date().toLocaleTimeString('en-IN', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
            timeZone: 'Asia/Kolkata'
        });

        let mx_t_time = state.cachedData?.temp?.maxTime || fmtL();
        let mn_t_time = state.cachedData?.temp?.minTime || fmtL();
        let mx_w_t = mx_t_time;
        let mx_g_t = mx_t_time;
        let mx_r_t = mx_t_time;

        /**
         * 🔁 REBUILD FROM DB ONLY IF NEEDED
         */
        if (state.dataChangedSinceLastRead || !state.cachedData) {
            try {
                const historyRes = await pool.query(`
                    SELECT * FROM weather_history 
                    WHERE (time AT TIME ZONE 'Asia/Kolkata')::date = $1::date 
                    ORDER BY time ASC
                `, [todayISTStr]);

                graphHistory = [];

                historyRes.rows.forEach(r => {
                    const fmt = (iso) => new Date(iso || r.time).toLocaleTimeString('en-IN', {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                        hour12: false,
                        timeZone: 'Asia/Kolkata'
                    });

                    const r_max_t = parseFloat(((r.temp_f - 32) * 5 / 9).toFixed(1));
                    const r_min_t = parseFloat(((r.temp_min_f - 32) * 5 / 9).toFixed(1));
                    const r_w = parseFloat((r.wind_speed_mph * 1.60934).toFixed(1));
                    const r_g = parseFloat((r.wind_gust_mph * 1.60934).toFixed(1));
                    const r_rr = parseFloat((r.rain_rate_in * 25.4).toFixed(1));

                    // 📊 MAX / MIN TRACKING
                    if (r_max_t > mx_t) { mx_t = r_max_t; mx_t_time = fmt(r.max_t_time); }
                    if (r_min_t < mn_t) { mn_t = r_min_t; mn_t_time = fmt(r.min_t_time); }
                    if (r_w > mx_w) { mx_w = r_w; mx_w_t = fmt(r.max_w_time); }
                    if (r_g > mx_g) { mx_g = r_g; mx_g_t = fmt(r.max_g_time); }
                    if (r_rr > mx_r) { mx_r = r_rr; mx_r_t = fmt(r.max_r_time); }

                    graphHistory.push({
                        time: r.time,
                        temp: r_max_t,
                        hum: r.humidity,
                        wind: r_w,
                        rain: parseFloat((r.daily_rain_in * 25.4).toFixed(1)),
                        press: r.press_rel
                            ? parseFloat((r.press_rel * 33.8639).toFixed(1))
                            : livePress
                    });
                });

                // ✅ IMPORTANT FLAG RESET
                state.dataChangedSinceLastRead = false;

            } catch (dbError) {
                console.error("DB Prep Error:", dbError);
            }
        }

        /**
         * 📈 TREND CALCULATION (1 HOUR DELTA)
         */
        if (graphHistory.length > 0) {
            const oneHourAgo = Date.now() - 3600000;

            let pastRecord = graphHistory.find(r =>
                new Date(r.time).getTime() >= oneHourAgo
            );

            if (!pastRecord) pastRecord = graphHistory[0];

            tempRate = parseFloat((liveTemp - pastRecord.temp).toFixed(1));
            humRate = parseFloat((liveHum - pastRecord.hum).toFixed(1));

            if (pastRecord.press) {
                pressRate = parseFloat((livePress - pastRecord.press).toFixed(1));
            }
        }

        /**
         * 🔴 LIVE OVERRIDE (CRITICAL FOR REALTIME UI)
         */
        const liveWind = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));
        const liveGust = parseFloat((d.wind.wind_gust.value * 1.60934).toFixed(1));
        const liveRR = parseFloat((state.lastCalculatedRate * 25.4).toFixed(1));

        if (liveTemp > mx_t) { mx_t = liveTemp; mx_t_time = fmtL(); }
        if (liveTemp < mn_t) { mn_t = liveTemp; mn_t_time = fmtL(); }
        if (liveWind > mx_w) { mx_w = liveWind; mx_w_t = fmtL(); }
        if (liveGust > mx_g) { mx_g = liveGust; mx_g_t = fmtL(); }
        if (liveRR > mx_r) { mx_r = liveRR; mx_r_t = fmtL(); }

        /**
         * 🧠 FINAL CACHE OBJECT (SOURCE OF TRUTH FOR UI)
         */
        state.cachedData = {
            temp: {
                current: liveTemp,
                max: mx_t,
                maxTime: mx_t_time,
                min: mn_t,
                minTime: mn_t_time,
                realFeel: calculateRealFeel(liveTemp, liveHum),
                rate: tempRate,
                dew: parseFloat((liveTemp - ((100 - liveHum) / 5)).toFixed(1))
            },
            atmo: {
                hum: liveHum,
                hTrend: humRate,
                press: livePress,
                pTrend: pressRate,
                sol: d.solar_and_uvi?.solar?.value || 0,
                uv: d.solar_and_uvi?.uvi?.value || 0
            },
            wind: {
                speed: liveWind,
                gust: liveGust,
                maxS: mx_w,
                maxSTime: mx_w_t,
                maxG: mx_g,
                maxGTime: mx_g_t,
                deg: d.wind.wind_direction.value,
                card: getCard(d.wind.wind_direction.value)
            },
            rain: {
                total: parseFloat((d.rainfall.daily.value * 25.4).toFixed(1)),
                rate: liveRR,
                maxR: mx_r,
                maxRTime: mx_r_t,
                weekly: parseFloat((d.rainfall.weekly.value * 25.4).toFixed(1)),
                monthly: parseFloat((d.rainfall.monthly.value * 25.4).toFixed(1)),
                yearly: parseFloat((d.rainfall.yearly.value * 25.4).toFixed(1))
            },
            history: graphHistory,
            lastSync: new Date().toISOString()
        };

        state.lastFetchTime = now;
        return state.cachedData;

    } catch (e) {
        console.error("Sync Error:", e);
        return state.cachedData;
    }
}

/**
 * ============================
 * PART 4 — ROUTES & API LAYER
 * ============================
 * - Keeps ALL existing behavior intact
 * - Adds support for 24H graph consumption (frontend-driven)
 * - No change to buffer / Davis rain / caching core
 */

/**
 * 1. LIVE DASHBOARD API
 * Uses full smart engine (cache + live override)
 */
app.get("/weather", async (req, res) => {
    try {
        const data = await syncWithEcowitt(false);
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: "Weather fetch failed", details: e.message });
    }
});


/**
 * 2. MONTHLY SUMMARY API
 * (unchanged logic — grouped by month)
 */
app.get("/api/summary", async (req, res) => {
    try {
        const data = await getWeatherSummary();
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: "Summary fetch failed", details: e.message });
    }
});


/**
 * 3. 🔥 NEW — 24 HOUR GRAPH API
 *
 * This is the ONLY backend addition for your new menu.
 * It does NOT interfere with existing system.
 *
 * Logic:
 * - Pull last 24 hours from DB
 * - Convert to frontend-ready format
 */
app.get("/api/last24h", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                time,
                temp_f,
                humidity,
                wind_speed_mph,
                rain_rate_in,
                press_rel
            FROM weather_history
            WHERE time >= NOW() - INTERVAL '24 HOURS'
            ORDER BY time ASC
        `);

        const formatted = result.rows.map(r => ({
            time: r.time,
            temp: parseFloat(((r.temp_f - 32) * 5 / 9).toFixed(1)),
            hum: r.humidity,
            wind: parseFloat((r.wind_speed_mph * 1.60934).toFixed(1)),
            rain: parseFloat((r.rain_rate_in * 25.4).toFixed(1)),
            press: r.press_rel
                ? parseFloat((r.press_rel * 33.8639).toFixed(1))
                : null
        }));

        res.json(formatted);

    } catch (err) {
        console.error("24H API Error:", err);
        res.status(500).json({ error: err.message });
    }
});


/**
 * 4. CRON CONTROL ENDPOINT
 *
 * Modes:
 * - ?buffer=true  → only RAM peak tracking (1 min cron)
 * - ?write=true   → DB write (10 min cron)
 */
app.get("/api/sync", async (req, res) => {
    try {
        if (req.query.buffer === 'true') {
            return res.json(await bufferOnlyUpdate());
        }

        if (req.query.write === 'true') {
            return res.json(await syncWithEcowitt(true));
        }

        res.json({ status: "idle" });

    } catch (e) {
        res.status(500).json({ error: "Sync failed", details: e.message });
    }
});


/**
 * 5. ROOT → HTML UI (Part 5 will replace this)
 */
app.get("/", (req, res) => {
    res.send(`
        <html>
            <head>
                <title>Weather Hub</title>
            </head>
            <body>
                <h2>Server Running</h2>
                <p>Frontend will be injected in Part 5</p>
            </body>
        </html>
    `);
});


/**
 * LOCAL DEV SERVER
 */
if (process.env.NODE_ENV !== 'production') {
    app.listen(3000, () => {
        console.log("Server running at http://localhost:3000");
    });
}

module.exports = app;

<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>KK Nagar Weather Hub</title>

<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>

<style>
body { font-family: Arial; margin:0; background:#0f172a; color:#fff; }
.container { padding:20px; max-width:1200px; margin:auto; }

.nav-tabs { display:flex; gap:10px; margin-bottom:20px; }
.tab-btn {
    padding:10px 20px;
    border:none;
    cursor:pointer;
    background:#1e293b;
    color:#fff;
    border-radius:8px;
}
.tab-btn.active { background:#38bdf8; color:#000; }

.card {
    background:#1e293b;
    padding:20px;
    border-radius:16px;
    margin-bottom:20px;
}

.graph-card {
    height:300px;
    background:#1e293b;
    border-radius:16px;
    padding:10px;
}
</style>
</head>

<body>
<div class="container">

<h1>KK Nagar Weather Hub</h1>

<!-- NAV -->
<div class="nav-tabs">
    <button onclick="showPage('dashboard')" id="tab-dash" class="tab-btn active">Live</button>
    <button onclick="showPage('summary')" id="tab-sum" class="tab-btn">Monthly</button>
    <button onclick="showPage('last24')" id="tab-24" class="tab-btn">Last 24H</button>
</div>

<!-- DASHBOARD -->
<div id="page-dashboard">
    <div class="card">
        <h2>Temperature</h2>
        <div id="t">--</div>
    </div>

    <div class="card">
        <h2>Wind</h2>
        <div id="w">--</div>
    </div>
</div>

<!-- MONTHLY -->
<div id="page-summary" style="display:none;">
    <div id="summary-content">Loading...</div>
</div>

<!-- 24H -->
<div id="page-last24" style="display:none;">
    <div class="graph-card">
        <canvas id="c24"></canvas>
    </div>
</div>

</div>

<script>
let chart24;

/**
 * PAGE SWITCH
 */
function showPage(p) {
    document.getElementById('page-dashboard').style.display = p === 'dashboard' ? 'block' : 'none';
    document.getElementById('page-summary').style.display = p === 'summary' ? 'block' : 'none';
    document.getElementById('page-last24').style.display = p === 'last24' ? 'block' : 'none';

    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    if (p === 'dashboard') document.getElementById('tab-dash').classList.add('active');
    if (p === 'summary') document.getElementById('tab-sum').classList.add('active');
    if (p === 'last24') document.getElementById('tab-24').classList.add('active');

    if (p === 'summary') fetchSummary();
    if (p === 'last24') fetch24h();
}

/**
 * LIVE UPDATE
 */
async function updateLive() {
    const res = await fetch('/weather');
    const d = await res.json();

    document.getElementById('t').innerText = d.temp.current + " °C";
    document.getElementById('w').innerText = d.wind.speed + " km/h";
}

setInterval(updateLive, 30000);
updateLive();

/**
 * MONTHLY SUMMARY
 */
async function fetchSummary() {
    const res = await fetch('/api/summary');
    const data = await res.json();

    let html = "";
    for (const [month, days] of Object.entries(data)) {
        html += "<h3>" + month + "</h3>";
        days.forEach(d => {
            html += "<div>" + d.record_date + " - " + d.max_temp_c + "°C</div>";
        });
    }

    document.getElementById('summary-content').innerHTML = html;
}

/**
 * 🔥 24H GRAPH
 */
async function fetch24h() {
    const res = await fetch('/api/last24h');
    const data = await res.json();

    const labels = data.map(d => new Date(d.time).toLocaleTimeString());
    const temps = data.map(d => d.temp);

    if (!chart24) {
        const ctx = document.getElementById('c24').getContext('2d');
        chart24 = new Chart(ctx, {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    label: 'Temp °C',
                    data: temps,
                    borderWidth: 2
                }]
            }
        });
    } else {
        chart24.data.labels = labels;
        chart24.data.datasets[0].data = temps;
        chart24.update();
    }
}
</script>

</body>
</html>



