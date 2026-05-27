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


/**
 * PROCESS RAIN LOGIC
 * Handles active tips and peak buffering. 
 * Decay is now handled externally by the Cron.
 */

 function processRainLogic(newDailyInches, currentTimeStamp) {
    const now = Date.now();
    
    if (state.lastRainRaw === null) {
        state.lastRainRaw = newDailyInches;
        state.lastRainTime = now;
        return 0;
    }

    // --- MIDNIGHT RESET FIX ---
    // If the API resets the daily total back to 0 (or a lower number)
    if (newDailyInches < state.lastRainRaw) {
        state.lastRainRaw = newDailyInches; // Reset our baseline tracker
        return state.lastCalculatedRate;    // Exit without calculating a rate
    }
    // --------------------------

    const deltaRain = newDailyInches - state.lastRainRaw;

    if (deltaRain > 0.0001) { 
        let timeSinceLastTipSec = (now - state.lastRainTime) / 1000;

        if (timeSinceLastTipSec > 600) {
            timeSinceLastTipSec = 60; 
        }

        const effectiveTime = Math.max(timeSinceLastTipSec, 60);
        
        state.lastCalculatedRate = deltaRain * (3600 / effectiveTime);
        
        state.lastRainRaw = newDailyInches;
        state.lastRainTime = now; 
    } 

    if (state.lastCalculatedRate > (state.bufRR || 0)) { 
        state.bufRR = state.lastCalculatedRate; 
        state.tRR = currentTimeStamp; 
    }
    
    return state.lastCalculatedRate;
}

 
// Fix the dangling return and the buffer function
/**
 * 1-MIN CRON: Memory Buffer & Decay Engine
 */

