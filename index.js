const express = require(“express”);
const fetch = require(“node-fetch”);
const { Pool } = require(‘pg’);
const path = require(“path”);
const app = express();

/**

- DATABASE CONFIGURATION
  */
  const pool = new Pool({
  connectionString: process.env.POSTGRES_URL + “?sslmode=require”,
  ssl: { rejectUnauthorized: false }
  });

const APPLICATION_KEY = process.env.APPLICATION_KEY;
const API_KEY = process.env.API_KEY;
const MAC = process.env.MAC;

/**

- GLOBAL STATE ENGINE
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
state.bufW = 0;
state.bufG = 0;
state.bufMaxT = -999;
state.bufMinT = 999;
state.bufRR = 0;
state.tW = null;
state.tG = null;
state.tMaxT = null;
state.tMinT = null;
state.tRR = null;
}

const getCard = (a) => {
const directions = [“N”,“NNE”,“NE”,“ENE”,“E”,“ESE”,“SE”,“SSE”,“S”,“SSW”,“SW”,“WSW”,“W”,“WNW”,“NW”,“NNW”];
return directions[Math.round(a / 22.5) % 16];
};

function calculateRealFeel(tempC, humidity) {
const T = (tempC * 9/5) + 32;
const R = humidity;
let hi = 0.5 * (T + 61.0 + ((T - 68.0) * 1.2) + (R * 0.094));
if (hi > 79) {
hi = -42.379 + 2.04901523*T + 10.14333127*R - 0.22475541*T*R
- 0.00683783*T*T - 0.05481717*R*R + 0.00122874*T*T*R
+ 0.00085282*T*R*R - 0.00000199*T*T*R*R;
}
return parseFloat(((hi - 32) * 5 / 9).toFixed(1));
}

// =============================================================================
// 1-MIN CRON: Buffer only, ZERO DB queries
// URL: /api/sync?buffer=true
// =============================================================================
async function bufferOnlyUpdate() {
const now = Date.now();
const currentTimeStamp = new Date().toISOString();

```
try {
    const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}`;
    const response = await fetch(url);
    const json = await response.json();
    if (!json.data) throw new Error("Invalid API Response");
    const d = json.data;

    // Update peak buffers — pure memory, no DB
    const apiW = parseFloat(d.wind.wind_speed.value);
    const apiG = parseFloat(d.wind.wind_gust.value);
    const apiT = parseFloat(d.outdoor.temperature.value);

    if (state.tW === null || apiW > state.bufW)       { state.bufW = apiW; state.tW = currentTimeStamp; }
    if (state.tG === null || apiG > state.bufG)       { state.bufG = apiG; state.tG = currentTimeStamp; }
    if (state.tMaxT === null || apiT > state.bufMaxT) { state.bufMaxT = apiT; state.tMaxT = currentTimeStamp; }
    if (state.tMinT === null || apiT < state.bufMinT) { state.bufMinT = apiT; state.tMinT = currentTimeStamp; }

    // Davis-style rain rate — pure memory
    const rawDailyInches = d.rainfall.daily.value;
    const timeElapsedSec = state.lastFetchTime ? (now - state.lastFetchTime) / 1000 : 0;
    let customRateIn = 0;

    if (state.lastRainRaw !== null && timeElapsedSec > 0) {
        const deltaRain = rawDailyInches - state.lastRainRaw;
        if (deltaRain < 0) {
            state.lastRainTime = now;
            state.lastCalculatedRate = 0;
            state.lastRainRaw = rawDailyInches;
        } else if (deltaRain > 0 && timeElapsedSec >= 30) {
            customRateIn = deltaRain * (3600 / timeElapsedSec);
            state.lastCalculatedRate = customRateIn;
            state.lastRainTime = now;
        } else if (state.lastCalculatedRate > 0) {
            const timeSinceLastRain = (now - state.lastRainTime) / 1000;
            const decayRate = 0.01 * (3600 / timeSinceLastRain);
            if (timeSinceLastRain > 900) {
                state.lastCalculatedRate = 0;
            } else if (decayRate < state.lastCalculatedRate) {
                state.lastCalculatedRate = decayRate;
            }
            customRateIn = state.lastCalculatedRate;
        }
    } else {
        state.lastRainRaw = rawDailyInches;
        state.lastRainTime = now;
        state.lastCalculatedRate = 0;
    }

    state.lastRainRaw = rawDailyInches;

    if (state.tRR === null || customRateIn > state.bufRR) {
        state.bufRR = customRateIn;
        state.tRR = currentTimeStamp;
    }

    state.lastFetchTime = now;

    // Patch cachedData with fresh live values — no DB hit
    if (state.cachedData) {
        const liveTemp        = parseFloat(((d.outdoor.temperature.value - 32) * 5 / 9).toFixed(1));
        const liveDew         = parseFloat(((d.outdoor.dew_point.value - 32) * 5 / 9).toFixed(1));
        const liveHum         = d.outdoor.humidity.value || 0;
        const livePress       = parseFloat((d.pressure.relative.value * 33.8639).toFixed(1));
        const liveWind        = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));
        const liveGust        = parseFloat((d.wind.wind_gust.value * 1.60934).toFixed(1));
        const liveRain24h     = parseFloat((d.rainfall.daily.value * 25.4).toFixed(1));
        const liveRainWeekly  = parseFloat((d.rainfall.weekly.value * 25.4).toFixed(1));
        const liveRainMonthly = parseFloat((d.rainfall.monthly.value * 25.4).toFixed(1));
        const liveRainYearly  = parseFloat((d.rainfall.yearly.value * 25.4).toFixed(1));
        const displayRainRate = parseFloat((customRateIn * 25.4).toFixed(1));

        const formatLiveTime = (iso) => iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }) : "--:--";
        const curBufTMax = parseFloat(((state.bufMaxT - 32) * 5 / 9).toFixed(1));
        const curBufTMin = parseFloat(((state.bufMinT - 32) * 5 / 9).toFixed(1));
        const curBufW    = parseFloat((state.bufW * 1.60934).toFixed(1));
        const curBufG    = parseFloat((state.bufG * 1.60934).toFixed(1));
        const curBufR    = parseFloat((state.bufRR * 25.4).toFixed(1));

        let { max: mx_t, maxTime: mx_t_time, min: mn_t, minTime: mn_t_time } = state.cachedData.temp;
        let { maxS: mx_w, maxSTime: mx_w_t, maxG: mx_g, maxGTime: mx_g_t }   = state.cachedData.wind;
        let { maxR: mx_r, maxRTime: mx_r_t }                                   = state.cachedData.rain;

        if (curBufTMax > mx_t || mx_t === -999) { mx_t = curBufTMax; mx_t_time = formatLiveTime(state.tMaxT); }
        if (curBufTMin < mn_t || mn_t === 999)  { mn_t = curBufTMin; mn_t_time = formatLiveTime(state.tMinT); }
        if (curBufW > mx_w) { mx_w = curBufW; mx_w_t = formatLiveTime(state.tW); }
        if (curBufG > mx_g) { mx_g = curBufG; mx_g_t = formatLiveTime(state.tG); }
        if (curBufR > mx_r) { mx_r = curBufR; mx_r_t = formatLiveTime(state.tRR); }

        state.cachedData = {
            ...state.cachedData,
            temp: { 
                current: liveTemp, dew: liveDew,
                max: mx_t, maxTime: mx_t_time,
                min: mn_t, minTime: mn_t_time,
                realFeel: calculateRealFeel(liveTemp, liveHum),
                rate: state.cachedData.temp.rate
            },
            atmo: { 
                hum: liveHum, 
                hTrend: state.cachedData.atmo.hTrend,
                press: livePress, 
                pTrend: state.cachedData.atmo.pTrend,
                sol: d.solar_and_uvi?.solar?.value || 0, 
                uv: d.solar_and_uvi?.uvi?.value || 0 
            },
            wind: { 
                speed: liveWind, gust: liveGust,
                maxS: mx_w, maxSTime: mx_w_t,
                maxG: mx_g, maxGTime: mx_g_t,
                deg: d.wind.wind_direction.value, 
                card: getCard(d.wind.wind_direction.value) 
            },
            rain: { 
                total: liveRain24h, weekly: liveRainWeekly,
                monthly: liveRainMonthly, yearly: liveRainYearly,
                rate: displayRainRate,
                maxR: mx_r, maxRTime: mx_r_t 
            },
            lastSync: new Date().toISOString()
        };
    }

    return { ok: true, buffered: true };
} catch (e) {
    return { error: e.message };
}
```

}

// =============================================================================
// USER VISIT or 10-MIN CRON: DB wakes here only
// =============================================================================
async function syncWithEcowitt(forceWrite = false) {
const now = Date.now();
const currentTimeStamp = new Date().toISOString();

```
if (!forceWrite && state.cachedData && !state.dataChangedSinceLastRead && (now - state.lastFetchTime < 35000)) {
    return state.cachedData;
}

try {
    const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}`;
    const response = await fetch(url);
    const json = await response.json();
    if (!json.data) throw new Error("Invalid API Response");
    const d = json.data;

    const liveTemp        = parseFloat(((d.outdoor.temperature.value - 32) * 5 / 9).toFixed(1));
    const liveDew         = parseFloat(((d.outdoor.dew_point.value - 32) * 5 / 9).toFixed(1));
    const liveHum         = d.outdoor.humidity.value || 0;
    const livePress       = parseFloat((d.pressure.relative.value * 33.8639).toFixed(1));
    const liveWind        = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));
    const liveGust        = parseFloat((d.wind.wind_gust.value * 1.60934).toFixed(1));
    const liveRain24h     = parseFloat((d.rainfall.daily.value * 25.4).toFixed(1));
    const liveRainWeekly  = parseFloat((d.rainfall.weekly.value * 25.4).toFixed(1));
    const liveRainMonthly = parseFloat((d.rainfall.monthly.value * 25.4).toFixed(1));
    const liveRainYearly  = parseFloat((d.rainfall.yearly.value * 25.4).toFixed(1));

    // Update buffers
    const apiW = parseFloat(d.wind.wind_speed.value);
    const apiG = parseFloat(d.wind.wind_gust.value);
    const apiT = parseFloat(d.outdoor.temperature.value);
    if (state.tW === null || apiW > state.bufW)       { state.bufW = apiW; state.tW = currentTimeStamp; }
    if (state.tG === null || apiG > state.bufG)       { state.bufG = apiG; state.tG = currentTimeStamp; }
    if (state.tMaxT === null || apiT > state.bufMaxT) { state.bufMaxT = apiT; state.tMaxT = currentTimeStamp; }
    if (state.tMinT === null || apiT < state.bufMinT) { state.bufMinT = apiT; state.tMinT = currentTimeStamp; }

    // Davis-style rain rate
    const rawDailyInches = d.rainfall.daily.value;
    const timeElapsedSec = state.lastFetchTime ? (now - state.lastFetchTime) / 1000 : 0;
    let customRateIn = 0;

    if (state.lastRainRaw !== null && timeElapsedSec > 0) {
        const deltaRain = rawDailyInches - state.lastRainRaw;
        if (deltaRain < 0) {
            state.lastRainTime = now; state.lastCalculatedRate = 0; state.lastRainRaw = rawDailyInches;
        } else if (deltaRain > 0 && timeElapsedSec >= 30) {
            customRateIn = deltaRain * (3600 / timeElapsedSec);
            state.lastCalculatedRate = customRateIn; state.lastRainTime = now;
        } else if (state.lastCalculatedRate > 0) {
            const timeSinceLastRain = (now - state.lastRainTime) / 1000;
            const decayRate = 0.01 * (3600 / timeSinceLastRain);
            if (timeSinceLastRain > 900) { state.lastCalculatedRate = 0; }
            else if (decayRate < state.lastCalculatedRate) { state.lastCalculatedRate = decayRate; }
            customRateIn = state.lastCalculatedRate;
        }
    } else {
        state.lastRainRaw = rawDailyInches;
        state.lastRainTime = now;
        state.lastCalculatedRate = 0;
    }

    state.lastRainRaw = rawDailyInches;
    const displayRainRate = parseFloat((customRateIn * 25.4).toFixed(1));
    if (state.tRR === null || customRateIn > state.bufRR) { state.bufRR = customRateIn; state.tRR = currentTimeStamp; }

    // =====================================================================
    // 10-MIN CRON ONLY: Write to DB
    // =====================================================================
    if (forceWrite) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const nowUTC = new Date();
            const nowIST = new Date(nowUTC.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
            const hour   = nowIST.getHours();
            const minute = nowIST.getMinutes();

            // Correct IST-aware backtrack timestamp
            let finalTimestamp = nowUTC;
            if (hour === 0 && minute < 5) {
                const midnightIST = new Date(nowIST);
                midnightIST.setHours(0, 0, 0, 0);
                finalTimestamp = new Date(midnightIST.getTime() - 1);
            }

            const todayISTStr = nowIST.toLocaleDateString('en-CA');

            await client.query(`
                INSERT INTO weather_history 
                (time, temp_f, humidity, wind_speed_mph, wind_gust_mph, daily_rain_in, 
                 solar_radiation, press_rel, rain_rate_in, temp_min_f,
                 max_t_time, min_t_time, max_w_time, max_g_time, max_r_time) 
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
                [
                    finalTimestamp, state.bufMaxT, liveHum, state.bufW, state.bufG,
                    d.rainfall.daily.value, d.solar_and_uvi?.solar?.value || 0,
                    livePress, state.bufRR, state.bufMinT,
                    state.tMaxT || currentTimeStamp, state.tMinT || currentTimeStamp,
                    state.tW    || currentTimeStamp, state.tG    || currentTimeStamp,
                    state.tRR   || currentTimeStamp
                ]);

            // Midnight archive — 00:00–00:04 IST only, once per day
            if (hour === 0 && minute < 5 && state.lastArchivedDate !== todayISTStr) {
                await client.query(`
                    INSERT INTO daily_max_records 
                    (record_date, max_temp_c, min_temp_c, max_wind_kmh, max_gust_kmh, total_rain_mm)
                    SELECT (time AT TIME ZONE 'Asia/Kolkata')::date,
                        MAX((temp_f - 32) * 5/9), 
                        MIN((temp_min_f - 32) * 5/9),
                        MAX(wind_speed_mph * 1.60934), 
                        MAX(wind_gust_mph * 1.60934), 
                        MAX(daily_rain_in * 25.4)
                    FROM weather_history
                    WHERE (time AT TIME ZONE 'Asia/Kolkata')::date 
                          <= ($1::date - INTERVAL '1 day')::date
                    GROUP BY 1
                    ON CONFLICT (record_date) DO UPDATE SET
                        max_temp_c    = EXCLUDED.max_temp_c,
                        min_temp_c    = EXCLUDED.min_temp_c,
                        max_wind_kmh  = EXCLUDED.max_wind_kmh,
                        max_gust_kmh  = EXCLUDED.max_gust_kmh,
                        total_rain_mm = EXCLUDED.total_rain_mm;
                `, [todayISTStr]);

                await client.query(`
                    DELETE FROM weather_history 
                    WHERE (time AT TIME ZONE 'Asia/Kolkata')::date 
                          <= ($1::date - INTERVAL '1 day')::date
                `, [todayISTStr]);

                state.lastArchivedDate     = todayISTStr;
                state.lastSummaryFetchDate = null;
            }

            await client.query('COMMIT');
            state.lastDbWrite = now;
            state.dataChangedSinceLastRead = true;
            resetStateBuffers();

        } catch (err) {
            await client.query('ROLLBACK');
            console.error("10-MIN WRITE FAILED:", err.message);
        } finally {
            client.release();
        }
    }

    // =====================================================================
    // DB READ: History + graphs — runs on user visit or after 10-min write
    // =====================================================================
    let mx_t = -999, mn_t = 999, mx_t_time = "--:--", mn_t_time = "--:--";
    let mx_w = 0, mx_w_t = "--:--", mx_g = 0, mx_g_t = "--:--";
    let mx_r = 0, mx_r_t = "--:--", pTrend = 0, tRate = 0, hTrend = 0;
    let graphHistory = [];

    const historyRes    = await pool.query(`SELECT * FROM weather_history WHERE (time AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date ORDER BY time ASC`);
    const oneHourAgoRes = await pool.query(`SELECT temp_f, humidity FROM weather_history WHERE time >= NOW() - INTERVAL '1 hour' ORDER BY time ASC LIMIT 1`);

    if (historyRes.rows.length > 0) {
        const lastRow   = historyRes.rows[historyRes.rows.length - 1];
        pTrend          = parseFloat((livePress - (lastRow.press_rel || livePress)).toFixed(1));
        const baseTempF = oneHourAgoRes.rows.length > 0 ? oneHourAgoRes.rows[0].temp_f : historyRes.rows[0].temp_f;
        const baseHum   = oneHourAgoRes.rows.length > 0 ? oneHourAgoRes.rows[0].humidity : historyRes.rows[0].humidity;
        tRate           = parseFloat((liveTemp - parseFloat(((baseTempF - 32) * 5 / 9).toFixed(1))).toFixed(1));
        hTrend          = liveHum - baseHum;

        historyRes.rows.forEach(r => {
            const fmt         = (iso) => new Date(iso || r.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
            const r_temp      = parseFloat(((r.temp_f - 32) * 5 / 9).toFixed(1));
            const r_min_temp  = parseFloat(((r.temp_min_f - 32) * 5 / 9).toFixed(1));
            const r_wind      = parseFloat((r.wind_speed_mph * 1.60934).toFixed(1));
            const r_gust      = parseFloat((r.wind_gust_mph * 1.60934).toFixed(1));
            const r_rain_rate = parseFloat((r.rain_rate_in * 25.4).toFixed(1));

            if (r_temp > mx_t)                    { mx_t = r_temp;     mx_t_time = fmt(r.max_t_time); }
            if (r_min_temp < mn_t || mn_t === 999) { mn_t = r_min_temp; mn_t_time = fmt(r.min_t_time); }
            if (r_wind > mx_w)                    { mx_w = r_wind;     mx_w_t    = fmt(r.max_w_time); }
            if (r_gust > mx_g)                    { mx_g = r_gust;     mx_g_t    = fmt(r.max_g_time); }
            if (r_rain_rate > mx_r)               { mx_r = r_rain_rate;mx_r_t    = fmt(r.max_r_time); }

            graphHistory.push({ 
                time: r.time, temp: r_temp, hum: r.humidity, 
                wind: r_wind, rain: parseFloat((r.daily_rain_in * 25.4).toFixed(1)) 
            });
        });
    }

    // Overlay live buffer peaks on DB peaks
    const formatLiveTime = (iso) => iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }) : "--:--";
    const curBufTMax = parseFloat(((state.bufMaxT - 32) * 5 / 9).toFixed(1));
    const curBufTMin = parseFloat(((state.bufMinT - 32) * 5 / 9).toFixed(1));
    const curBufW    = parseFloat((state.bufW * 1.60934).toFixed(1));
    const curBufG    = parseFloat((state.bufG * 1.60934).toFixed(1));
    const curBufR    = parseFloat((state.bufRR * 25.4).toFixed(1));

    if (curBufTMax > mx_t || mx_t === -999) { mx_t = curBufTMax; mx_t_time = formatLiveTime(state.tMaxT); }
    if (curBufTMin < mn_t || mn_t === 999)  { mn_t = curBufTMin; mn_t_time = formatLiveTime(state.tMinT); }
    if (curBufW > mx_w) { mx_w = curBufW; mx_w_t = formatLiveTime(state.tW); }
    if (curBufG > mx_g) { mx_g = curBufG; mx_g_t = formatLiveTime(state.tG); }
    if (curBufR > mx_r) { mx_r = curBufR; mx_r_t = formatLiveTime(state.tRR); }

    state.cachedData = {
        temp: { current: liveTemp, dew: liveDew, max: mx_t, maxTime: mx_t_time, min: mn_t, minTime: mn_t_time, realFeel: calculateRealFeel(liveTemp, liveHum), rate: tRate },
        atmo: { hum: liveHum, hTrend, press: livePress, pTrend, sol: d.solar_and_uvi?.solar?.value || 0, uv: d.solar_and_uvi?.uvi?.value || 0 },
        wind: { speed: liveWind, gust: liveGust, maxS: mx_w, maxSTime: mx_w_t, maxG: mx_g, maxGTime: mx_g_t, deg: d.wind.wind_direction.value, card: getCard(d.wind.wind_direction.value) },
        rain: { total: liveRain24h, weekly: liveRainWeekly, monthly: liveRainMonthly, yearly: liveRainYearly, rate: displayRainRate, maxR: mx_r, maxRTime: mx_r_t },
        history: graphHistory,
        lastSync: new Date().toISOString()
    };

    state.lastFetchTime = now;
    state.dataChangedSinceLastRead = false;
    return state.cachedData;

} catch (e) { return { error: e.message }; }
```

}

// =============================================================================
// SUMMARY — once per day, memory cached
// =============================================================================
async function getWeatherSummary() {
const todayStr = new Date().toLocaleDateString(‘en-CA’, { timeZone: ‘Asia/Kolkata’ });
if (state.summaryCache && state.lastSummaryFetchDate === todayStr) {
return state.summaryCache;
}
try {
const result = await pool.query(`SELECT record_date, max_temp_c, min_temp_c, max_wind_kmh, max_gust_kmh, total_rain_mm  FROM daily_max_records ORDER BY record_date DESC`);
const formattedData = result.rows.reduce((acc, row) => {
const date      = new Date(row.record_date);
const monthYear = date.toLocaleDateString(‘en-IN’, { month: ‘long’, year: ‘numeric’ });
if (!acc[monthYear]) acc[monthYear] = [];
acc[monthYear].push(row);
return acc;
}, {});
state.summaryCache         = formattedData;
state.lastSummaryFetchDate = todayStr;
return formattedData;
} catch (err) {
return { error: err.message };
}
}

// =============================================================================
// ROUTES
// =============================================================================
app.use(express.static(path.join(__dirname, “public”)));

app.get(”/weather”,     async (req, res) => res.json(await syncWithEcowitt(false)));
app.get(”/api/summary”, async (req, res) => res.json(await getWeatherSummary()));
app.get(”/api/sync”,    async (req, res) => {
if (req.query.buffer === ‘true’) return res.json(await bufferOnlyUpdate());
res.json(await syncWithEcowitt(req.query.write === ‘true’));
});

if (process.env.NODE_ENV !== ‘production’) {
app.listen(3000, () => console.log(‘Running at http://localhost:3000’));
}

module.exports = app;
