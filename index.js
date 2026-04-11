const express = require(“express”);
const fetch = require(“node-fetch”);
const { Pool } = require(‘pg’);
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
- 
- THREE separate caches now:
- 1. buffers     → updated every 1-min cron (NO DB)
- 1. cachedData  → updated every 10-min cron OR user visit (DB wakes)
- 1. summaryCache→ updated once per day on user visit
   */
   let state = {
   // Live cache served to frontend
   cachedData: null,
   lastFetchTime: 0,
   lastDbWrite: 0,
  
  // Rain rate tracking (pure memory, no DB)
  lastRainRaw: null,
  lastCalculatedRate: 0,
  lastRainTime: 0,
  
  // Peak buffers — updated every 1-min cron, committed every 10-min
  bufW: 0,        // Max wind speed (mph raw)
  bufG: 0,        // Max gust (mph raw)
  bufMaxT: -999,  // Max temp (F raw)
  bufMinT: 999,   // Min temp (F raw)
  bufRR: 0,       // Max rain rate (in/hr raw)
  
  // Precise timestamps for each buffer peak
  tW: null,
  tG: null,
  tMaxT: null,
  tMinT: null,
  tRR: null,
  
  // Flags
  lastArchivedDate: null,
  dataChangedSinceLastRead: false, // True after 10-min write, reset after user read
  
  // Summary cache
  summaryCache: null,
  lastSummaryFetchDate: null,
  };

/**

- RESET BUFFERS after 10-min DB commit
  */
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
// ROUTE 1: 1-MIN CRON — Buffer only, ZERO DB queries
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

    // Update peak buffers (pure memory comparison, no DB)
    const apiW = parseFloat(d.wind.wind_speed.value);
    const apiG = parseFloat(d.wind.wind_gust.value);
    const apiT = parseFloat(d.outdoor.temperature.value);

    if (state.tW === null || apiW > state.bufW)   { state.bufW = apiW; state.tW = currentTimeStamp; }
    if (state.tG === null || apiG > state.bufG)   { state.bufG = apiG; state.tG = currentTimeStamp; }
    if (state.tMaxT === null || apiT > state.bufMaxT) { state.bufMaxT = apiT; state.tMaxT = currentTimeStamp; }
    if (state.tMinT === null || apiT < state.bufMinT) { state.bufMinT = apiT; state.tMinT = currentTimeStamp; }

    // Davis-style rain rate (pure memory)
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

    // Also update the live values in cachedData so frontend gets fresh readings
    // without hitting the DB — only live sensor values, not history/peaks
    if (state.cachedData) {
        const liveTemp = parseFloat(((d.outdoor.temperature.value - 32) * 5 / 9).toFixed(1));
        const liveDew  = parseFloat(((d.outdoor.dew_point.value - 32) * 5 / 9).toFixed(1));
        const liveHum  = d.outdoor.humidity.value || 0;
        const livePress= parseFloat((d.pressure.relative.value * 33.8639).toFixed(1));
        const liveWind = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));
        const liveGust = parseFloat((d.wind.wind_gust.value * 1.60934).toFixed(1));
        const liveRain24h     = parseFloat((d.rainfall.daily.value * 25.4).toFixed(1));
        const liveRainWeekly  = parseFloat((d.rainfall.weekly.value * 25.4).toFixed(1));
        const liveRainMonthly = parseFloat((d.rainfall.monthly.value * 25.4).toFixed(1));
        const liveRainYearly  = parseFloat((d.rainfall.yearly.value * 25.4).toFixed(1));
        const displayRainRate = parseFloat((customRateIn * 25.4).toFixed(1));

        // Live buffer peaks to overlay on DB peaks
        const formatLiveTime = (iso) => iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }) : "--:--";
        const curBufTMax = parseFloat(((state.bufMaxT - 32) * 5 / 9).toFixed(1));
        const curBufTMin = parseFloat(((state.bufMinT - 32) * 5 / 9).toFixed(1));
        const curBufW    = parseFloat((state.bufW * 1.60934).toFixed(1));
        const curBufG    = parseFloat((state.bufG * 1.60934).toFixed(1));
        const curBufR    = parseFloat((state.bufRR * 25.4).toFixed(1));

        // Pull existing DB peaks from cache, overlay with buffer if higher
        let { max: mx_t, maxTime: mx_t_time, min: mn_t, minTime: mn_t_time } = state.cachedData.temp;
        let { maxS: mx_w, maxSTime: mx_w_t, maxG: mx_g, maxGTime: mx_g_t } = state.cachedData.wind;
        let { maxR: mx_r, maxRTime: mx_r_t } = state.cachedData.rain;

        if (curBufTMax > mx_t || mx_t === -999) { mx_t = curBufTMax; mx_t_time = formatLiveTime(state.tMaxT); }
        if (curBufTMin < mn_t || mn_t === 999)  { mn_t = curBufTMin; mn_t_time = formatLiveTime(state.tMinT); }
        if (curBufW > mx_w) { mx_w = curBufW; mx_w_t = formatLiveTime(state.tW); }
        if (curBufG > mx_g) { mx_g = curBufG; mx_g_t = formatLiveTime(state.tG); }
        if (curBufR > mx_r) { mx_r = curBufR; mx_r_t = formatLiveTime(state.tRR); }

        // Patch cachedData with fresh live values + updated buffer peaks
        // History/graph stays from last DB read — no DB needed
        state.cachedData = {
            ...state.cachedData,
            temp: { 
                current: liveTemp, dew: liveDew,
                max: mx_t, maxTime: mx_t_time,
                min: mn_t, minTime: mn_t_time,
                realFeel: calculateRealFeel(liveTemp, liveHum),
                rate: state.cachedData.temp.rate // Keep last known trend
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
            // history stays unchanged — no DB hit needed
        };
    }

    return { ok: true, buffered: true };
} catch (e) {
    return { error: e.message };
}
```

}

// =============================================================================
// ROUTE 2: USER VISIT (/weather) or 10-MIN CRON (/api/sync?write=true)
// DB wakes here only
// =============================================================================
async function syncWithEcowitt(forceWrite = false) {
const now = Date.now();
const currentTimeStamp = new Date().toISOString();

```
// Serve cache to frontend if fresh and no new DB data
if (!forceWrite && state.cachedData && !state.dataChangedSinceLastRead && (now - state.lastFetchTime < 35000)) {
    return state.cachedData;
}