async function bufferOnlyUpdate() {
    const now = Date.now();
    const currentTimeStamp = new Date().toISOString();

    try {
        const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}&rainfall_unitid=12`;
        const response = await fetch(url);
        const json = await response.json();
        if (!json.data) throw new Error("Invalid API Response");
        const d = json.data;

        // 1. Process physical tips first
        const dailyRainInches = parseFloat(d.rainfall.daily.value) / 25.4;
        processRainLogic(dailyRainInches, currentTimeStamp);

        // 2. STABLE DECAY ENGINE (Exclusive to Cron)
        // We give 3 minutes (180s) of "grace" before dropping the rate.
        // This bridges the gap between API updates during heavy rain.
        const secondsSinceLastTip = (now - state.lastRainTime) / 1000;
        
        if (secondsSinceLastTip > 180) { 
            // Reduce by 20% every minute for a smooth curve
            state.lastCalculatedRate *= 0.8; 
            
            // Cut to zero if it becomes negligible
            if (state.lastCalculatedRate < 0.05) state.lastCalculatedRate = 0;
        }

        // 3. WIND & TEMP PEAK BUFFERING
        const apiW = parseFloat(d.wind.wind_speed.value);
        const apiG = parseFloat(d.wind.wind_gust.value);
        const apiT = parseFloat(d.outdoor.temperature.value);

        if (state.tW === null || apiW > state.bufW) { state.bufW = apiW; state.tW = currentTimeStamp; }
        if (state.tG === null || apiG > state.bufG) { state.bufG = apiG; state.tG = currentTimeStamp; }
        if (state.tMaxT === null || apiT > state.bufMaxT) { state.bufMaxT = apiT; state.tMaxT = currentTimeStamp; }
        if (state.tMinT === null || apiT < state.bufMinT) { state.bufMinT = apiT; state.tMinT = currentTimeStamp; }

        state.lastFetchTime = now;
        return { ok: true, buffered: true, currentRate: state.lastCalculatedRate };
    } catch (e) { 
        console.error("Cron Error:", e.message);
        return { error: e.message }; 
    }
}


/**
 * MAIN SYNC: Handles Dashboard, 10-Min DB Write, and Midnight Reset
 */
async function syncWithEcowitt(forceWrite = false) {
    const now = Date.now();
    const nowIST = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const todayISTStr = nowIST.toLocaleDateString('en-CA'); 
    const hour = nowIST.getHours();
    const minute = nowIST.getMinutes();

    // Reset cache if day changed for a visitor
    if (state.lastArchivedDate && state.lastArchivedDate !== todayISTStr) {
        state.cachedData = null;
    }

       // --- PART 1: VISITOR PATH ---
    // If not a forced write, and we have a cache younger than 9 minutes
    if (!forceWrite && state.cachedData && (now - state.lastFetchTime < 540000)) {
        try {
            const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}&rainfall_unitid=12`;
            const response = await fetch(url);
            const json = await response.json();
            const d = json.data;

            // 1. HIGH PRECISION RAIN INTERCEPT
            // Convert API mm to raw inches for the logic engine
            const currentDailyInches = parseFloat(d.rainfall.daily.value) / 25.4;
            
            // Trigger the engine to update state.lastCalculatedRate
            processRainLogic(currentDailyInches, new Date().toISOString());

            // Convert other rain fields to inches for internal consistency
            d.rainfall.daily.value = currentDailyInches;
            d.rainfall.weekly.value = parseFloat(d.rainfall.weekly.value) / 25.4;
            d.rainfall.monthly.value = parseFloat(d.rainfall.monthly.value) / 25.4;
            d.rainfall.yearly.value = parseFloat(d.rainfall.yearly.value) / 25.4;

            // 2. LIVE CONVERSIONS (Imperial to Metric for Dashboard)
            const liveTemp = parseFloat(((d.outdoor.temperature.value - 32) * 5 / 9).toFixed(1));
            const liveWind = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));
            const liveGust = parseFloat((d.wind.wind_gust.value * 1.60934).toFixed(1));
            const liveHum = d.outdoor.humidity.value || 0;
            const livePress = parseFloat((d.pressure.relative.value * 33.8639).toFixed(1));
            const liveDewC = parseFloat(((d.outdoor.dew_point.value - 32) * 5 / 9).toFixed(1));
            const liveRR = parseFloat((state.lastCalculatedRate * 25.4).toFixed(1));
            
            // 3. UPDATE CACHED SNAPSHOT
            state.cachedData.atmo.press = livePress;
            state.cachedData.atmo.hum = liveHum;
            state.cachedData.temp.realFeel = calculateRealFeel(liveTemp, liveHum);
            state.cachedData.temp.dew = liveDewC;
            state.cachedData.temp.current = liveTemp;
            state.cachedData.wind.speed = liveWind;
            state.cachedData.wind.gust = liveGust;
            
            // High-precision rain total (prevents rounding errors)
            state.cachedData.rain.total = Math.round(currentDailyInches * 2540) / 100;
            state.cachedData.rain.rate = liveRR;

            // 4. MAX/MIN LOGIC (Check live vs. existing cache)
            const fmtL = () => new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
            const fmtIso = (isoStr) => isoStr ? new Date(isoStr).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }) : fmtL();

            if (liveTemp > state.cachedData.temp.max) { state.cachedData.temp.max = liveTemp; state.cachedData.temp.maxTime = fmtL(); }
            if (liveTemp < state.cachedData.temp.min) { state.cachedData.temp.min = liveTemp; state.cachedData.temp.minTime = fmtL(); }
            if (liveWind > state.cachedData.wind.maxS) { state.cachedData.wind.maxS = liveWind; state.cachedData.wind.maxSTime = fmtL(); }
            if (liveGust > state.cachedData.wind.maxG) { state.cachedData.wind.maxG = liveGust; state.cachedData.wind.maxGTime = fmtL(); }
            if (liveRR > state.cachedData.rain.maxR) { state.cachedData.rain.maxR = liveRR; state.cachedData.rain.maxRTime = fmtL(); }

            // 5. MEMORY BUFFER CHECK (Ensures visitors see 1-min peaks trapped in buffers)
            if (state.bufMaxT !== -999) {
                const bMx = parseFloat(((state.bufMaxT - 32) * 5/9).toFixed(1));
                if (bMx > state.cachedData.temp.max) { state.cachedData.temp.max = bMx; state.cachedData.temp.maxTime = fmtIso(state.tMaxT); }
            }
            if (state.bufMinT !== 999) {
                const bMn = parseFloat(((state.bufMinT - 32) * 5/9).toFixed(1));
                if (bMn < state.cachedData.temp.min) { state.cachedData.temp.min = bMn; state.cachedData.temp.minTime = fmtIso(state.tMinT); }
            }
            if (state.bufW > 0) {
                const bW = parseFloat((state.bufW * 1.60934).toFixed(1));
                if (bW > state.cachedData.wind.maxS) { state.cachedData.wind.maxS = bW; state.cachedData.wind.maxSTime = fmtIso(state.tW); }
            }
            if (state.bufG > 0) {
                const bG = parseFloat((state.bufG * 1.60934).toFixed(1));
                if (bG > state.cachedData.wind.maxG) { state.cachedData.wind.maxG = bG; state.cachedData.wind.maxGTime = fmtIso(state.tG); }
            }
            if (state.bufRR > 0) {
                const bRR = parseFloat((state.bufRR * 25.4).toFixed(1));
                if (bRR > state.cachedData.rain.maxR) { state.cachedData.rain.maxR = bRR; state.cachedData.rain.maxRTime = fmtIso(state.tRR); }
            }

            state.cachedData.lastSync = new Date().toISOString();
            state.lastFetchTime = now;
            
            return state.cachedData;
        } catch (e) { 
            console.error("Visitor Sync Error:", e);
            return state.cachedData; 
        }
    }

            // --- PART 2: WRITER PATH ---
    try {
        let snap; 
        let dbWriteSuccess = false; 

        // --- NEW SERVERLESS DATE-CHANGE GUARD ---
        // If an instance wakes up on a brand new day, wipe its old in-memory cache completely
        // so it doesn't leak yesterday's data onto the dashboard.
        if (state.lastDateSeen !== todayISTStr) {
            console.log(`📆 New day detected (${todayISTStr}). Invalidating stale in-memory cache.`);
            state.cachedData = null;
            state.dataChangedSinceLastRead = true;
            state.lastDateSeen = todayISTStr; // Mark this instance as caught up to today
            
            // FIX: Completely wipe unwritten buffers so yesterday's late-night extremes don't leak into today's DB!
            state.bufMaxT = -999; state.tMaxT = null;
            state.bufMinT = 999;  state.tMinT = null;
            state.bufW = 0;       state.tW = null;
            state.bufG = 0;       state.tG = null;
            state.bufRR = 0;      state.tRR = null;
        }
        // ----------------------------------------

        const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}&rainfall_unitid=12`;
        const response = await fetch(url);
        const json = await response.json();
        const d = json.data;

        // --- HIGH PRECISION INTERCEPT ---
        d.rainfall.daily.value = parseFloat(d.rainfall.daily.value) / 25.4;
        d.rainfall.weekly.value = parseFloat(d.rainfall.weekly.value) / 25.4;
        d.rainfall.monthly.value = parseFloat(d.rainfall.monthly.value) / 25.4;
        d.rainfall.yearly.value = parseFloat(d.rainfall.yearly.value) / 25.4;

        processRainLogic(d.rainfall.daily.value, new Date().toISOString());

        const liveTemp = parseFloat(((d.outdoor.temperature.value - 32) * 5 / 9).toFixed(1));
        const liveDewC = parseFloat(((d.outdoor.dew_point.value - 32) * 5 / 9).toFixed(1)); 
        const liveHum = d.outdoor.humidity.value || 0;
        const livePress = parseFloat((d.pressure.relative.value * 33.8639).toFixed(1));

        if (forceWrite) {
            snap = {
                maxT: state.bufMaxT, minT: state.bufMinT,
                w: state.bufW, g: state.bufG, rr: state.bufRR,
                tMaxT: state.tMaxT, tMinT: state.tMinT,
                tW: state.tW, tG: state.tG, tRR: state.tRR
            };

            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                // --- MULTI-INSTANCE DUPLICATE PREVENTION CHECK ---
                const checkStart = new Date(Date.now() - 5 * 60 * 1000).toISOString();
                const checkEnd = new Date(Date.now() + 5 * 60 * 1000).toISOString();

                const duplicateCheck = await client.query(`
                    SELECT 1 FROM weather_history 
                    WHERE time BETWEEN $1 AND $2 
                    LIMIT 1
                `, [checkStart, checkEnd]);

                if (duplicateCheck.rows.length > 0) {
                    console.log("⚠️ Duplicate Prevention: This 10-min slot is already written. Clearing ghost buffer.");
                    await client.query('ROLLBACK');
                    
                    dbWriteSuccess = true; 
                    client.release();
                    
                    state.bufMaxT = -999; state.tMaxT = null;
                    state.bufMinT = 999;  state.tMinT = null;
                    state.bufW = 0;       state.tW = null;
                    state.bufG = 0;       state.tG = null;
                    state.bufRR = 0;      state.tRR = null;

                    return state.cachedData; 
                }
                // --- END OF DUPLICATE CHECK ---

                let timeSql = 'NOW()';
                if (hour === 0 && minute < 5) {
                    timeSql = "(date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata') - INTERVAL '1 second'";
                }

                const dbMaxT = snap.maxT === -999 ? d.outdoor.temperature.value : snap.maxT;
                const dbMinT = snap.minT === 999 ? d.outdoor.temperature.value : snap.minT;
                const dbW = snap.tW === null ? d.wind.wind_speed.value : snap.w;
                const dbG = snap.tG === null ? d.wind.wind_gust.value : snap.g;
                const dbRR = snap.rr || 0;

                await client.query(`
                    INSERT INTO weather_history 
                    (time, temp_f, temp_min_f, humidity, wind_speed_mph, wind_gust_mph, rain_rate_in, daily_rain_in, 
                     max_w_time, max_t_time, min_t_time, max_r_time, max_g_time, solar_radiation, press_rel)
                    VALUES (${timeSql}, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                `, [
                    dbMaxT, dbMinT, liveHum, dbW, dbG, dbRR, d.rainfall.daily.value,
                    snap.tW || new Date().toISOString(), 
                    snap.tMaxT || new Date().toISOString(), 
                    snap.tMinT || new Date().toISOString(), 
                    snap.tRR || (state.lastRainTime ? new Date(state.lastRainTime).toISOString() : new Date().toISOString()),
                    snap.tG || new Date().toISOString(), 
                    d.solar_and_uvi?.solar?.value || 0, 
                    d.pressure.relative.value || 0
                ]);

                // Midnight Roll-up (Untact)
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
                            max_temp_c=EXCLUDED.max_temp_c, min_temp_c=EXCLUDED.min_temp_c, 
                            max_wind_kmh=EXCLUDED.max_wind_kmh, max_gust_kmh=EXCLUDED.max_gust_kmh, 
                            total_rain_mm=EXCLUDED.total_rain_mm;
                    `, [todayISTStr]);

                    await client.query(`DELETE FROM weather_history WHERE (time AT TIME ZONE 'Asia/Kolkata')::date < $1::date`, [todayISTStr]);
                    state.lastArchivedDate = todayISTStr;
                    state.cachedData = null; 
                    resetStateBuffers(); 
                }

                await client.query('COMMIT');
                state.dataChangedSinceLastRead = true;
                dbWriteSuccess = true; 

            } catch (err) { 
                await client.query('ROLLBACK'); 
                console.error("CRITICAL: DB Write Failed. Buffer held for next attempt.", err); 
            } finally { client.release(); }
        }

        let tempRate = state.cachedData?.temp?.rate || 0, humRate = state.cachedData?.atmo?.hTrend || 0, pressRate = state.cachedData?.atmo?.pTrend || 0;
        let mx_t = state.cachedData?.temp?.max || liveTemp, mn_t = state.cachedData?.temp?.min || liveTemp;
        let mx_w = state.cachedData?.wind?.maxS || 0, mx_g = state.cachedData?.wind?.maxG || 0, mx_r = state.cachedData?.rain?.maxR || 0;

        const fmtL = () => new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });

        let mx_t_time = state.cachedData?.temp?.maxTime || fmtL();
        let mn_t_time = state.cachedData?.temp?.minTime || fmtL();
        let mx_w_t = state.cachedData?.wind?.maxSTime || fmtL();
        let mx_g_t = state.cachedData?.wind?.maxGTime || fmtL();
        let mx_r_t = state.cachedData?.rain?.maxRTime || fmtL();

        if (state.dataChangedSinceLastRead || !state.cachedData) {
            try {
                const historyRes = await pool.query(`
                    SELECT * FROM weather_history 
                    WHERE (time AT TIME ZONE 'Asia/Kolkata')::date = $1::date 
                    ORDER BY time ASC
                `, [todayISTStr]);
                
                let pastRecord = null;
                const oneHourAgo = Date.now() - 3600000;

                // FIX: Set to extreme opposites so the loop actually catches the FIRST true max/min from the DB.
                mx_t = -999; mn_t = 999;
                mx_w = 0; mx_g = 0; mx_r = 0;
                
                // Clear the times so we know if the DB was completely empty
                mx_t_time = null; mn_t_time = null;
                mx_w_t = null; mx_g_t = null; mx_r_t = null;

                historyRes.rows.forEach(r => {
                    const fmt = (iso) => new Date(iso || r.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
                    const r_max_t = parseFloat(((r.temp_f - 32) * 5 / 9).toFixed(1));
                    const r_min_t = parseFloat(((r.temp_min_f - 32) * 5 / 9).toFixed(1));
                    const r_w = parseFloat((r.wind_speed_mph * 1.60934).toFixed(1));
                    const r_g = parseFloat((r.wind_gust_mph * 1.60934).toFixed(1));
                    const r_rr = parseFloat((r.rain_rate_in * 25.4).toFixed(1));

                    if (r_max_t > mx_t) { mx_t = r_max_t; mx_t_time = fmt(r.max_t_time); }
                    if (r_min_t < mn_t) { mn_t = r_min_t; mn_t_time = fmt(r.min_t_time); }
                    if (r_w > mx_w) { mx_w = r_w; mx_w_t = fmt(r.max_w_time); }
                    if (r_g > mx_g) { mx_g = r_g; mx_g_t = fmt(r.max_g_time); }
                    if (r_rr > mx_r) { mx_r = r_rr; mx_r_t = fmt(r.max_r_time); }
                    
                    if (!pastRecord && new Date(r.time).getTime() >= oneHourAgo) {
                        pastRecord = r;
                    }
                });

                if (!pastRecord && historyRes.rows.length > 0) pastRecord = historyRes.rows[0];

                if (pastRecord) {
                    const pastTemp = parseFloat(((pastRecord.temp_f - 32) * 5 / 9).toFixed(1));
                    tempRate = parseFloat((liveTemp - pastTemp).toFixed(1));
                    humRate = parseFloat((liveHum - pastRecord.humidity).toFixed(1));
                    if (pastRecord.press_rel) {
                        pressRate = parseFloat((livePress - parseFloat((pastRecord.press_rel * 33.8639).toFixed(1))).toFixed(1));
                    }
                }
                
                state.dataChangedSinceLastRead = false;
            } catch (dbError) { console.error("DB Prep Error:", dbError); }
        }

        const liveWind = parseFloat((d.wind.wind_speed.value * 1.60934).toFixed(1));
        const liveGust = parseFloat((d.wind.wind_gust.value * 1.60934).toFixed(1));
        const liveRR = parseFloat((state.lastCalculatedRate * 25.4).toFixed(1));

        const fmtIso = (isoStr) => {
            if (!isoStr) return fmtL();
            return new Date(isoStr).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
        };

        // FIX: If the DB was completely empty (e.g., right at 12:01 AM before any cron writes), 
        // fall back to the live data as the baseline.
        if (mx_t === -999) { mx_t = liveTemp; mx_t_time = fmtL(); }
        if (mn_t === 999)  { mn_t = liveTemp; mn_t_time = fmtL(); }
        if (mx_w === 0)    { mx_w = liveWind; mx_w_t = fmtL(); }
        if (mx_g === 0)    { mx_g = liveGust; mx_g_t = fmtL(); }
        if (mx_r === 0)    { mx_r = liveRR;   mx_r_t = fmtL(); }

        if (liveTemp > mx_t) { mx_t = liveTemp; mx_t_time = fmtL(); }
        if (liveTemp < mn_t) { mn_t = liveTemp; mn_t_time = fmtL(); }
        if (liveWind > mx_w) { mx_w = liveWind; mx_w_t = fmtL(); }
        if (liveGust > mx_g) { mx_g = liveGust; mx_g_t = fmtL(); }
        if (liveRR > mx_r)   { mx_r = liveRR; mx_r_t = fmtL(); }

        const source = (forceWrite && typeof snap !== 'undefined') ? snap : state;

        if (source.maxT !== -999 && source.maxT !== undefined) {
            const bufMaxC = parseFloat(((source.maxT - 32) * 5 / 9).toFixed(1));
            if (bufMaxC > mx_t) { mx_t = bufMaxC; mx_t_time = fmtIso(source.tMaxT); }
        }
        if (source.minT !== 999 && source.minT !== undefined) {
            const bufMinC = parseFloat(((source.minT - 32) * 5 / 9).toFixed(1));
            if (bufMinC < mn_t) { mn_t = bufMinC; mn_t_time = fmtIso(source.tMinT); }
        }
        if (source.w > 0) {
            const bufWC = parseFloat((source.w * 1.60934).toFixed(1));
            if (bufWC > mx_w) { mx_w = bufWC; mx_w_t = fmtIso(source.tW); }
        }
        if (source.g > 0) {
            const bufGC = parseFloat((source.g * 1.60934).toFixed(1));
            if (bufGC > mx_g) { mx_g = bufGC; mx_g_t = fmtIso(source.tG); }
        }
        if (source.rr > 0) {
            const bufRRC = parseFloat((source.rr * 25.4).toFixed(1));
            if (bufRRC > mx_r) { mx_r = bufRRC; mx_r_t = fmtIso(source.tRR); }
        }

        state.cachedData = {
            temp: { current: liveTemp, max: mx_t, maxTime: mx_t_time, min: mn_t, minTime: mn_t_time, realFeel: calculateRealFeel(liveTemp, liveHum), rate: tempRate, dew: liveDewC },
            atmo: { hum: liveHum, hTrend: humRate, press: livePress, pTrend: pressRate, sol: d.solar_and_uvi?.solar?.value || 0, uv: d.solar_and_uvi?.uvi?.value || 0 },
            wind: { speed: liveWind, gust: liveGust, maxS: mx_w, maxSTime: mx_w_t, maxG: mx_g, maxGTime: mx_g_t, deg: d.wind.wind_direction.value, card: getCard(d.wind.wind_direction.value) },
            rain: { 
                total: Math.round(d.rainfall.daily.value * 2540) / 100, 
                rate: liveRR, 
                maxR: mx_r, 
                maxRTime: mx_r_t,
                weekly: Math.round(d.rainfall.weekly.value * 2540) / 100, 
                monthly: Math.round(d.rainfall.monthly.value * 2540) / 100, 
                yearly: Math.round(d.rainfall.yearly.value * 2540) / 100 
            },
            lastSync: new Date().toISOString()
        };

        if (forceWrite && dbWriteSuccess) {
            state.bufMaxT = -999; state.tMaxT = null;
            state.bufMinT = 999;  state.tMinT = null;
            state.bufW = 0;       state.tW = null;
            state.bufG = 0;       state.tG = null;
            state.bufRR = 0;      state.tRR = null;
        }

        state.lastFetchTime = now;
        return state.cachedData;
        
    } catch (e) { console.error("Sync Error:", e); return state.cachedData; }

}

async function getWeatherSummary() {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    if (state.summaryCache && state.lastSummaryFetchDate === today) return state.summaryCache;
    try {
        const res = await pool.query(`SELECT * FROM daily_max_records ORDER BY record_date DESC`);
        const formatted = res.rows.reduce((acc, row) => {
            const mY = new Date(row.record_date).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
            if (!acc[mY]) acc[mY] = [];
            acc[mY].push(row);
            return acc;
        }, {});
        state.summaryCache = formatted; state.lastSummaryFetchDate = today;
        return formatted;
    } catch (err) { return { error: err.message }; }
}

// Routes

/**
 * ROUTES
 */

// 1. API for the dashboard data (NO HISTORY INCLUDED, LIGHTWEIGHT)
app.get("/weather", async (req, res) => res.json(await syncWithEcowitt(false)));

// 2. API for the historical summary table
app.get("/api/summary", async (req, res) => res.json(await getWeatherSummary()));

// 3. The Cron Job endpoint (handles buffer-only or full DB writes)
app.get("/api/sync", async (req, res) => {
    if (req.query.buffer === 'true') return res.json(await bufferOnlyUpdate());
    res.json(await syncWithEcowitt(req.query.write === 'true'));
});

// 4. NEW GRAPH ONLY ROUTE (Triggered strictly on button click)
app.get("/api/history_graphs", async (req, res) => {
    const todayISTStr = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })).toLocaleDateString('en-CA');
    try {
        const historyRes = await pool.query(`
            SELECT * FROM weather_history 
            WHERE (time AT TIME ZONE 'Asia/Kolkata')::date = $1::date 
            ORDER BY time ASC
        `, [todayISTStr]);
        
        const history = historyRes.rows.map(r => ({
            time: r.time, 
            temp: parseFloat(((r.temp_f - 32) * 5 / 9).toFixed(1)), 
            hum: r.humidity, 
            wind: parseFloat((r.wind_speed_mph * 1.60934).toFixed(1)), 
            rain: parseFloat((r.daily_rain_in * 25.4).toFixed(1))
        }));
        res.json(history);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// NEW: Route to handle Historical Rainfall Fetch
app.get('/api/historical-rain', async (req, res) => {
    const { year } = req.query;
    if (!year) return res.status(400).json({ error: "Year is required" });

    try {
        const result = await pool.query(
            'SELECT month_val, rainfall_mm FROM historical_rainfall WHERE year_val = $1 ORDER BY id ASC',
            [parseInt(year)]
        );
        res.json({ year: year, data: result.rows });
    } catch (err) {
        console.error("Historical DB Error:", err);
        res.status(500).json({ error: "Database query failed" });
    }
});

// 5. The User Interface (Your HTML)
app.get("/", (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <title>KK Nagar Weather Station</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
    <style>
        :root { 
            --bg: #f4f7fa !important; 
            --card: rgba(255, 255, 255, 0.85); 
            --border: rgba(2, 132, 199, 0.05);
            --text: #0f172a !important; 
            --muted: #64748b; 
            --accent: #0284c7; 
            --glow: 0 20px 40px -15px rgba(2, 132, 199, 0.06);
            --line: rgba(2, 132, 199, 0.12);
        }

        /* PREMIUM OBSIDIAN DARK MODE DEEP LUXURY CHARCOAL */
        body.is-night {
            --bg: #090d16 !important; 
            --card: rgba(20, 26, 38, 0.65); 
            --border: rgba(255, 255, 255, 0.04);
            --text: #f1f5f9 !important; 
            --muted: #94a3b8; 
            --accent: #38bdf8; 
            --glow: 0 30px 60px -20px rgba(0, 0, 0, 0.7);
            --line: rgba(255, 255, 255, 0.09);
        }

        body { 
            margin: 0; font-family: 'Outfit', sans-serif; background: var(--bg); color: var(--text); 
            padding: 24px 24px 120px 24px; transition: background 0.4s ease, color 0.4s ease; 
            min-height: 100vh; overflow-x: hidden; box-sizing: border-box;
        }

        *, *:before, *:after { box-sizing: inherit; }

        .container { width: 100%; max-width: 1440px; margin: 0 auto; }
        .header { margin-bottom: 28px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px; }
        .header h1 { font-size: 26px; font-weight: 800; margin: 0; letter-spacing: -0.5px; }
        .header-actions { display: flex; align-items: center; gap: 12px; }
        
        .theme-toggle { background: var(--card); border: 1px solid var(--border); padding: 4px; border-radius: 14px; display: flex; gap: 4px; box-shadow: var(--glow); cursor: pointer; backdrop-filter: blur(20px); }
        .theme-btn { padding: 5px 12px; border-radius: 10px; font-size: 11px; font-weight: 700; transition: 0.2s ease; color: var(--muted); }
        .theme-btn.active { background: var(--accent); color: white; }

        .status-bar { display: flex; align-items: center; gap: 8px; background: var(--card); padding: 6px 16px; border-radius: 100px; border: 1px solid var(--border); box-shadow: var(--glow); font-size: 12px; backdrop-filter: blur(20px); }
        .live-dot { width: 6px; height: 6px; background: #10b981; border-radius: 50%; animation: blink 2s infinite; box-shadow: 0 0 8px #10b981; }
        @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        
        .grid-system { 
            display: grid; 
            grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); 
            gap: 24px; 
            margin-bottom: 32px; 
            width: 100%;
        }
        
        @media (min-width: 1200px) {
            .grid-system { grid-template-columns: repeat(2, 1fr); }
        }
        @media (min-width: 1440px) {
            .grid-system { grid-template-columns: repeat(4, 1fr); }
        }

        .card { 
            background: var(--card); 
            padding: 28px; 
            border-radius: 24px; 
            border: 1px solid var(--border); 
            backdrop-filter: blur(30px); 
            -webkit-backdrop-filter: blur(30px); 
            box-shadow: var(--glow); 
            position: relative; 
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            gap: 24px;
            width: 100%;
        }
        
        #windCanvas { position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 0; pointer-events: none; border-radius: 24px; }
        .card > *:not(canvas) { position: relative; z-index: 5; }

        .label { color: var(--accent); font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 14px; }
        
        .main-val { font-size: 52px; font-weight: 800; margin: 0; letter-spacing: -1.5px; display: flex; align-items: baseline; line-height: 1; font-variant-numeric: tabular-nums; }
        .unit { font-size: 18px; font-weight: 600; color: var(--muted); margin-left: 3px; }

        /* EQUAL COMPACT GRID PANELS */
        .row-block { display: flex; align-items: center; justify-content: space-between; width: 100%; }
        .left-panel { flex: 1.1; display: flex; flex-direction: column; justify-content: center; align-items: flex-start; }
        .right-panel { flex: 0.9; display: flex; flex-direction: column; gap: 12px; justify-content: center; padding-left: 16px; align-items: flex-start; }
        
        /* RE-CENTERED Subtly visible DIVIDER */
        .v-line { width: 1px; background: linear-gradient(to bottom, transparent, var(--line) 15%, var(--line) 85%, transparent); height: 75px; flex-shrink: 0; }

        /* HIGH PROMINENCE COMPACT VALUE PODS (PROMINENCE BUMPED BY +0.5) */
        .limit-row-pod { display: flex; align-items: center; justify-content: flex-start; gap: 6px; width: 100%; font-size: 15px; font-weight: 700; line-height: 1; }
        .pod-lbl { font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.8px; opacity: 0.9; }
        .pod-val { font-variant-numeric: tabular-nums; }

        .mod-divider { height: 1px; background: linear-gradient(to right, transparent, var(--line) 10%, var(--line) 90%, transparent); width: 100%; margin: 2px 0; }

        .modular-inline-stack { 
            display: grid; 
            grid-template-columns: repeat(3, 1fr); 
            gap: 4px; 
            width: 100%; 
            background: transparent !important;
            border: none !important;
            padding: 4px 0 0 0;
        }
        .stack-2-col { grid-template-columns: repeat(2, 1fr); }

        .modular-cell { display: flex; flex-direction: column; align-items: center; text-align: center; border-right: 1px solid var(--line); }
        .modular-cell:last-child { border-right: none; }
        
        .cell-lbl { font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); font-weight: 700; margin-bottom: 4px; }
        .cell-val { font-size: 14px; font-weight: 700; color: var(--text); }

        .sub-pill { font-size: 11px; font-weight: 600; color: var(--text); display: inline-flex; align-items: center; gap: 4px; margin-top: 8px; }

        /* ADVANCED HIGH-PROMINENCE COMPASS HUD WITH HUD CARDINAL TEXTS */
        .compass-container { position: relative; width: 72px; height: 72px; margin: 0 auto; display: flex; align-items: center; justify-content: center; }
        .compass-ui { width: 100%; height: 100%; border: 1.5px solid var(--line); border-radius: 50%; position: absolute; top:0; left:0; display: flex; align-items: center; justify-content: center; }
        
        .cardinal-pt { position: absolute; font-size: 9px; font-weight: 900; color: var(--muted); line-height: 1; }
        .pt-n { top: 2px; } .pt-s { bottom: 2px; } .pt-e { right: 4px; } .pt-w { left: 4px; }

        #needle { width: 3px; height: 46px; background: linear-gradient(to bottom, #ef4444 50%, var(--muted) 50%); clip-path: polygon(50% 0%, 100% 100%, 50% 85%, 0% 100%); transition: transform 2s cubic-bezier(0.1, 0.9, 0.2, 1); z-index: 2; }

        .time-mark { font-size: 9px; color: var(--muted); font-weight: 500; display: inline-block; margin-left: 4px; opacity: 0.75; }
        
        .nav-tabs { display: flex; gap: 8px; margin-bottom: 24px; }
        .tab-btn { background: var(--card); border: 1px solid var(--border); padding: 12px 24px; border-radius: 14px; color: var(--text); font-weight: 700; cursor: pointer; transition: 0.2s; backdrop-filter: blur(20px); font-size: 13px; }
        .tab-btn.active { background: var(--accent); color: white; border-color: var(--accent); box-shadow: var(--glow); }

        .graphs-wrapper { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-top: 20px; }
        .graph-card { background: var(--card); padding: 24px; border-radius: 24px; border: 1px solid var(--border); height: 320px; box-shadow: var(--glow); display: flex; flex-direction: column; overflow: hidden; }
        .graph-card canvas { flex-grow: 1; width: 100% !important; height: 100% !important; }

        .trend-up { color: #ef4444; font-weight: bold; } .trend-down { color: #0ea5e9; font-weight: bold; }

        .pro-summary-table { background: var(--card); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border: 1px solid var(--border); border-radius: 24px; box-shadow: var(--glow); overflow: hidden; display: flex; flex-direction: column; width: 100%; }
        .pro-row { display: flex; justify-content: space-between; align-items: center; padding: 22px 24px; border-bottom: 1px solid var(--border); gap: 16px; width: 100%; box-sizing: border-box; }
        .pro-row:last-child { border-bottom: none; }
        .pro-label { font-size: 14px; font-weight: 700; color: var(--text); flex: 0 0 120px; min-width: 120px; }
        .pro-data-group { display: flex; align-items: center; gap: 24px; flex: 1; justify-content: flex-end; min-width: 0; }
        .pro-data-item { display: flex; flex-direction: column; align-items: flex-end; min-width: 95px; }
        .pro-sub { font-size: 9px; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); font-weight: 700; margin-bottom: 4px; white-space: nowrap; }
        .pro-val { font-size: 20px; font-weight: 800; line-height: 1; white-space: nowrap; }
        .pro-divider { width: 1px; height: 24px; background: var(--border); opacity: 0.5; flex-shrink: 0; }
        
        .glass-select { background: var(--card) !important; border: 1px solid var(--border); border-radius: 12px; padding: 8px 12px; font-family: inherit; font-weight: 600; color: var(--text) !important; outline: none; cursor: pointer; appearance: none; -webkit-appearance: none; background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e"); background-repeat: no-repeat; background-position: right 10px center; background-size: 1em; padding-right: 40px; }
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

       <div class="nav-tabs">
            <button onclick="showPage('dashboard')" id="tab-dash" class="tab-btn active">Live Dashboard</button>
            <button onclick="showPage('summary')" id="tab-sum" class="tab-btn">Monthly Summary</button>
            <button onclick="showPage('historical')" id="tab-hist" class="tab-btn">Historical Data</button>
       </div>

        <div id="page-dashboard">
    <div class="grid-wrapper">
        <div class="grid-system">
            
            <div class="card">
                <div>
                    <div class="label">Temperature</div>
                    <div class="row-block">
                        <div class="left-panel">
                            <div class="main-val"><span id="t">0.0</span><span class="unit">°C</span></div>
                            <div id="tTrendBox" class="sub-pill">--</div>
                        </div>
                        
                        <div class="v-line"></div>
                        
                        <div class="right-panel">
                            <div class="limit-row-pod">
                                <span class="pod-lbl" style="color:#ef4444">MAX</span>
                                <span id="mx" class="pod-val" style="color:#ef4444">--</span>
                            </div>
                            <div class="limit-row-pod">
                                <span class="pod-lbl" style="color:#0ea5e9">MIN</span>
                                <span id="mn" class="pod-val" style="color:#0ea5e9">--</span>
                            </div>
                        </div>
                    </div>
                </div>
                
                <div class="mod-divider"></div>
                
                <div class="modular-inline-stack">
                    <div class="modular-cell">
                        <span class="cell-lbl">Feels Like</span>
                        <span id="rf" class="cell-val" style="color: #f97316;">--</span>
                    </div>
                    <div class="modular-cell">
                        <span class="cell-lbl">Humidity</span>
                        <span id="h_val" class="cell-val">--</span>
                    </div>
                    <div class="modular-cell">
                        <span class="cell-lbl">Dew Point</span>
                        <span id="d_val" class="cell-val">--</span>
                    </div>
                </div>
            </div>

            <div class="card">
                <canvas id="windCanvas"></canvas>
                <div>
                    <div class="label">Wind Vector</div>
                    <div class="row-block">
                        <div class="left-panel">
                            <div class="main-val"><span id="w">0.0</span><span class="unit">km/h</span></div>
                            <div style="font-size:13px; color:var(--muted); font-weight:700; margin-top:4px;" id="wd_bracket">(--)</div>
                            <div class="sub-pill" style="margin-top: 6px; font-weight: 700; color: var(--muted); white-space: nowrap;">
                                Gusting to: <span id="wg" style="color: var(--text); margin-left: 2px;">--</span>
                            </div>
                        </div>
                        
                        <div class="v-line"></div>
                        
                        <div class="right-panel">
                            <div class="compass-panel-box">
                                <div class="compass-container">
                                    <div class="compass-ui">
                                        <span class="cardinal-pt pt-n">N</span>
                                        <span class="cardinal-pt pt-s">S</span>
                                        <span class="cardinal-pt pt-e">E</span>
                                        <span class="cardinal-pt pt-w">W</span>
                                        <div id="needle"></div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                
                <div class="mod-divider"></div>
                
                <div class="modular-inline-stack stack-2-col">
                    <div class="modular-cell">
                        <span class="cell-lbl">Sustained Max</span>
                        <span id="mw" class="cell-val">--</span>
                    </div>
                    <div class="modular-cell">
                        <span class="cell-lbl">Peak Gust</span>
                        <span id="mg" class="cell-val">--</span>
                    </div>
                </div>
            </div>

            <div class="card">
                <div>
                    <div class="label">Rainfall</div>
                    <div class="row-block">
                        <div class="left-panel">
                            <div class="main-val"><span id="r_tot">0.0</span><span class="unit">mm</span></div>
                        </div>
                        
                        <div class="v-line"></div>
                        
                        <div class="right-panel">
                            <div class="limit-row-pod">
                                <span class="pod-lbl" style="color:#2563eb">RATE</span>
                                <span id="r_rate" class="pod-val" style="color:#2563eb">--</span>
                            </div>
                            <div class="limit-row-pod">
                                <span class="pod-lbl" style="color:#1d4ed8">MAX RATE</span>
                                <span id="mr" class="pod-val" style="color:#1d4ed8">--</span>
                            </div>
                        </div>
                    </div>
                </div>
                
                <div class="mod-divider"></div>
                
                <div class="modular-inline-stack">
                    <div class="modular-cell">
                        <span class="cell-lbl">Weekly</span>
                        <span id="r_week" class="cell-val">--</span>
                    </div>
                    <div class="modular-cell">
                        <span class="cell-lbl">Monthly</span>
                        <span id="r_month" class="cell-val">--</span>
                    </div>
                    <div class="modular-cell">
                        <span class="cell-lbl">Yearly</span>
                        <span id="r_year" class="cell-val">--</span>
                    </div>
                </div>
            </div>

            <div class="card">
                <div>
                    <div class="label">Atmospheric</div>
                    <div class="row-block">
                        <div class="left-panel">
                            <div class="main-val"><span id="pr">--</span><span class="unit">hPa</span></div>
                            <div class="sub-pill">Trend Gauge: <span id="pIcon" style="margin-left:2px;">●</span></div>
                        </div>
                    </div>
                </div>
                
                <div class="mod-divider"></div>
                
                <div class="modular-inline-stack stack-2-col">
                    <div class="modular-cell">
                        <span class="cell-lbl">Solar Radiation</span>
                        <span id="sol" class="cell-val">--</span>
                    </div>
                    <div class="modular-cell">
                        <span class="cell-lbl">UV Index</span>
                        <span id="uv" class="cell-val">--</span>
                    </div>
                </div>
            </div>

        </div>
    </div>
</div>


            <div class="sub-tabs-section" style="margin-top: 32px;">

                <div style="display: flex; gap: 10px; margin-bottom: 20px; justify-content: center;">
                    <button onclick="switchSubView('summary')" id="btn-sub-sum" class="tab-btn active">24H Summary</button>
                    <button onclick="switchSubView('graphs')" id="btn-sub-graph" class="tab-btn">24H Graphs</button>
                </div>

                
                <div id="sub-view-summary" style="display: block; animation: fadeIn 0.4s ease;">
    <div class="pro-summary-table">
        
        <div class="pro-row">
            <div class="pro-label">
                <span style="color:#ef4444; margin-right:10px; font-size:18px;">●</span>Temperature
            </div>
            <div class="pro-data-group">
                <div class="pro-data-item">
                    <span class="pro-sub">Maximum</span>
                    <span id="s-mx" class="pro-val" style="color: #ef4444;">--</span>
                </div>
                <div class="pro-divider"></div>
                <div class="pro-data-item">
                    <span class="pro-sub">Minimum</span>
                    <span id="s-mn" class="pro-val" style="color: #0ea5e9;">--</span>
                </div>
            </div>
        </div>

        <div class="pro-row">
            <div class="pro-label">
                <span style="color:#f59e0b; margin-right:10px; font-size:18px;">●</span>Wind
            </div>
            <div class="pro-data-group">
                <div class="pro-data-item">
                    <span class="pro-sub">Sustained</span>
                    <span id="s-mw" class="pro-val">--</span>
                </div>
                <div class="pro-divider"></div>
                <div class="pro-data-item">
                    <span class="pro-sub">Peak Gust</span>
                    <span id="s-mg" class="pro-val">--</span>
                </div>
            </div>
        </div>

    <div class="pro-row">
    <div class="pro-label">
        <span style="color:#3b82f6; margin-right:10px; font-size:18px;">●</span>Rainfall
    </div>
    <div class="pro-data-group">
        <div class="pro-data-item">
            <span id="s-rt" class="pro-val" style="color: #3b82f6;">--</span>
        </div>
        <div class="pro-divider" style="visibility: hidden;"></div>
        <div class="pro-data-item" style="visibility: hidden;">
            <span class="pro-val">--</span>
        </div>
    </div>
</div>

    </div>
</div>


</div>


                <div id="sub-view-graphs" style="display: none; animation: fadeIn 0.4s ease;">
                    
                    <div id="graphs-loading" style="text-align: center; padding: 40px; color: var(--muted); font-weight: 700; font-size: 14px; display: none;">
                        <span style="display: inline-block; animation: blink 1.5s infinite;">Loading 24H Graph Data from Database...</span>
                    </div>
                    
                    <div id="graphs-error" style="text-align: center; padding: 40px; color: #ef4444; font-weight: 700; font-size: 14px; display: none;">
                        Failed to load graph data.
                    </div>
                    
                    <div class="graphs-wrapper" id="graphs-wrapper-inner" style="margin-top: 0; display: none;">
                        <div class="graph-card"><div class="label" style="margin-bottom: 8px;">Temperature Trend</div><div style="flex-grow: 1; position: relative;"><canvas id="cT"></canvas></div></div>
                        <div class="graph-card"><div class="label" style="margin-bottom: 8px;">Humidity Levels</div><div style="flex-grow: 1; position: relative;"><canvas id="cH"></canvas></div></div>
                        <div class="graph-card"><div class="label" style="margin-bottom: 8px;">Wind Velocity</div><div style="flex-grow: 1; position: relative;"><canvas id="cW"></canvas></div></div>
                        <div class="graph-card"><div class="label" style="margin-bottom: 8px;">Precipitation</div><div style="flex-grow: 1; position: relative;"><canvas id="cR"></canvas></div></div>
                    </div>

                </div>
            </div>
            
        </div> 
        
        <div id="page-summary" style="display: none;">
            <div id="summary-content"></div>
        </div>

        <div id="page-historical" style="display: none;">
            <div id="historical-content"></div>
        </div>

    </div>


    <script>
        let currentMode = localStorage.getItem('weatherMode') || 'auto';
        let charts = {};
        let liveWindSpeed = 0, liveWindDeg = 0, particles = [];
        let graphDataLoaded = false;
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
                const maxIndex = dataset.data.indexOf(maxVal);
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
            
            if (isDark) {
                document.body.classList.add('is-night');
            } else {
                document.body.classList.remove('is-night');
            }

            document.querySelectorAll('.theme-btn').forEach(btn => btn.classList.remove('active'));
            if (currentMode === 'light') document.getElementById('btn-light').classList.add('active');
            else if (currentMode === 'dark') document.getElementById('btn-dark').classList.add('active');
            else document.getElementById('btn-auto').classList.add('active');

            if (charts.cT) updateChartColors();
        }

        document.getElementById('btn-light').onclick = () => { currentMode = 'light'; localStorage.setItem('weatherMode', 'light'); applyTheme(); };
        document.getElementById('btn-dark').onclick = () => { currentMode = 'dark'; localStorage.setItem('weatherMode', 'dark'); applyTheme(); };
        document.getElementById('btn-auto').onclick = () => { currentMode = 'auto'; localStorage.setItem('weatherMode', 'auto'); applyTheme(); };

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
                data: { labels: [], datasets: [{ label: label, data: [], borderColor: color, backgroundColor: gradient, fill: true, tension: 0.4, pointRadius: 0, borderWidth: 2 }] }, 
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
                    void obj.offsetWidth; // Force CSS refresh
                    obj.innerText = formattedValue;
                    obj.style.opacity = "1";
                    obj.classList.add('fade-update');
                }, 50); 
            }
        }

        // NEW 24H SUB TAB LOGIC (FIXED)
        async function switchSubView(type) {
            document.getElementById('sub-view-summary').style.display = type === 'summary' ? 'block' : 'none';
            document.getElementById('sub-view-graphs').style.display = type === 'graphs' ? 'block' : 'none';
            
            document.getElementById('btn-sub-sum').classList.toggle('active', type === 'summary');
            document.getElementById('btn-sub-graph').classList.toggle('active', type === 'graphs');

            if (type === 'graphs' && !graphDataLoaded) {
                document.getElementById('graphs-loading').style.display = 'block';
                document.getElementById('graphs-error').style.display = 'none';
                document.getElementById('graphs-wrapper-inner').style.display = 'none';
                await fetchGraphDataFromDB();
            } else if (type === 'graphs' && graphDataLoaded) {
                document.getElementById('graphs-wrapper-inner').style.display = 'grid';
            }
        }

        async function fetchGraphDataFromDB() {
            try {
                const res = await fetch('/api/history_graphs');
                if (!res.ok) throw new Error("Failed response");
                const history = await res.json();
                
                document.getElementById('graphs-loading').style.display = 'none';
                
                if (history && history.length > 0) {
                    document.getElementById('graphs-wrapper-inner').style.display = 'grid';
                    
                    // Delay slightly to allow the browser to paint the grid before Chart.js calculates sizes
                    setTimeout(() => {
                        const labels = history.map(h => new Date(h.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }));       
                        if(!charts.cT) { 
                            charts.cT = setupChart('cT', 'Temp °C', '#ef4444'); 
                            charts.cH = setupChart('cH', 'Humidity %', '#10b981'); 
                            charts.cW = setupChart('cW', 'Wind km/h', '#f59e0b'); 
                            charts.cR = setupChart('cR', 'Rain mm', '#3b82f6', 0); 
                            applyTheme(); 
                        }
                        charts.cT.data.labels = labels; charts.cT.data.datasets[0].data = history.map(h => h.temp); charts.cT.update('none');
                        charts.cH.data.labels = labels; charts.cH.data.datasets[0].data = history.map(h => h.hum); charts.cH.update('none');
                        charts.cW.data.labels = labels; charts.cW.data.datasets[0].data = history.map(h => h.wind); charts.cW.update('none');
                        charts.cR.data.labels = labels; charts.cR.data.datasets[0].data = history.map(h => h.rain); charts.cR.update('none');
                        graphDataLoaded = true;
                    }, 50); 
                } else {
                    document.getElementById('graphs-error').innerText = "No graph data available for today yet.";
                    document.getElementById('graphs-error').style.display = 'block';
                }
            } catch (err) { 
                console.error("Error drawing graphs:", err); 
                document.getElementById('graphs-loading').style.display = 'none';
                document.getElementById('graphs-error').style.display = 'block';
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
                const feels = d.temp.realFeel;
                const heatColor = feels >= 54 ? '#ef4444' : feels >= 41 ? '#f97316' : feels >= 32 ? '#eab308' : 'var(--text)';
                document.getElementById('rf').style.color = heatColor;
                document.getElementById('rf').innerText = feels + '°C';
                document.getElementById('h_val').innerHTML = d.atmo.hum + '% ' + (d.atmo.hTrend > 0 ? '▲' : d.atmo.hTrend < 0 ? '▼' : '●');
                document.getElementById('d_val').innerText = d.temp.dew + '°C';
                
                document.getElementById('wd_bracket').innerText = '(' + d.wind.card + ')';
                document.getElementById('mw').innerHTML = d.wind.maxS + ' km/h <span class="time-mark">' + d.wind.maxSTime + '</span>';
                document.getElementById('mg').innerHTML = d.wind.maxG + ' km/h <span class="time-mark">' + d.wind.maxGTime + '</span>';
                document.getElementById('needle').style.transform = 'rotate(' + d.wind.deg + 'deg)';
                liveWindSpeed = d.wind.speed; liveWindDeg = d.wind.deg;
                
                document.getElementById('r_week').innerText = d.rain.weekly + ' mm';
                document.getElementById('r_month').innerText = d.rain.monthly + ' mm';
                document.getElementById('r_year').innerText = d.rain.yearly + ' mm';
                document.getElementById('mr').innerHTML = d.rain.maxR > 0 ? d.rain.maxR + ' mm/h <span class="time-mark">' + d.rain.maxRTime + '</span>' : '0 mm/h';

                const pTrend = d.atmo.pTrend;
                let pArrow = '●';
                if (pTrend >= 0.1) pArrow = '<span class="trend-up" style="color:#ef4444">▲</span>';
                if (pTrend <= -0.1) pArrow = '<span class="trend-down" style="color:#0ea5e9">▼</span>';
                document.getElementById('pIcon').innerHTML = pArrow;
                
                document.getElementById('pr').innerText = d.atmo.press;
                document.getElementById('sol').innerText = d.atmo.sol + ' W/m²'; 
                document.getElementById('uv').innerText = d.atmo.uv;
                document.getElementById('ts').innerText = new Date(d.lastSync).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                
                // POPULATE THE MODERNIZED 24H SUMMARY CARDS
                if(document.getElementById('s-mx')) {
                    document.getElementById('s-mx').innerText = d.temp.max + '°C';
                    document.getElementById('s-mn').innerText = d.temp.min + '°C';
                    document.getElementById('s-mw').innerText = d.wind.maxS + ' km/h';
                    document.getElementById('s-mg').innerText = (d.wind.maxG || d.wind.maxS) + ' km/h';
                    document.getElementById('s-rt').innerText = d.rain.total + ' mm';
                }

                // IF GRAPHS TAB IS OPEN, RE-FETCH GRAPH DATA TO UPDATE
                if (graphDataLoaded && document.getElementById('sub-view-graphs').style.display === 'block') {
                    fetchGraphDataFromDB();
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
                if (p.x > wCanvas.width) p.x = 0; else if (p.x < 0) p.x = wCanvas.width;
                if (p.y > wCanvas.height) p.y = 0; else if (p.y < 0) p.y = wCanvas.height;
                ctxW.moveTo(p.x, p.y); ctxW.lineTo(p.x - dx, p.y - dy);
            });
            ctxW.stroke(); requestAnimationFrame(animateWind);
        }

        applyTheme(); animateWind(); setInterval(update, 60000); update();

        function showPage(pageId) {
    // 1. Toggle visibility of the three pages
    document.getElementById('page-dashboard').style.display = pageId === 'dashboard' ? 'block' : 'none';
    document.getElementById('page-summary').style.display = pageId === 'summary' ? 'block' : 'none';
    document.getElementById('page-historical').style.display = pageId === 'historical' ? 'block' : 'none'; // Added this
    
    // 2. Update the active class for the three buttons
    document.getElementById('tab-dash').classList.toggle('active', pageId === 'dashboard');
    document.getElementById('tab-sum').classList.toggle('active', pageId === 'summary');
    document.getElementById('tab-hist').classList.toggle('active', pageId === 'historical'); // Added this

    // 3. Trigger UI generation
    if (pageId === 'summary') {
        showMonthlySummaryUI(); 
    } 
    else if (pageId === 'historical') {
        showHistoricalUI(); // We will define this function next
    }
}