try {
    const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}`;
    const response = await fetch(url);
    const json = await response.json();
    if (!json.data) throw new Error("Invalid API Response");
    const d = json.data;

    // Metric conversions
    const liveTemp = parseFloat(((d.outdoor.temperature.value - 32) * 5 / 9).toFixed(1));
    const liveDew  = parseFloat(((d.outdoor.dew_point.value - 32) * 5 / 9).toFixed(1));
    const liveHum  = d.outdoor.humidity.value || 0;
    const livePress= parseFloat((d.pressure.relative.value * 33.8639).toFixed(1));
    const liveWind = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));
    const liveGust = parseFloat((d.wind.wind_gust.value * 1.60934).toFixed(1));
    const liveRain24h     = parseFloat((d.rainfall.daily.value * 25.4).toFixed(1));
    const liveRainWeekly  = parseFloat((d.rainfall.weekly.value * 25.4).toFixed(1));
    const liveRainMonthly = parseFloat((d.rainfall.monthly.value * 25.4).toFixed(1));
    const liveRainYearly  = parseFloat((d.rainfall.yearly.value * 25.4).toFixed(1));

    // Also update buffers here in case 1-min cron missed a spike
    const apiW = parseFloat(d.wind.wind_speed.value);
    const apiG = parseFloat(d.wind.wind_gust.value);
    const apiT = parseFloat(d.outdoor.temperature.value);
    if (state.tW === null || apiW > state.bufW)       { state.bufW = apiW; state.tW = currentTimeStamp; }
    if (state.tG === null || apiG > state.bufG)       { state.bufG = apiG; state.tG = currentTimeStamp; }
    if (state.tMaxT === null || apiT > state.bufMaxT) { state.bufMaxT = apiT; state.tMaxT = currentTimeStamp; }
    if (state.tMinT === null || apiT < state.bufMinT) { state.bufMinT = apiT; state.tMinT = currentTimeStamp; }

    // Rain rate
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
    // 10-MIN CRON ONLY: Write buffered peaks to DB
    // =====================================================================
    if (forceWrite) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // 1. Get current time in IST properly
            const nowUTC = new Date();
            const nowIST = new Date(nowUTC.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
            const hour   = nowIST.getHours();
            const minute = nowIST.getMinutes();

            // 2. Build correct IST-aware finalTimestamp
            // If we are in 00:00–00:04 IST, backdate this entry to
            // 23:59:59.999 IST of the day that just ended — so Postgres
            // AT TIME ZONE queries file it under yesterday correctly.
            let finalTimestamp = nowUTC; // Default: use real UTC now
            if (hour === 0 && minute < 5) {
                // IST midnight reference (00:00:00 IST today)
                const midnightIST = new Date(nowIST);
                midnightIST.setHours(0, 0, 0, 0);
                // Subtract 1ms → 23:59:59.999 IST yesterday
                finalTimestamp = new Date(midnightIST.getTime() - 1);
            }

            // 3. IST date string for archive gate comparison
            const todayISTStr = nowIST.toLocaleDateString('en-CA');

            // 4. Insert buffered peaks with correct timestamp
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

            // 5. Midnight archive — only fires in 00:00–00:04 IST window, once per day
            if (hour === 0 && minute < 5 && state.lastArchivedDate !== todayISTStr) {

                // Archive all of yesterday's data into daily_max_records
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

                // Delete yesterday's raw entries from weather_history
                await client.query(`
                    DELETE FROM weather_history 
                    WHERE (time AT TIME ZONE 'Asia/Kolkata')::date 
                          <= ($1::date - INTERVAL '1 day')::date
                `, [todayISTStr]);

                // Lock gate so archive doesn't run again today
                state.lastArchivedDate    = todayISTStr;
                state.lastSummaryFetchDate = null; // Force summary cache refresh
            }

            await client.query('COMMIT');
            state.lastDbWrite = now;
            state.dataChangedSinceLastRead = true; // Tell next user visit to re-read DB
            resetStateBuffers();

        } catch (err) {
            await client.query('ROLLBACK');
            console.error("10-MIN WRITE FAILED:", err.message);
        } finally {
            client.release();
        }
    }

    // =====================================================================
    // DB READ: History + graph — only on user visit or after 10-min write
    // =====================================================================
    let mx_t = -999, mn_t = 999, mx_t_time = "--:--", mn_t_time = "--:--";
    let mx_w = 0, mx_w_t = "--:--", mx_g = 0, mx_g_t = "--:--";
    let mx_r = 0, mx_r_t = "--:--", pTrend = 0, tRate = 0, hTrend = 0;
    let graphHistory = [];

    // Read history from DB (this is what wakes Neon — only here)
    const historyRes     = await pool.query(`SELECT * FROM weather_history WHERE (time AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date ORDER BY time ASC`);
    const oneHourAgoRes  = await pool.query(`SELECT temp_f, humidity FROM weather_history WHERE time >= NOW() - INTERVAL '1 hour' ORDER BY time ASC LIMIT 1`);

    if (historyRes.rows.length > 0) {
        const lastRow  = historyRes.rows[historyRes.rows.length - 1];
        pTrend = parseFloat((livePress - (lastRow.press_rel || livePress)).toFixed(1));
        const baseTempF = oneHourAgoRes.rows.length > 0 ? oneHourAgoRes.rows[0].temp_f : historyRes.rows[0].temp_f;
        const baseHum   = oneHourAgoRes.rows.length > 0 ? oneHourAgoRes.rows[0].humidity : historyRes.rows[0].humidity;
        tRate  = parseFloat((liveTemp - parseFloat(((baseTempF - 32) * 5 / 9).toFixed(1))).toFixed(1));
        hTrend = liveHum - baseHum;

        historyRes.rows.forEach(r => {
            const fmt = (iso) => new Date(iso || r.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
            const r_temp      = parseFloat(((r.temp_f - 32) * 5 / 9).toFixed(1));
            const r_min_temp  = parseFloat(((r.temp_min_f - 32) * 5 / 9).toFixed(1));
            const r_wind      = parseFloat((r.wind_speed_mph * 1.60934).toFixed(1));
            const r_gust      = parseFloat((r.wind_gust_mph * 1.60934).toFixed(1));
            const r_rain_rate = parseFloat((r.rain_rate_in * 25.4).toFixed(1));

            if (r_temp > mx_t)                   { mx_t = r_temp;     mx_t_time = fmt(r.max_t_time); }
            if (r_min_temp < mn_t || mn_t === 999){ mn_t = r_min_temp; mn_t_time = fmt(r.min_t_time); }
            if (r_wind > mx_w)                   { mx_w = r_wind;     mx_w_t   = fmt(r.max_w_time); }
            if (r_gust > mx_g)                   { mx_g = r_gust;     mx_g_t   = fmt(r.max_g_time); }
            if (r_rain_rate > mx_r)              { mx_r = r_rain_rate;mx_r_t   = fmt(r.max_r_time); }

            graphHistory.push({ 
                time: r.time, 
                temp: r_temp, 
                hum: r.humidity, 
                wind: r_wind, 
                rain: parseFloat((r.daily_rain_in * 25.4).toFixed(1)) 
            });
        });
    }

    // Overlay live buffer peaks on top of DB peaks
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
    state.dataChangedSinceLastRead = false; // Reset flag after user read
    return state.cachedData;

} catch (e) { return { error: e.message }; }
```

}