/* --- START CHIP CHOP --- */
let selectedMonth = new Date().toLocaleDateString('en-IN', { month: 'long' });
let selectedYear = new Date().getFullYear().toString();

// 1. Function to show the UI (dropdowns) immediately
window.showMonthlySummaryUI = function() {
    const content = document.getElementById('summary-content');
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    
    let monthOptions = months.map(function(m) {
        var sel = (selectedMonth === m) ? 'selected' : '';
        return '<option value="' + m + '" ' + sel + '>' + m + '</option>';
    }).join('');

    let yearOptions = "";
    const startYear = 2026;
    const endYear = 2032; // Next 7 years from now
    
    for (var y = startYear; y <= endYear; y++) {
        var ySel = (selectedYear == y) ? 'selected' : '';
        yearOptions += '<option value="' + y + '" ' + ySel + '>' + y + '</option>';
    }

    content.innerHTML = \`
        <div class="archive-container" style="animation: fadeIn 0.5s ease;">
            <div style="margin-bottom: 20px; padding: 15px 25px; display: flex; justify-content: space-between; align-items: center; background: var(--card); border-radius: 20px; border: 1px solid var(--border);">
                <div style="font-weight: 800; letter-spacing: 0.5px; color: var(--accent);">MONTHLY ARCHIVES</div>
                <div style="display: flex; gap: 10px;">
                    <select id="monthSelect" class="glass-select">\${monthOptions}</select>
                    <select id="yearSelect" class="glass-select">\${yearOptions}</select>
                    <button onclick="updateArchiveFilter()" style="padding: 6px 12px; margin-left: 8px; background: var(--accent); color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 600;">Get Data</button>
                </div>
            </div>
            <div id="archive-data-table">
                <div class="card" style="text-align:center; padding:60px; color: var(--muted);">
                    Select a month and click "Get Data" to load records.
                </div>
            </div>
        </div>\`;
};

// 2. Updated data fetcher that targets only the table container
async function fetchMonthlySummary() {
    const tableContainer = document.getElementById('archive-data-table');
    if (!tableContainer) return;
    
    tableContainer.innerHTML = '<div class="card" style="text-align:center; padding:40px;">Querying Database...</div>';
    
    try {
        const res = await fetch('/api/summary');
        const groups = await res.json();
        const currentKey = \`\${selectedMonth} \${selectedYear}\`;
        const days = groups[currentKey] || [];

        if (days.length === 0) {
            tableContainer.innerHTML = \`
                <div class="card" style="text-align:center; padding:60px; color: var(--muted); font-weight: 600;">
                    No data recorded for \${currentKey}
                </div>\`;
            return;
        }

        tableContainer.innerHTML = \`
            <div class="pro-summary-table" style="background: var(--card); border-radius: 15px; overflow: hidden; border: 1px solid var(--border);">
                <div class="pro-row" style="background: var(--badge); font-weight: 800; font-size: 11px; text-transform: uppercase; display: flex; align-items: center; padding: 15px; border-bottom: 1px solid var(--border);">
                    <div style="width: 20%;">Date</div>
                    <div style="width: 25%; text-align: center;">Temp (H/L)</div>
                    <div style="width: 30%; text-align: center;">Wind / Gust</div>
                    <div style="width: 25%; text-align: right;">Rainfall</div>
                </div>
                \${days.map(function(d) {
                    return \`
                    <div class="pro-row" style="display: flex; align-items: center; padding: 15px; border-bottom: 1px solid var(--border);">
                        <div style="width: 20%; font-size: 16px;"><b>\${new Date(d.record_date).getDate()}</b></div>
                        <div style="width: 25%; display: flex; justify-content: center; gap: 8px;">
                            <span style="color:#ef4444; font-weight: 700;">\${parseFloat(d.max_temp_c).toFixed(1)}°</span>
                            <span style="opacity: 0.3;">/</span>
                            <span style="color:#0ea5e9; font-weight: 700;">\${parseFloat(d.min_temp_c).toFixed(1)}°</span>
                        </div>
                        <div style="width: 30%; font-size: 13px; text-align: center;">
                            \${parseFloat(d.max_wind_kmh).toFixed(1)} <small style="opacity:0.4">/</small> \${parseFloat(d.max_gust_kmh).toFixed(1)} <small>km/h</small>
                        </div>
                        <div style="width: 25%; font-weight: 800; color: #3b82f6; text-align: right;">
                            \${parseFloat(d.total_rain_mm).toFixed(1)} <small>mm</small>
                        </div>
                    </div>\`;
                }).join('')}
            </div>\`;
    } catch (e) {
        tableContainer.innerHTML = '<div class="card" style="color:#ef4444; padding:20px; text-align:center;">Error loading data.</div>';
    }
}

window.updateArchiveFilter = function() {
    selectedMonth = document.getElementById('monthSelect').value;
    selectedYear = document.getElementById('yearSelect').value;
    fetchMonthlySummary();
};
/* --- END CHIP CHOP --- */

/* --- UPDATED: STRICTLY SAFE UI GENERATION --- */

window.showMonthlySummaryUI = function() {
    var content = document.getElementById('summary-content');
    var months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    
    var monthOptions = "";
    for (var i = 0; i < months.length; i++) {
        var m = months[i];
        var sel = (selectedMonth === m) ? 'selected' : '';
        monthOptions += '<option value="' + m + '" ' + sel + '>' + m + '</option>';
    }

    var yearOptions = "";
    for (var y = 2026; y <= 2032; y++) {
        var ySel = (selectedYear == y) ? 'selected' : '';
        yearOptions += '<option value="' + y + '" ' + ySel + '>' + y + '</option>';
    }

    // Using '+' instead of backticks to avoid $ issues
    content.innerHTML = 
        '<div class="archive-container" style="animation: fadeIn 0.5s ease;">' +
            '<div style="margin-bottom: 20px; padding: 15px 25px; display: flex; justify-content: space-between; align-items: center; background: var(--card); border-radius: 20px; border: 1px solid var(--border);">' +
                '<div style="font-weight: 800; letter-spacing: 0.5px; color: var(--accent);">MONTHLY ARCHIVES</div>' +
                '<div style="display: flex; gap: 10px;">' +
                    '<select id="monthSelect" class="glass-select">' + monthOptions + '</select>' +
                    '<select id="yearSelect" class="glass-select">' + yearOptions + '</select>' +
                    '<button onclick="updateArchiveFilter()" style="padding: 6px 12px; margin-left: 8px; background: var(--accent); color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 600;">Get Data</button>' +
                '</div>' +
            '</div>' +
            '<div id="archive-data-table">' +
                '<div class="card" style="text-align:center; padding:60px; color: var(--muted);">' +
                    'Select a month and click "Get Data" to load records.' +
                '</div>' +
            '</div>' +
        '</div>';
};

window.showHistoricalUI = function() {
    var content = document.getElementById('historical-content');
    var years = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
    var yearOptions = "";
    for (var i = 0; i < years.length; i++) {
        yearOptions += '<option value="' + years[i] + '">' + years[i] + '</option>';
    }

    content.innerHTML = 
        '<div class="archive-container" style="animation: fadeIn 0.4s ease;">' +
            '<div style="margin-bottom: 20px; padding: 15px; background: var(--card); border-radius: 16px; border: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center;">' +
                '<div style="font-weight: 800; color: var(--accent); font-size: 0.8rem; letter-spacing: 1px;">KK NAGAR RAINFALL HISTORY</div>' +
                '<div style="display: flex; gap: 8px;">' +
                    '<select id="histYearSelect" class="glass-select" style="padding: 5px 10px; border-radius: 8px; background: #1e293b; color: white; border: 1px solid #334155;">' +
                        yearOptions +
                    '</select>' +
                    '<button onclick="fetchHistoricalData()" style="padding: 8px 16px; background: #3b82f6; color: white; border: none; border-radius: 10px; font-weight: bold; cursor: pointer;">FETCH</button>' +
                '</div>' +
            '</div>' +
            '<div id="historical-results-table">' +
                '<div style="text-align: center; padding: 50px 20px; color: #64748b; border: 1px dashed var(--border); border-radius: 16px;">' +
                    'Select a year and click "FETCH" to retrieve records.' +
                '</div>' +
            '</div>' +
        '</div>';
};

/* --- ADD THIS: THE MISSING FETCH ENGINE --- */

window.fetchHistoricalData = async function() {
    var year = document.getElementById('histYearSelect').value;
    var resultsTable = document.getElementById('historical-results-table');
    
    resultsTable.innerHTML = '<div style="text-align:center; padding:40px; color: var(--text-muted, #64748b);">Syncing Archive...</div>';

    try {
        var response = await fetch('/api/historical-rain?year=' + year);
        var result = await response.json();

        if (!result.data || result.data.length === 0) {
            resultsTable.innerHTML = '<div style="text-align:center; padding:40px; color: #ef4444;">No data found for ' + year + '</div>';
            return;
        }

        var months = result.data.filter(function(d) { return d.month_val !== 'Annual'; });
        var annualRow = result.data.find(function(d) { return d.month_val === 'Annual'; });

        var preMonsoonTotal = 0; var swmTotal = 0; var nemTotal = 0;
        months.forEach(function(m) {
            var val = parseFloat(m.rainfall_mm) || 0;
            var mKey = m.month_val.substring(0, 3).toUpperCase();
            if (['JAN', 'FEB', 'MAR', 'APR', 'MAY'].indexOf(mKey) !== -1) preMonsoonTotal += val;
            if (['JUN', 'JUL', 'AUG', 'SEP'].indexOf(mKey) !== -1) swmTotal += val;
            if (['OCT', 'NOV', 'DEC'].indexOf(mKey) !== -1) nemTotal += val;
        });

        var leftCol = months.slice(0, 6);
        var rightCol = months.slice(6, 12);

        function renderCard(d) {
            var rf = parseFloat(d.rainfall_mm) || 0;
            var mKey = d.month_val.substring(0, 3).toUpperCase();
            var mainTextColor = 'var(--text, #1e293b)'; 
            
            // Default Neutral Styles (Jan-May)
            var bgColor = 'var(--card, rgba(30, 41, 59, 0.04))';
            var borderColor = 'var(--border, rgba(255,255,255,0.1))';
            var monthTextColor = 'var(--text-muted, #64748b)';

            if (['JUN', 'JUL', 'AUG', 'SEP'].indexOf(mKey) !== -1) {
                // SWM - Now Amber
                bgColor = 'rgba(245, 158, 11, 0.08)';       
                borderColor = 'rgba(245, 158, 11, 0.4)';
                monthTextColor = '#d97706';
            } else if (['OCT', 'NOV', 'DEC'].indexOf(mKey) !== -1) {
                // NEM - Now Emerald
                bgColor = 'rgba(5, 150, 105, 0.08)';        
                borderColor = 'rgba(5, 150, 105, 0.4)';
                monthTextColor = '#059669';
            }

            return '<div style="background:' + bgColor + '; border: 1.5px solid ' + borderColor + '; border-radius: 12px; padding: 14px; margin-bottom: 10px; text-align: center;">' +
                        '<div style="font-size: 0.75rem; font-weight: 900; color: ' + monthTextColor + '; letter-spacing: 1.2px; text-transform: uppercase; margin-bottom: 4px;">' + d.month_val.substring(0,3) + '</div>' +
                        '<div style="font-size: 1.4rem; font-weight: 900; color: ' + mainTextColor + ';">' + rf.toFixed(1) + '<span style="font-size: 0.8rem; opacity: 0.5; margin-left: 2px;">mm</span></div>' +
                   '</div>';
        }

        var html = '<div style="display: flex; gap: 12px; margin-top: 10px;">';
        html += '<div style="flex: 1;">' + leftCol.map(renderCard).join('') + '</div>';
        html += '<div style="flex: 1;">' + rightCol.map(renderCard).join('') + '</div>';
        html += '</div>';

        // Seasonal Summary Row
        html += '<div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 5px;">';
        var seasonalStyle = 'border-radius: 16px; padding: 20px 5px; text-align: center; border: 2.5px solid;';
        
        // Pre-Monsoon Summary (Neutral)
        html += '<div style="' + seasonalStyle + ' background: var(--card); border-color: var(--border);">' +
                    '<div style="font-size: 0.8rem; font-weight: 900; color: var(--text-muted); letter-spacing: 1px; margin-bottom: 6px;">JAN-MAY</div>' +
                    '<div style="font-size: 1.7rem; font-weight: 900; color: var(--text, #1e293b);">' + preMonsoonTotal.toFixed(1) + '</div>' +
                '</div>';

        // SWM Summary (Amber)
        html += '<div style="' + seasonalStyle + ' background: rgba(245, 158, 11, 0.12); border-color: rgba(245, 158, 11, 0.5);">' +
                    '<div style="font-size: 0.8rem; font-weight: 900; color: #d97706; letter-spacing: 1px; margin-bottom: 6px;">SWM</div>' +
                    '<div style="font-size: 1.7rem; font-weight: 900; color: var(--text, #1e293b);">' + swmTotal.toFixed(1) + '</div>' +
                '</div>';

        // NEM Summary (Emerald)
        html += '<div style="' + seasonalStyle + ' background: rgba(5, 150, 105, 0.12); border-color: rgba(5, 150, 105, 0.5);">' +
                    '<div style="font-size: 0.8rem; font-weight: 900; color: #059669; letter-spacing: 1px; margin-bottom: 6px;">NEM</div>' +
                    '<div style="font-size: 1.7rem; font-weight: 900; color: var(--text, #1e293b);">' + nemTotal.toFixed(1) + '</div>' +
                '</div>';
        html += '</div>';

        // Annual Total Footer (Neutral Theme)
        if (annualRow) {
            html += '<div style="margin-top: 15px; background: var(--card, #f8fafc); border: 2px solid #64748b; border-radius: 18px; padding: 24px; text-align: center; box-shadow: 0 4px 20px rgba(0,0,0,0.08);">' +
                        '<div style="font-size: 0.8rem; color: #64748b; font-weight: 900; letter-spacing: 2px; margin-bottom: 6px;">' + year + ' ANNUAL TOTAL</div>' +
                        '<div style="font-size: 3rem; font-weight: 950; color: var(--text, #1e293b); line-height: 1;">' + parseFloat(annualRow.rainfall_mm).toFixed(1) + '<span style="font-size: 1.2rem; opacity: 0.4; margin-left: 6px; font-weight: 700;">mm</span></div>' +
                    '</div>';
        }

        resultsTable.innerHTML = html;

    } catch (error) {
        resultsTable.innerHTML = '<div style="text-align:center; padding:40px; color: #ef4444;">Connection failed.</div>';
    }
};



</script>
</body>
</html>
    `);
});

if (process.env.NODE_ENV !== 'production') {
    app.listen(3000, () => console.log(`Running at http://localhost:3000`));
}

module.exports = app;