// =============================================================================
// SUMMARY (once per day, cached in memory)
// =============================================================================
async function getWeatherSummary() {
const todayStr = new Date().toLocaleDateString(‘en-CA’, {timeZone: ‘Asia/Kolkata’});
if (state.summaryCache && state.lastSummaryFetchDate === todayStr) {
return state.summaryCache;
}
try {
const result = await pool.query(`SELECT record_date, max_temp_c, min_temp_c, max_wind_kmh, max_gust_kmh, total_rain_mm  FROM daily_max_records ORDER BY record_date DESC`);
const formattedData = result.rows.reduce((acc, row) => {
const date = new Date(row.record_date);
const monthYear = date.toLocaleDateString(‘en-IN’, { month: ‘long’, year: ‘numeric’ });
if (!acc[monthYear]) acc[monthYear] = [];
acc[monthYear].push(row);
return acc;
}, {});
state.summaryCache = formattedData;
state.lastSummaryFetchDate = todayStr;
return formattedData;
} catch (err) {
return { error: err.message };
}
}

// =============================================================================
// ROUTES
// =============================================================================

// Frontend polls this every 45s — DB wakes only if cache stale or new data available
app.get(”/weather”, async (req, res) => res.json(await syncWithEcowitt(false)));

// Two cron jobs:
// 1-min:  /api/sync?buffer=true  → Zero DB, pure memory buffer update
// 10-min: /api/sync?write=true   → DB write + full refresh
app.get(”/api/sync”, async (req, res) => {
if (req.query.buffer === ‘true’) {
return res.json(await bufferOnlyUpdate());
}
res.json(await syncWithEcowitt(req.query.write === ‘true’));
});

// Summary — DB hit only once per day, cached rest of the day
app.get(”/api/summary”, async (req, res) => res.json(await getWeatherSummary()));

app.get(”/”, (req, res) => {
res.send(`

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
            margin: 0; font-family: 'Outfit', sans-serif; background: var(--bg); color: var(--text); 
            padding: 20px 16px 120px 16px; transition: background 0.5s ease, color 0.5s ease; 
            min-height: 100vh; overflow-x: hidden; 
        }
        .container { width: 100%; max-width: 1200px; margin: 0 auto; }
        .header { margin-bottom: 32px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px; }
        .header h1 { font-size: 28px; font-weight: 900; margin: 0; letter-spacing: -1px; }
        .header-actions { display: flex; align-items: center; gap: 12px; }
        .theme-toggle { background: var(--card); border: 1px solid var(--border); padding: 4px; border-radius: 12px; display: flex; gap: 4px; box-shadow: var(--glow); cursor: pointer; }
        .theme-btn { padding: 6px 10px; border-radius: 8px; font-size: 11px; font-weight: 700; transition: 0.3s; color: var(--muted); }
        .theme-btn.active { background: var(--accent); color: white; }
        .status-bar { display: flex; align-items: center; gap: 8px; background: var(--card); padding: 6px 16px; border-radius: 100px; border: 1px solid var(--border); box-shadow: var(--glow); font-size: 13px; }
        .live-dot { width: 6px; height: 6px; background: #10b981; border-radius: 50%; animation: blink 2s infinite; }
        @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        .grid-system { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
        .card { background: var(--card); padding: 28px; border-radius: 32px; border: 1px solid var(--border); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); box-shadow: var(--glow); position: relative; overflow: hidden; transition: background 0.5s ease; }
        #windCanvas { position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 0; pointer-events: none; border-radius: 32px; }
        .card > *:not(canvas) { position: relative; z-index: 5; }
        .label { color: var(--accent); font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 6px; }
        .main-val { font-size: 56px; font-weight: 900; margin: 0; letter-spacing: -2px; display: flex; align-items: baseline; line-height: 1.1; }
        .main-val span:not(.unit), .badge-val { display: inline-block; transition: all 0.6s cubic-bezier(0.34, 1.56, 0.64, 1); font-variant-numeric: tabular-nums; }
        @keyframes magicFade {
            0%   { opacity: 0; filter: blur(12px); transform: scale(0.8) translateY(10px); color: #10b981; }
            30%  { opacity: 0.8; filter: blur(4px); }
            100% { opacity: 1; filter: blur(0); transform: scale(1) translateY(0); }
        }
        .fade-update { animation: magicFade 1.5s cubic-bezier(0.16, 1, 0.3, 1); will-change: transform, opacity, filter; }
        .unit { font-size: 20px; font-weight: 600; color: var(--muted); margin-left: 4px; letter-spacing: 0; }
        .sub-pill { font-size: 12px; font-weight: 800; padding: 6px 12px; border-radius: 10px; background: var(--badge); display: inline-flex; align-items: center; gap: 4px; margin: 12px 0 20px 0; }
        .sub-box-4 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding-top: 20px; border-top: 1px solid var(--border); }
        .badge { padding: 12px; border-radius: 18px; background: var(--badge); display: flex; flex-direction: column; gap: 2px; }
        .badge-label { font-size: 9px; color: var(--muted); text-transform: uppercase; font-weight: 800; }
        .badge-val { font-size: 16px; font-weight: 800; }
        .compass-ui { position: absolute !important; top: 28px !important; right: 28px !important; width: 50px; height: 50px; border: 2px solid var(--border); border-radius: 50%; display: flex; align-items: center; justify-content: center; z-index: 10; }
        #needle { width: 3px; height: 32px; background: linear-gradient(to bottom, #ef4444 50%, var(--muted) 50%); clip-path: polygon(50% 0%, 100% 100%, 50% 85%, 0% 100%); transition: transform 2s cubic-bezier(0.1, 0.9, 0.2, 1); }
        .graphs-wrapper { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-top: 20px; }
        .graph-card { background: var(--card); padding: 24px; border-radius: 32px; border: 1px solid var(--border); height: 320px; box-shadow: var(--glow); display: flex; flex-direction: column; overflow: hidden; transition: background 0.5s ease; }
        .graph-card canvas { flex-grow: 1; width: 100% !important; height: 100% !important; }
        .trend-up { color: #f43f5e; } .trend-down { color: #0ea5e9; }
        .time-mark { font-size: 9px; color: var(--muted); font-weight: 600; margin-left: 2px; background: rgba(0,0,0,0.04); padding: 1px 4px; border-radius: 4px; }
        body.is-night .time-mark { background: rgba(255,255,255,0.1); }
        .nav-tabs { display: flex; gap: 8px; margin-bottom: 25px; }
        .tab-btn { background: var(--card); border: 1px solid var(--border); padding: 12px 24px; border-radius: 16px; color: var(--text); font-weight: 700; cursor: pointer; transition: 0.3s; }
        .tab-btn.active { background: var(--accent); color: white; border-color: var(--accent); box-shadow: var(--glow); }
        .month-section { margin-bottom: 35px; animation: fadeIn 0.5s ease; }
        .month-header { font-size: 20px; font-weight: 800; margin: 25px 0 15px 0; color: var(--accent); display: flex; align-items: center; gap: 10px; }
        .month-header::after { content: ""; height: 2px; flex-grow: 1; background: var(--border); }
        .summary-table-wrapper { overflow-x: auto; background: var(--card); border-radius: 24px; border: 1px solid var(--border); box-shadow: var(--glow); }
        .summary-table { width: 100%; border-collapse: collapse; min-width: 600px; }
        .summary-table th { padding: 16px; background: var(--badge); text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); }
        .summary-table td { padding: 16px; border-top: 1px solid var(--border); font-size: 14px; }
        .summary-table tr:hover { background: var(--badge); }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>KK Nagar Weather Hub</h1>
            <div class="header-actions">
                <div class="status-bar"><div class="live-dot"></div><div class="timestamp"><span id="ts">--:--:--</span></div></div>
                <div class="theme-toggle" id="themeToggle">
                    <div class="theme-btn" id="btn-light">LIGHT</div>
                    <div class="theme-btn" id="btn-dark">DARK</div>
                    <div class="theme-btn active" id="btn-auto">AUTO</div>
                </div>
            </div>
        </div>

```
    <div class="nav-tabs">
        <button onclick="showPage('dashboard')" id="tab-dash" class="tab-btn active">Live Dashboard</button>
        <button onclick="showPage('summary')" id="tab-sum" class="tab-btn">Monthly Summary</button>
    </div>

    <div id="page-dashboard">
        <div class="grid-system">
            <div class="card">
                <div class="label">Temperature</div>
                <div class="main-val"><span id="t">0.0</span><span class="unit">°C</span></div>
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
                <canvas id="windCanvas"></canvas>
                <div class="label">Wind Dynamics</div>
                <div class="compass-ui"><div id="needle"></div></div>
                <div class="main-val"><span id="w">0.0</span><span id="wd_bracket" style="font-size:18px; color:var(--muted); margin-left:8px; font-weight:700">(--)</span><span class="unit">km/h</span></div>
                <div class="sub-pill">● Live Gust: <span id="wg" style="margin-left:4px">--</span></div>
                <div class="sub-box-4">
                    <div class="badge"><span class="badge-label">Max Speed</span><span id="mw" class="badge-val">--</span></div>
                    <div class="badge"><span class="badge-label">Max Gust</span><span id="mg" class="badge-val">--</span></div>
                </div>
            </div>
            <div class="card">
                <div class="label">Rain Realm</div>
                <div class="main-val"><span id="r_tot">0.0</span><span class="unit">mm</span></div>
                <div class="sub-pill">● Rain Rate: <span id="r_rate">0.0</span> mm/h</div>
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
            <div class="graph-card"><div class="label" style="margin-bottom: 8px;">Temperature Trend</div><canvas id="cT"></canvas></div>
            <div class="graph-card"><div class="label" style="margin-bottom: 8px;">Humidity Levels</div><canvas id="cH"></canvas></div>
            <div class="graph-card"><div class="label" style="margin-bottom: 8px;">Wind Velocity</div><canvas id="cW"></canvas></div>
            <div class="graph-card"><div class="label" style="margin-bottom: 8px;">Precipitation</div><canvas id="cR"></canvas></div>
        </div>
    </div>

    <div id="page-summary" style="display: none;">
        <div id="summary-content"></div>
    </div>
</div>

<script>
    let currentMode = localStorage.getItem('weatherMode') || 'auto';
    let charts = {};
    let liveWindSpeed = 0, liveWindDeg = 0, particles = [];
    const wCanvas = document.getElementById('windCanvas');
    const ctxW = wCanvas.getContext('2d');

    for(let i=0; i<40; i++) { particles.push({ x: Math.random() * 800, y: Math.random() * 800, s: 0.6 + Math.random() }); }

    Chart.register({
        id: 'customChartEnhancements',
        afterDraw: (chart) => {
            if (chart.tooltip?._active?.length) {
                const x = chart.tooltip._active[0].element.x;
                const yAxis = chart.scales.y;
                const ctx = chart.ctx;
                ctx.save(); ctx.setLineDash([5, 5]); ctx.beginPath(); ctx.moveTo(x, yAxis.top); ctx.lineTo(x, yAxis.bottom);
                ctx.lineWidth = 1; ctx.strokeStyle = document.body.classList.contains('is-night') ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)';
                ctx.stroke(); ctx.restore();
            }
        },
        afterDatasetsDraw: (chart) => {
            const { ctx, data } = chart;
            const dataset = data.datasets[0];
            if (!dataset || !dataset.data || dataset.data.length < 2) return;
            const maxVal = Math.max(...dataset.data);
            const maxIndex = dataset.data.lastIndexOf(maxVal);
            const meta = chart.getDatasetMeta(0);
            const point = meta.data[maxIndex];
            if (point && maxVal > -50) {
                ctx.save(); ctx.beginPath(); ctx.arc(point.x, point.y, 5, 0, 2 * Math.PI); ctx.strokeStyle = dataset.borderColor; ctx.lineWidth = 2; ctx.stroke();
                ctx.beginPath(); ctx.arc(point.x, point.y, 2, 0, 2 * Math.PI); ctx.fillStyle = '#fff'; ctx.fill();
                ctx.fillStyle = document.body.classList.contains('is-night') ? '#94a3b8' : '#475569'; ctx.font = 'bold 10px Outfit'; ctx.textAlign = 'center'; ctx.fillText('MAX', point.x, point.y - 12); ctx.restore();
            }
        }
    });

    function applyTheme() {
        const hour = new Date().getHours();
        const isDark = currentMode === 'dark' || (currentMode === 'auto' && (hour >= 18 || hour < 6));
        isDark ? document.body.classList.add('is-night') : document.body.classList.remove('is-night');
        document.querySelectorAll('.theme-btn').forEach(btn => btn.classList.remove('active'));
        if (currentMode === 'light') document.getElementById('btn-light').classList.add('active');
        else if (currentMode === 'dark') document.getElementById('btn-dark').classList.add('active');
        else document.getElementById('btn-auto').classList.add('active');
        if (charts.cT) updateChartColors();
    }

    document.getElementById('btn-light').onclick = () => { currentMode = 'light'; localStorage.setItem('weatherMode', 'light'); applyTheme(); };
    document.getElementById('btn-dark').onclick  = () => { currentMode = 'dark';  localStorage.setItem('weatherMode', 'dark');  applyTheme(); };
    document.getElementById('btn-auto').onclick  = () => { currentMode = 'auto';  localStorage.setItem('weatherMode', 'auto');  applyTheme(); };

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

    function setupChart(id, label, color, minVal = null) {
        const canvas = document.getElementById(id);
        const ctx = canvas.getContext('2d');
        const gradient = ctx.createLinearGradient(0, 0, 0, 300);
        gradient.addColorStop(0, color + '40'); gradient.addColorStop(1, color + '00');
        return new Chart(ctx, {
            type: 'line',
            data: { labels: [], datasets: [{ label, data: [], borderColor: color, backgroundColor: gradient, fill: true, tension: 0.4, pointRadius: 0, borderWidth: 2 }] },
            options: {
                responsive: true, maintainAspectRatio: false,
                interaction: { intersect: false, mode: 'index' },
                plugins: { tooltip: { enabled: true }, legend: { display: false } },
                scales: { y: { min: minVal }, x: { ticks: { maxTicksLimit: 8 } } }
            }
        });
    }

    function updateValueWithFade(id, newValue, decimals = 1, suffix = "") {
        const obj = document.getElementById(id);
        if (!obj) return;
        const val = newValue !== undefined && newValue !== null ? newValue : 0;
        const formattedValue = parseFloat(val).toFixed(decimals) + suffix;
        if (obj.innerText !== formattedValue) {
            obj.classList.remove('fade-update');
            obj.style.opacity = "0";
            setTimeout(() => {
                void obj.offsetWidth;
                obj.innerText = formattedValue;
                obj.style.opacity = "1";
                obj.classList.add('fade-update');
            }, 50);
        }
    }

    async function update() {
        try {
            const res = await fetch('/weather?v=' + Date.now());
            const d = await res.json();
            if (!d || d.error) return;

            updateValueWithFade('t', d.temp.current, 1);
            updateValueWithFade('w', d.wind.speed, 1);
            updateValueWithFade('r_tot', d.rain.total, 1);
            updateValueWithFade('r_rate', d.rain.rate, 1);
            updateValueWithFade('wg', d.wind.gust, 1, ' km/h');

            document.getElementById('tTrendBox').innerHTML = d.temp.rate > 0 ? '<span class="trend-up">▲</span> +' + d.temp.rate + '°C /hr' : d.temp.rate < 0 ? '<span class="trend-down">▼</span> ' + d.temp.rate + '°C /hr' : '● Steady';
            document.getElementById('mx').innerHTML = d.temp.max + '°C <span class="time-mark">' + d.temp.maxTime + '</span>';
            document.getElementById('mn').innerHTML = d.temp.min + '°C <span class="time-mark">' + d.temp.minTime + '</span>';
            document.getElementById('rf').innerText = d.temp.realFeel + '°C';
            document.getElementById('h_val').innerHTML = d.atmo.hum + '% ' + (d.atmo.hTrend > 0 ? '▲' : '▼');
            document.getElementById('d_val').innerText = d.temp.dew + '°C';
            document.getElementById('wd_bracket').innerText = '(' + d.wind.card + ')';
            document.getElementById('mw').innerHTML = d.wind.maxS + ' km/h <span class="time-mark">' + d.wind.maxSTime + '</span>';
            document.getElementById('mg').innerHTML = d.wind.maxG + ' km/h <span class="time-mark">' + d.wind.maxGTime + '</span>';
            document.getElementById('needle').style.transform = 'rotate(' + d.wind.deg + 'deg)';
            liveWindSpeed = d.wind.speed; liveWindDeg = d.wind.deg;
            document.getElementById('r_week').innerText  = d.rain.weekly + ' mm';
            document.getElementById('r_month').innerText = d.rain.monthly + ' mm';
            document.getElementById('r_year').innerText  = d.rain.yearly + ' mm';
            document.getElementById('mr').innerHTML = d.rain.maxR > 0 ? d.rain.maxR + ' mm/h <span class="time-mark">' + d.rain.maxRTime + '</span>' : '0 mm/h';
            const pTrend = d.atmo.pTrend;
            let pArrow = '●';
            if (pTrend >= 0.1)  pArrow = '<span class="trend-up" style="color:#ef4444">▲</span>';
            if (pTrend <= -0.1) pArrow = '<span class="trend-down" style="color:#0ea5e9">▼</span>';
            document.getElementById('pIcon').innerHTML = pArrow;
            document.getElementById('pr').innerText  = d.atmo.press;
            document.getElementById('sol').innerText = d.atmo.sol + ' W/m²';
            document.getElementById('uv').innerText  = d.atmo.uv;
            document.getElementById('ts').innerText  = new Date(d.lastSync).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

            // Graphs only update if history data exists (populated after DB read)
            if (d.history && d.history.length > 0) {
                const labels = d.history.map(h => new Date(h.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }));
                if (!charts.cT) {
                    charts.cT = setupChart('cT', 'Temp °C',     '#ef4444');
                    charts.cH = setupChart('cH', 'Humidity %',  '#10b981');
                    charts.cW = setupChart('cW', 'Wind km/h',   '#f59e0b');
                    charts.cR = setupChart('cR', 'Rain mm',     '#3b82f6', 0);
                    applyTheme();
                }
                charts.cT.data.labels = labels; charts.cT.data.datasets[0].data = d.history.map(h => h.temp); charts.cT.update('none');
                charts.cH.data.labels = labels; charts.cH.data.datasets[0].data = d.history.map(h => h.hum);  charts.cH.update('none');
                charts.cW.data.labels = labels; charts.cW.data.datasets[0].data = d.history.map(h => h.wind); charts.cW.update('none');
                charts.cR.data.labels = labels; charts.cR.data.datasets[0].data = d.history.map(h => h.rain); charts.cR.update('none');
            }
        } catch (e) { console.error(e); }
    }

    function animateWind() {
        wCanvas.width = wCanvas.offsetWidth; wCanvas.height = wCanvas.offsetHeight;
        ctxW.clearRect(0, 0, wCanvas.width, wCanvas.height);
        const rad = (liveWindDeg - 90) * (Math.PI / 180);
        const dx = -Math.cos(rad) * Math.max(0.5, liveWindSpeed * 0.5);
        const dy = -Math.sin(rad) * Math.max(0.5, liveWindSpeed * 0.5);
        ctxW.strokeStyle = document.body.classList.contains('is-night') ? 'rgba(255,255,255,0.1)' : 'rgba(2,132,199,0.08)';
        ctxW.beginPath();
        particles.forEach(p => {
            p.x += dx * p.s; p.y += dy * p.s;
            if (p.x > wCanvas.width)  p.x = 0; else if (p.x < 0) p.x = wCanvas.width;
            if (p.y > wCanvas.height) p.y = 0; else if (p.y < 0) p.y = wCanvas.height;
            ctxW.moveTo(p.x, p.y); ctxW.lineTo(p.x - dx, p.y - dy);
        });
        ctxW.stroke(); requestAnimationFrame(animateWind);
    }

    applyTheme(); animateWind(); setInterval(update, 45000); update();

    function showPage(pageId) {
        document.getElementById('page-dashboard').style.display = pageId === 'dashboard' ? 'block' : 'none';
        document.getElementById('page-summary').style.display   = pageId === 'summary'   ? 'block' : 'none';
        document.getElementById('tab-dash').classList.toggle('active', pageId === 'dashboard');
        document.getElementById('tab-sum').classList.toggle('active',  pageId === 'summary');
        if (pageId === 'summary') fetchMonthlySummary();
    }

    async function fetchMonthlySummary() {
        const content = document.getElementById('summary-content');
        content.innerHTML = '<div class="card" style="text-align:center; padding:40px;">Generating Summary Report...</div>';
        try {
            const res = await fetch('/api/summary');
            const groups = await res.json();
            let html = '';
            for (const [month, days] of Object.entries(groups)) {
                html += \`
                    <div class="month-section">
                        <div class="month-header">\${month}</div>
                        <div class="summary-table-wrapper">
                            <table class="summary-table">
                                <thead><tr><th>Date</th><th>Max Temp</th><th>Min Temp</th><th>Wind/Gust</th><th>Total Rain</th></tr></thead>
                                <tbody>
                                    \${days.map(d => \`
                                        <tr>
                                            <td><b>\${new Date(d.record_date).getDate()}</b></td>
                                            <td style="color:#ef4444; font-weight:700;">\${d.max_temp_c}°C</td>
                                            <td style="color:#0ea5e9; font-weight:700;">\${d.min_temp_c}°C</td>
                                            <td>\${d.max_wind_kmh} / \${d.max_gust_kmh} <small>km/h</small></td>
                                            <td style="font-weight:800;">\${d.total_rain_mm} mm</td>
                                        </tr>
                                    \`).join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>
                \`;
            }
            content.innerHTML = html || '<div class="card" style="text-align:center; padding:40px;">No archived records found yet.</div>';
        } catch (e) {
            content.innerHTML = '<div class="card" style="color:#ef4444">Error loading summary.</div>';
        }
    }
</script>
```

</body>
</html>
    `);
});

if (process.env.NODE_ENV !== ‘production’) {
app.listen(3000, () => console.log(‘Running at http://localhost:3000’));
}

module.exports = app;
