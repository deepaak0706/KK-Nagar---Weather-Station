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
        // ADDED &rainfall_unitid=12 HERE
        const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}&rainfall_unitid=12`;
        const response = await fetch(url);
        const json = await response.json();
        const d = json.data;

        // --- HIGH PRECISION INTERCEPT ---
        // Convert the API's mm (1.19) into high-precision inches for your DB
        d.rainfall.daily.value = parseFloat(d.rainfall.daily.value) / 25.4;
        d.rainfall.weekly.value = parseFloat(d.rainfall.weekly.value) / 25.4;
        d.rainfall.monthly.value = parseFloat(d.rainfall.monthly.value) / 25.4;
        d.rainfall.yearly.value = parseFloat(d.rainfall.yearly.value) / 25.4;
        // --------------------------------

        // ADD THIS LINE HERE:
        processRainLogic(d.rainfall.daily.value, new Date().toISOString());

        const liveTemp = parseFloat(((d.outdoor.temperature.value - 32) * 5 / 9).toFixed(1));
        const liveDewC = parseFloat(((d.outdoor.dew_point.value - 32) * 5 / 9).toFixed(1)); 
        const liveHum = d.outdoor.humidity.value || 0;
        const livePress = parseFloat((d.pressure.relative.value * 33.8639).toFixed(1));

                if (forceWrite) {
            // 1. SNAPSHOT: Capture buffers at this exact millisecond
            const snap = {
                maxT: state.bufMaxT, minT: state.bufMinT,
                w: state.bufW, g: state.bufG, rr: state.bufRR,
                tMaxT: state.tMaxT, tMinT: state.tMinT,
                tW: state.tW, tG: state.tG, tRR: state.tRR
            };

            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                let timeSql = 'NOW()';
                if (hour === 0 && minute < 5) {
                    timeSql = "(date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata') - INTERVAL '1 second'";
                }

                // 2. USE SNAPSHOTS: This ensures the data is consistent even if buffers change during 'await'
                const dbMaxT = snap.maxT === -999 ? d.outdoor.temperature.value : snap.maxT;
                const dbMinT = snap.minT === 999 ? d.outdoor.temperature.value : snap.minT;
                const dbW = snap.tW === null ? d.wind.wind_speed.value : snap.w;
                const dbG = snap.tG === null ? d.wind.wind_gust.value : snap.g;
                const currentLiveRR_Inches = state.lastCalculatedRate || 0;
                const dbRR = snap.rr || 0; // Use only the peak captured in the 10-min window

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

                // Midnight Roll-up (Intact)
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

            } catch (err) { 
                await client.query('ROLLBACK'); 
                console.error("CRITICAL: DB Write Failed. Buffer held for next attempt.", err); 
            } finally { client.release(); }
        }


        let tempRate = state.cachedData?.temp?.rate || 0, humRate = state.cachedData?.atmo?.hTrend || 0, pressRate = state.cachedData?.atmo?.pTrend || 0;
        let mx_t = state.cachedData?.temp?.max || liveTemp, mn_t = state.cachedData?.temp?.min || liveTemp;
        let mx_w = state.cachedData?.wind?.maxS || 0, mx_g = state.cachedData?.wind?.maxG || 0, mx_r = state.cachedData?.rain?.maxR || 0;

        const fmtL = () => new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });

        // Give each variable its own dedicated cached time
        let mx_t_time = state.cachedData?.temp?.maxTime || fmtL();
        let mn_t_time = state.cachedData?.temp?.minTime || fmtL();
        let mx_w_t = state.cachedData?.wind?.maxSTime || fmtL();
        let mx_g_t = state.cachedData?.wind?.maxGTime || fmtL();
        let mx_r_t = state.cachedData?.rain?.maxRTime || fmtL();

        if (state.dataChangedSinceLastRead || !state.cachedData) {
            try {
                // We keep this query to get the exact MAX/MIN and their times efficiently without sending full history payload to client
                const historyRes = await pool.query(`
                    SELECT * FROM weather_history 
                    WHERE (time AT TIME ZONE 'Asia/Kolkata')::date = $1::date 
                    ORDER BY time ASC
                `, [todayISTStr]);
                
                let pastRecord = null;
                const oneHourAgo = Date.now() - 3600000;

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

        // --- FIX: Include Memory Buffers in Dashboard Max/Min Calculations ---
        const fmtIso = (isoStr) => {
            if (!isoStr) return fmtL();
            return new Date(isoStr).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
        };

        // 1. Check live instantaneous values
        if (liveTemp > mx_t) { mx_t = liveTemp; mx_t_time = fmtL(); }
        if (liveTemp < mn_t) { mn_t = liveTemp; mn_t_time = fmtL(); }
        if (liveWind > mx_w) { mx_w = liveWind; mx_w_t = fmtL(); }
        if (liveGust > mx_g) { mx_g = liveGust; mx_g_t = fmtL(); }
        if (liveRR > mx_r)   { mx_r = liveRR; mx_r_t = fmtL(); }

        // 2. Check the high-frequency 1-min Memory Buffers
// Use 'snap' (the frozen peak) if we just wrote to DB, otherwise use live 'state'
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

       // --- THE FIX: Wrap this in a safety check ---
        if (forceWrite && typeof snap !== 'undefined') {
            if (state.bufMaxT === snap.maxT) { state.bufMaxT = -999; state.tMaxT = null; }
            if (state.bufMinT === snap.minT) { state.bufMinT = 999; state.tMinT = null; }
            if (state.bufW === snap.w) { state.bufW = 0; state.tW = null; }
            if (state.bufG === snap.g) { state.bufG = 0; state.tG = null; }
            if (state.bufRR === snap.rr) { state.bufRR = 0; state.tRR = null; }
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
app.get(\"/\", (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang=\"en\">
<head>
    <meta charset=\"UTF-8\">
    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0, viewport-fit=cover\">
    <title>KK Nagar Weather Hub</title>
    <script src=\"https://cdn.jsdelivr.net/npm/chart.js\"></script>
    <link href=\"https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;700;900&display=swap\" rel=\"stylesheet\">
    <style>
        /* ========================================================
           KK NAGAR WEATHER — ULTRA-MODERN DASHBOARD STYLES
           Logic-safe: All IDs, JS hooks, and animations preserved.
           ======================================================== */
        :root {
            --bg: #f4f5f8 !important;
            --bg-grad: radial-gradient(1200px 600px at 10% -10%, rgba(56,189,248,0.18), transparent 60%),
                       radial-gradient(900px 500px at 100% 0%, rgba(168,85,247,0.10), transparent 55%),
                       linear-gradient(180deg, #f4f5f8 0%, #eef0f5 100%);
            --card: rgba(255, 255, 255, 0.72);
            --card-solid: #ffffff;
            --border: rgba(15, 23, 42, 0.07);
            --border-strong: rgba(15, 23, 42, 0.12);
            --text: #0a0e1a !important;
            --muted: #64748b;
            --muted-2: #94a3b8;
            --accent: #0284c7;
            --glow: 0 24px 60px -20px rgba(15, 23, 42, 0.18), 0 2px 6px rgba(15,23,42,0.04);
            --badge: rgba(15, 23, 42, 0.035);
            --ring: rgba(15, 23, 42, 0.06);
            --c-temp: #f97316; --c-temp-2: #ef4444;
            --c-wind: #06b6d4; --c-wind-2: #0ea5e9;
            --c-atmo: #8b5cf6; --c-atmo-2: #6366f1;
            --c-rain: #3b82f6; --c-rain-2: #2563eb;
        }
        body.is-night {
            --bg: #07080d !important;
            --bg-grad: radial-gradient(1200px 600px at 10% -10%, rgba(56,189,248,0.10), transparent 60%),
                       radial-gradient(900px 500px at 100% 0%, rgba(168,85,247,0.10), transparent 55%),
                       linear-gradient(180deg, #07080d 0%, #0b0d14 100%);
            --card: rgba(22, 25, 34, 0.62);
            --card-solid: #14171f;
            --border: rgba(255, 255, 255, 0.06);
            --border-strong: rgba(255, 255, 255, 0.12);
            --text: #f5f7fb !important;
            --muted: #9aa3b2; --muted-2: #6b7280;
            --accent: #38bdf8;
            --glow: 0 30px 80px -20px rgba(0,0,0,0.65), 0 2px 6px rgba(0,0,0,0.4);
            --badge: rgba(255, 255, 255, 0.04);
            --ring: rgba(255, 255, 255, 0.08);
        }
        * { box-sizing: border-box; }
        body {
            margin: 0; font-family: 'Outfit', sans-serif;
            background: var(--bg); background-image: var(--bg-grad);
            color: var(--text); padding: 24px 18px 120px 18px;
            transition: background 0.5s ease, color 0.5s ease;
            min-height: 100vh; overflow-x: hidden;
            -webkit-font-smoothing: antialiased;
            font-feature-settings: \"ss01\", \"cv11\";
        }
        .container { width: 100%; max-width: 1280px; margin: 0 auto; }
        .header { margin-bottom: 32px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px; }
        .header h1 { font-size: 28px; font-weight: 900; margin: 0; letter-spacing: -1.2px; }
        .header-actions { display: flex; align-items: center; gap: 12px; }
        .theme-toggle { background: var(--card); border: 1px solid var(--border); padding: 4px; border-radius: 12px; display: flex; gap: 4px; box-shadow: var(--glow); cursor: pointer; backdrop-filter: blur(20px); }
        .theme-btn { padding: 6px 10px; border-radius: 8px; font-size: 11px; font-weight: 700; transition: 0.3s; color: var(--muted); cursor: pointer; }
        .theme-btn.active { background: var(--accent); color: white; }
        .status-bar { display: flex; align-items: center; gap: 8px; background: var(--card); padding: 6px 16px; border-radius: 100px; border: 1px solid var(--border); box-shadow: var(--glow); font-size: 13px; backdrop-filter: blur(20px); }
        .live-dot { width: 7px; height: 7px; background: #10b981; border-radius: 50%; box-shadow: 0 0 0 0 rgba(16,185,129,0.7); animation: pulse-dot 2s infinite; }
        @keyframes pulse-dot { 0% { box-shadow: 0 0 0 0 rgba(16,185,129,0.55); } 70% { box-shadow: 0 0 0 8px rgba(16,185,129,0); } 100% { box-shadow: 0 0 0 0 rgba(16,185,129,0); } }
        @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

        /* ========== ULTRA-MODERN BENTO GRID ========== */
        .grid-system { display: grid; grid-template-columns: repeat(12, 1fr); gap: 18px; }
        .card {
            position: relative; background: var(--card);
            padding: 26px 26px 24px; border-radius: 28px;
            border: 1px solid var(--border);
            backdrop-filter: blur(24px) saturate(140%);
            -webkit-backdrop-filter: blur(24px) saturate(140%);
            box-shadow: var(--glow); overflow: hidden;
            transition: transform 0.4s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.4s ease, border-color 0.4s ease;
            isolation: isolate;
        }
        .card:hover { transform: translateY(-3px); border-color: var(--border-strong); }
        .card::before {
            content: \"\"; position: absolute; top: 0; left: 0; right: 0;
            height: 2px; background: linear-gradient(90deg, transparent, var(--c-accent, var(--accent)), transparent);
            opacity: 0.7; z-index: 2;
        }
        .card::after {
            content: \"\"; position: absolute; top: -40%; right: -20%;
            width: 360px; height: 360px;
            background: radial-gradient(circle, var(--c-accent, var(--accent)), transparent 70%);
            opacity: 0.06; pointer-events: none; z-index: 0;
            transition: opacity 0.4s ease;
        }
        .card:hover::after { opacity: 0.12; }
        .card-temp { --c-accent: var(--c-temp); grid-column: span 6; }
        .card-wind { --c-accent: var(--c-wind); grid-column: span 6; }
        .card-rain { --c-accent: var(--c-rain); grid-column: span 7; }
        .card-atmo { --c-accent: var(--c-atmo); grid-column: span 5; }
        @media (max-width: 980px) { .card-temp, .card-wind, .card-rain, .card-atmo { grid-column: span 12; } }
        .card > *:not(canvas) { position: relative; z-index: 3; }

        .c-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 18px; }
        .c-head-left { display: flex; align-items: center; gap: 10px; }
        .c-icon {
            width: 32px; height: 32px; border-radius: 10px;
            display: grid; place-items: center;
            background: var(--c-accent, var(--accent)); color: #fff; font-size: 14px;
            box-shadow: 0 6px 16px -6px var(--c-accent, var(--accent));
        }
        .label { font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 2.2px; color: var(--text); opacity: 0.85; margin: 0; }
        .trend-chip {
            font-size: 11px; font-weight: 800; padding: 6px 11px; border-radius: 100px;
            background: var(--badge); color: var(--muted); border: 1px solid var(--border);
            display: inline-flex; align-items: center; gap: 5px; line-height: 1; white-space: nowrap;
        }
        .trend-up { color: #f43f5e; } .trend-down { color: #0ea5e9; }

        .hero-value {
            font-size: 76px; font-weight: 800; line-height: 0.95; letter-spacing: -3px;
            display: flex; align-items: baseline; gap: 4px;
            font-variant-numeric: tabular-nums; font-feature-settings: \"tnum\";
        }
        .hero-value .unit { font-size: 22px; font-weight: 600; color: var(--muted); margin-left: 4px; letter-spacing: 0; }
        .hero-value .deg { font-size: 50px; font-weight: 300; color: var(--muted-2); margin-left: 2px; letter-spacing: 0; }
        .sub-hero { font-size: 13px; color: var(--muted); margin-top: 8px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
        .sub-hero strong { color: var(--text); font-weight: 800; }

        .stat-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-top: 22px; padding-top: 20px; border-top: 1px solid var(--border); }
        .stat-grid.cols-4 { grid-template-columns: repeat(4, 1fr); }
        .stat-grid.cols-3 { grid-template-columns: repeat(3, 1fr); }
        .stat {
            background: var(--badge); border: 1px solid transparent; border-radius: 16px;
            padding: 12px 14px; display: flex; flex-direction: column; gap: 4px;
            transition: background 0.3s ease, border-color 0.3s ease, transform 0.3s ease;
        }
        .stat:hover { background: var(--card-solid); border-color: var(--border); transform: translateY(-1px); }
        .stat-label { font-size: 9.5px; color: var(--muted); text-transform: uppercase; font-weight: 800; letter-spacing: 1.4px; }
        .stat-val { font-size: 17px; font-weight: 800; line-height: 1.15; font-variant-numeric: tabular-nums; display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }

        .hero-value span:not(.unit):not(.deg), .stat-val, .badge-val, .meter-val, .feels-val {
            display: inline-block; transition: all 0.6s cubic-bezier(0.34, 1.56, 0.64, 1); font-variant-numeric: tabular-nums;
        }
        @keyframes magicFade {
            0% { opacity: 0; filter: blur(10px); transform: scale(0.85) translateY(6px); }
            40% { opacity: 0.7; filter: blur(3px); }
            100% { opacity: 1; filter: blur(0); transform: scale(1) translateY(0); }
        }
        .fade-update { animation: magicFade 1.1s cubic-bezier(0.16, 1, 0.3, 1); will-change: transform, opacity, filter; }

        .time-mark { font-size: 9px; color: var(--muted); font-weight: 700; margin-left: 2px; background: var(--ring); padding: 2px 6px; border-radius: 6px; letter-spacing: 0.3px; }

        /* TEMP */
        .feels-wrap {
            display: flex; align-items: center; justify-content: space-between;
            margin-top: 14px; padding: 14px 16px;
            background: linear-gradient(135deg, rgba(249,115,22,0.08), rgba(239,68,68,0.05));
            border: 1px solid rgba(249,115,22,0.15); border-radius: 18px;
        }
        body.is-night .feels-wrap { background: linear-gradient(135deg, rgba(249,115,22,0.10), rgba(239,68,68,0.06)); }
        .feels-label { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 1.5px; color: var(--muted); }
        .feels-val { font-size: 22px; font-weight: 900; font-variant-numeric: tabular-nums; }

        /* WIND */
        #windCanvas { position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 0; pointer-events: none; border-radius: 28px; opacity: 0.85; }
        .compass-ui {
            position: absolute !important; top: 22px !important; right: 22px !important;
            width: 58px; height: 58px; border: 1.5px solid var(--border-strong); border-radius: 50%;
            display: flex; align-items: center; justify-content: center; z-index: 10;
            background: var(--card-solid); box-shadow: 0 8px 20px -10px rgba(0,0,0,0.2);
        }
        .compass-ui::before { content: \"N\"; position: absolute; top: 2px; font-size: 8px; font-weight: 900; color: var(--muted); letter-spacing: 0; }
        #needle { width: 3px; height: 36px; background: linear-gradient(to bottom, var(--c-wind) 50%, var(--muted-2) 50%); clip-path: polygon(50% 0%, 100% 100%, 50% 85%, 0% 100%); transition: transform 2s cubic-bezier(0.1, 0.9, 0.2, 1); }
        .gust-pill {
            display: inline-flex; align-items: center; gap: 8px;
            font-size: 12px; font-weight: 800; padding: 7px 13px; border-radius: 100px;
            background: linear-gradient(135deg, rgba(6,182,212,0.10), rgba(14,165,233,0.05));
            border: 1px solid rgba(6,182,212,0.20); color: var(--c-wind); margin-top: 10px;
        }
        .gust-pill .gd { width: 6px; height: 6px; background: var(--c-wind); border-radius: 50%; animation: pulse-dot 1.6s infinite; box-shadow: 0 0 0 0 var(--c-wind); }
        #wd_bracket { font-size: 22px; color: var(--muted); margin-left: 8px; font-weight: 700; letter-spacing: 0; }

        /* ATMO */
        .pressure-block { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }
        .pressure-block .hero-value { font-size: 56px; letter-spacing: -2px; }
        .pressure-block .hero-value .unit { font-size: 16px; }
        .meter { margin-top: 14px; }
        .meter-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
        .meter-head .meter-label { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 1.4px; color: var(--muted); }
        .meter-val { font-size: 14px; font-weight: 800; font-variant-numeric: tabular-nums; }
        .meter-track { height: 6px; background: var(--badge); border-radius: 100px; overflow: hidden; position: relative; }
        .meter-fill { height: 100%; border-radius: 100px; transition: width 1.2s cubic-bezier(0.22, 1, 0.36, 1); background: linear-gradient(90deg, var(--c-atmo), var(--c-atmo-2)); box-shadow: 0 0 12px var(--c-atmo); }
        .meter-fill.solar { background: linear-gradient(90deg, #f59e0b, #ef4444); box-shadow: 0 0 12px #f59e0b; }
        .meter-fill.uv { background: linear-gradient(90deg, #10b981, #f59e0b, #ef4444, #a855f7); box-shadow: 0 0 12px #a855f7; }

        /* RAIN */
        .rain-hero-row { display: flex; align-items: flex-end; justify-content: space-between; gap: 18px; }
        .rain-rate-chip {
            display: flex; flex-direction: column; gap: 4px;
            padding: 12px 16px;
            background: linear-gradient(135deg, rgba(59,130,246,0.10), rgba(37,99,235,0.05));
            border: 1px solid rgba(59,130,246,0.20); border-radius: 18px; min-width: 140px;
        }
        .rain-rate-chip .rate-label { font-size: 9.5px; font-weight: 800; text-transform: uppercase; letter-spacing: 1.4px; color: var(--muted); }
        .rain-rate-chip .rate-val { font-size: 22px; font-weight: 900; color: var(--c-rain); font-variant-numeric: tabular-nums; }
        .rain-rate-chip .rate-val small { font-size: 11px; color: var(--muted); font-weight: 700; margin-left: 3px; }
        .rain-max-row { margin-top: 14px; display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; background: var(--badge); border-radius: 16px; border: 1px solid var(--border); }
        .rain-ledger { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 16px; padding-top: 18px; border-top: 1px solid var(--border); }
        .ledger-cell { background: var(--badge); border: 1px solid transparent; border-radius: 14px; padding: 12px 10px; text-align: center; transition: all 0.3s ease; }
        .ledger-cell:hover { background: var(--card-solid); border-color: rgba(59,130,246,0.25); transform: translateY(-2px); }
        .ledger-cell .lc-label { font-size: 9.5px; font-weight: 800; text-transform: uppercase; letter-spacing: 1.4px; color: var(--muted); margin-bottom: 4px; }
        .ledger-cell .lc-val { font-size: 18px; font-weight: 900; font-variant-numeric: tabular-nums; color: var(--text); }
        .ledger-cell .lc-val small { font-size: 10px; font-weight: 700; color: var(--muted); margin-left: 2px; }

        /* GRAPHS */
        .graphs-wrapper { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-top: 20px; }
        .graph-card { background: var(--card); padding: 24px; border-radius: 28px; border: 1px solid var(--border); height: 320px; box-shadow: var(--glow); display: flex; flex-direction: column; overflow: hidden; backdrop-filter: blur(20px); }
        .graph-card canvas { flex-grow: 1; width: 100% !important; height: 100% !important; }

        /* TABS / SUMMARY */
        .nav-tabs { display: flex; gap: 8px; margin-bottom: 25px; flex-wrap: wrap; }
        .tab-btn { background: var(--card); border: 1px solid var(--border); padding: 12px 22px; border-radius: 14px; color: var(--text); font-weight: 700; cursor: pointer; transition: 0.3s; backdrop-filter: blur(20px); font-size: 13px; }
        .tab-btn.active { background: var(--accent); color: white; border-color: var(--accent); box-shadow: var(--glow); }
        .month-section { margin-bottom: 35px; animation: fadeIn 0.5s ease; }
        .month-header { font-size: 20px; font-weight: 800; margin: 25px 0 15px 0; color: var(--accent); display: flex; align-items: center; gap: 10px; }
        .month-header::after { content: \"\"; height: 2px; flex-grow: 1; background: var(--border); }
        .summary-table-wrapper { overflow-x: auto; background: var(--card); border-radius: 24px; border: 1px solid var(--border); box-shadow: var(--glow); }
        .summary-table { width: 100%; border-collapse: collapse; min-width: 600px; }
        .summary-table th { padding: 16px; background: var(--badge); text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); }
        .summary-table td { padding: 16px; border-top: 1px solid var(--border); font-size: 14px; }
        .summary-table tr:hover { background: var(--badge); }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

        .pro-summary-table { background: var(--card); backdrop-filter: blur(24px); border: 1px solid var(--border); border-radius: 24px; box-shadow: var(--glow); overflow: hidden; display: flex; flex-direction: column; }
        .pro-row { display: flex; justify-content: space-between; align-items: center; padding: 24px 30px; border-bottom: 1px solid var(--border); transition: background 0.3s ease; gap: 20px; }
        .pro-row:last-child { border-bottom: none; }
        .pro-label { font-size: 15px; font-weight: 800; color: var(--text); letter-spacing: 0.5px; display: flex; align-items: center; flex: 0 0 160px; }
        .pro-data-group { display: flex; align-items: center; gap: 40px; flex: 1; justify-content: flex-end; }
        .pro-data-item { display: flex; flex-direction: column; align-items: flex-end; min-width: 100px; }
        .pro-sub { font-size: 10px; text-transform: uppercase; letter-spacing: 1.5px; color: var(--muted); font-weight: 800; margin-bottom: 6px; }
        .pro-val { font-size: 26px; font-weight: 900; line-height: 1; letter-spacing: -0.5px; }
        .pro-divider { width: 1px; height: 32px; background: var(--border); opacity: 0.5; }
        @media (max-width: 650px) { .pro-row { padding: 20px; gap: 10px; } .pro-label { flex: 0 0 120px; font-size: 13px; } .pro-data-group { gap: 20px; } .pro-val { font-size: 20px; } }

        .glass-select {
            background: var(--card) !important; border: 1px solid var(--border); border-radius: 12px;
            padding: 8px 12px; font-family: inherit; font-weight: 600; color: var(--text) !important;
            outline: none; cursor: pointer; transition: all 0.2s ease; appearance: none; -webkit-appearance: none;
            background-image: url(\"data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e\");
            background-repeat: no-repeat; background-position: right 10px center; background-size: 1em; padding-right: 40px;
        }
        .glass-select:hover { border-color: var(--accent); transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
        .glass-select option { background-color: #ffffff; color: #000000; }
        body.is-night .glass-select { color-scheme: dark; }
        body.is-night .glass-select option { background-color: #1e293b; color: #f1f5f9; }

        @media (max-width: 540px) {
            .hero-value { font-size: 60px; letter-spacing: -2px; }
            .pressure-block .hero-value { font-size: 44px; }
            .card { padding: 22px 20px; border-radius: 24px; }
            .rain-hero-row { flex-direction: column; align-items: flex-start; gap: 12px; }
            .rain-rate-chip { width: 100%; }
        }
    </style>
</head>
<body>
    <div class=\"container\">
        <div class=\"header\">
            <h1>KK Nagar Weather Hub</h1>
            <div class=\"header-actions\">
                <div class=\"status-bar\"><div class=\"live-dot\"></div><div class=\"timestamp\"><span id=\"ts\">--:--:--</span></div></div>
                <div class=\"theme-toggle\" id=\"themeToggle\">
                    <div class=\"theme-btn\" id=\"btn-light\">LIGHT</div>
                    <div class=\"theme-btn\" id=\"btn-dark\">DARK</div>
                    <div class=\"theme-btn active\" id=\"btn-auto\">AUTO</div>
                </div>
            </div>
        </div>

       <div class=\"nav-tabs\">
        <button onclick=\"showPage('dashboard')\" id=\"tab-dash\" class=\"tab-btn active\">Live Dashboard</button>
        <button onclick=\"showPage('summary')\" id=\"tab-sum\" class=\"tab-btn\">Monthly Summary</button>
        <button onclick=\"showPage('historical')\" id=\"tab-hist\" class=\"tab-btn\">Historical Data</button>
       </div>

        <div id=\"page-dashboard\">

            <!-- ===== ULTRA-MODERN BENTO GRID (4 CARDS) ===== -->
            <div class=\"grid-system\">

                <!-- TEMPERATURE -->
                <div class=\"card card-temp\">
                    <div class=\"c-head\">
                        <div class=\"c-head-left\">
                            <div class=\"c-icon\">◐</div>
                            <div class=\"label\">Temperature</div>
                        </div>
                        <div id=\"tTrendBox\" class=\"trend-chip\">--</div>
                    </div>
                    <div class=\"hero-value\">
                        <span id=\"t\">0.0</span><span class=\"deg\">°</span><span class=\"unit\">C</span>
                    </div>
                    <div class=\"feels-wrap\">
                        <span class=\"feels-label\">Feels Like</span>
                        <span id=\"rf\" class=\"feels-val\">--</span>
                    </div>
                    <div class=\"stat-grid cols-4\">
                        <div class=\"stat\"><span class=\"stat-label\">Today High</span><span id=\"mx\" class=\"stat-val\" style=\"color:#ef4444\">--</span></div>
                        <div class=\"stat\"><span class=\"stat-label\">Today Low</span><span id=\"mn\" class=\"stat-val\" style=\"color:#0ea5e9\">--</span></div>
                        <div class=\"stat\"><span class=\"stat-label\">Humidity</span><span id=\"h_val\" class=\"stat-val\">--</span></div>
                        <div class=\"stat\"><span class=\"stat-label\">Dew Point</span><span id=\"d_val\" class=\"stat-val\">--</span></div>
                    </div>
                </div>

                <!-- WIND -->
                <div class=\"card card-wind\">
                    <canvas id=\"windCanvas\"></canvas>
                    <div class=\"c-head\">
                        <div class=\"c-head-left\">
                            <div class=\"c-icon\" style=\"background:var(--c-wind); box-shadow:0 6px 16px -6px var(--c-wind)\">≋</div>
                            <div class=\"label\">Wind Dynamics</div>
                        </div>
                    </div>
                    <div class=\"compass-ui\"><div id=\"needle\"></div></div>
                    <div class=\"hero-value\">
                        <span id=\"w\">0.0</span><span class=\"unit\">km/h</span>
                    </div>
                    <div class=\"sub-hero\">Direction <strong id=\"wd_bracket\" style=\"font-size:14px; margin-left:4px;\">(--)</strong></div>
                    <div class=\"gust-pill\">
                        <span class=\"gd\"></span>
                        Live Gust · <span id=\"wg\" style=\"font-weight:900; color:var(--text); margin-left:2px;\">--</span>
                    </div>
                    <div class=\"stat-grid\">
                        <div class=\"stat\"><span class=\"stat-label\">Max Speed</span><span id=\"mw\" class=\"stat-val\">--</span></div>
                        <div class=\"stat\"><span class=\"stat-label\">Max Gust</span><span id=\"mg\" class=\"stat-val\">--</span></div>
                    </div>
                </div>

                <!-- RAIN -->
                <div class=\"card card-rain\">
                    <div class=\"c-head\">
                        <div class=\"c-head-left\">
                            <div class=\"c-icon\" style=\"background:var(--c-rain); box-shadow:0 6px 16px -6px var(--c-rain)\">☂</div>
                            <div class=\"label\">Rain Realm</div>
                        </div>
                    </div>
                    <div class=\"rain-hero-row\">
                        <div class=\"hero-value\">
                            <span id=\"r_tot\">0.0</span><span class=\"unit\">mm</span>
                        </div>
                        <div class=\"rain-rate-chip\">
                            <span class=\"rate-label\">Current Intensity</span>
                            <span class=\"rate-val\"><span id=\"r_rate\">0.0</span><small>mm/h</small></span>
                        </div>
                    </div>
                    <div class=\"rain-max-row\">
                        <span style=\"font-size:10px; font-weight:800; text-transform:uppercase; letter-spacing:1.4px; color:var(--muted)\">Max Intensity</span>
                        <span id=\"mr\" class=\"stat-val\" style=\"font-size:15px;\">--</span>
                    </div>
                    <div class=\"rain-ledger\">
                        <div class=\"ledger-cell\"><div class=\"lc-label\">Weekly</div><div class=\"lc-val\"><span id=\"r_week\">--</span></div></div>
                        <div class=\"ledger-cell\"><div class=\"lc-label\">Monthly</div><div class=\"lc-val\"><span id=\"r_month\">--</span></div></div>
                        <div class=\"ledger-cell\"><div class=\"lc-label\">Yearly</div><div class=\"lc-val\"><span id=\"r_year\">--</span></div></div>
                    </div>
                </div>

                <!-- ATMOSPHERIC -->
                <div class=\"card card-atmo\">
                    <div class=\"c-head\">
                        <div class=\"c-head-left\">
                            <div class=\"c-icon\" style=\"background:var(--c-atmo); box-shadow:0 6px 16px -6px var(--c-atmo)\">◉</div>
                            <div class=\"label\">Atmospheric</div>
                        </div>
                        <div class=\"trend-chip\"><span id=\"pIcon\">●</span></div>
                    </div>
                    <div class=\"pressure-block\">
                        <div class=\"hero-value\"><span id=\"pr\">--</span><span class=\"unit\">hPa</span></div>
                    </div>
                    <div class=\"sub-hero\">Relative Pressure · Sea Level</div>
                    <div class=\"meter\" style=\"margin-top:22px;\">
                        <div class=\"meter-head\">
                            <span class=\"meter-label\">Solar Radiation</span>
                            <span class=\"meter-val\"><span id=\"sol\">--</span></span>
                        </div>
                        <div class=\"meter-track\"><div id=\"solBar\" class=\"meter-fill solar\" style=\"width:0%\"></div></div>
                    </div>
                    <div class=\"meter\" style=\"margin-top:16px;\">
                        <div class=\"meter-head\">
                            <span class=\"meter-label\">UV Index</span>
                            <span class=\"meter-val\"><span id=\"uv\">--</span></span>
                        </div>
                        <div class=\"meter-track\"><div id=\"uvBar\" class=\"meter-fill uv\" style=\"width:0%\"></div></div>
                    </div>
                </div>

            </div>
            <!-- ===== END BENTO GRID ===== -->

            <div class=\"sub-tabs-section\" style=\"margin-top: 35px;\">
                <div style=\"display: flex; gap: 10px; margin-bottom: 20px; justify-content: center;\">
                    <button onclick=\"switchSubView('summary')\" id=\"btn-sub-sum\" class=\"tab-btn active\">24H Summary</button>
                    <button onclick=\"switchSubView('graphs')\" id=\"btn-sub-graph\" class=\"tab-btn\">24H Graphs</button>
                </div>

                <div id=\"sub-view-summary\" style=\"display: block; animation: fadeIn 0.4s ease;\">
                    <div class=\"pro-summary-table\">
                        <div class=\"pro-row\">
                            <div class=\"pro-label\"><span style=\"color:#ef4444; margin-right:10px; font-size:18px;\">●</span>Temperature</div>
                            <div class=\"pro-data-group\">
                                <div class=\"pro-data-item\"><span class=\"pro-sub\">Maximum</span><span id=\"s-mx\" class=\"pro-val\" style=\"color: #ef4444;\">--</span></div>
                                <div class=\"pro-divider\"></div>
                                <div class=\"pro-data-item\"><span class=\"pro-sub\">Minimum</span><span id=\"s-mn\" class=\"pro-val\" style=\"color: #0ea5e9;\">--</span></div>
                            </div>
                        </div>
                        <div class=\"pro-row\">
                            <div class=\"pro-label\"><span style=\"color:#f59e0b; margin-right:10px; font-size:18px;\">●</span>Wind</div>
                            <div class=\"pro-data-group\">
                                <div class=\"pro-data-item\"><span class=\"pro-sub\">Sustained</span><span id=\"s-mw\" class=\"pro-val\">--</span></div>
                                <div class=\"pro-divider\"></div>
                                <div class=\"pro-data-item\"><span class=\"pro-sub\">Peak Gust</span><span id=\"s-mg\" class=\"pro-val\">--</span></div>
                            </div>
                        </div>
                        <div class=\"pro-row\">
                            <div class=\"pro-label\"><span style=\"color:#3b82f6; margin-right:10px; font-size:18px;\">●</span>Rainfall</div>
                            <div class=\"pro-data-group\">
                                <div class=\"pro-data-item\"><span id=\"s-rt\" class=\"pro-val\" style=\"color: #3b82f6;\">--</span></div>
                                <div class=\"pro-divider\" style=\"visibility: hidden;\"></div>
                                <div class=\"pro-data-item\" style=\"visibility: hidden;\"><span class=\"pro-val\">--</span></div>
                            </div>
                        </div>
                    </div>
                </div>

                <div id=\"sub-view-graphs\" style=\"display: none; animation: fadeIn 0.4s ease;\">
                    <div id=\"graphs-loading\" style=\"text-align: center; padding: 40px; color: var(--muted); font-weight: 700; font-size: 14px; display: none;\">
                        <span style=\"display: inline-block; animation: blink 1.5s infinite;\">Loading 24H Graph Data from Database...</span>
                    </div>
                    <div id=\"graphs-error\" style=\"text-align: center; padding: 40px; color: #ef4444; font-weight: 700; font-size: 14px; display: none;\">Failed to load graph data.</div>
                    <div class=\"graphs-wrapper\" id=\"graphs-wrapper-inner\" style=\"margin-top: 0; display: none;\">
                        <div class=\"graph-card\"><div class=\"label\" style=\"margin-bottom: 8px;\">Temperature Trend</div><div style=\"flex-grow: 1; position: relative;\"><canvas id=\"cT\"></canvas></div></div>
                        <div class=\"graph-card\"><div class=\"label\" style=\"margin-bottom: 8px;\">Humidity Levels</div><div style=\"flex-grow: 1; position: relative;\"><canvas id=\"cH\"></canvas></div></div>
                        <div class=\"graph-card\"><div class=\"label\" style=\"margin-bottom: 8px;\">Wind Velocity</div><div style=\"flex-grow: 1; position: relative;\"><canvas id=\"cW\"></canvas></div></div>
                        <div class=\"graph-card\"><div class=\"label\" style=\"margin-bottom: 8px;\">Precipitation</div><div style=\"flex-grow: 1; position: relative;\"><canvas id=\"cR\"></canvas></div></div>
                    </div>
                </div>
            </div>
        </div>

        <div id=\"page-summary\" style=\"display: none;\"><div id=\"summary-content\"></div></div>
        <div id=\"page-historical\" style=\"display: none;\"><div id=\"historical-content\"></div></div>
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
            if (isDark) document.body.classList.add('is-night'); else document.body.classList.remove('is-night');
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

        function updateValueWithFade(id, newValue, decimals = 1, suffix = \"\") {
            const obj = document.getElementById(id);
            if (!obj) return;
            const val = newValue !== undefined && newValue !== null ? newValue : 0;
            const formattedValue = parseFloat(val).toFixed(decimals) + suffix;
            if (obj.innerText !== formattedValue) {
                obj.classList.remove('fade-update');
                obj.style.opacity = \"0\";
                setTimeout(() => {
                    void obj.offsetWidth;
                    obj.innerText = formattedValue;
                    obj.style.opacity = \"1\";
                    obj.classList.add('fade-update');
                }, 50);
            }
        }

        // Self-contained Solar/UV meter-bar driver (purely visual)
        (function() {
            function pct(v, max) { v = parseFloat(v) || 0; return Math.max(0, Math.min(100, (v / max) * 100)); }
            function bind(elId, barId, max) {
                const el = document.getElementById(elId);
                const bar = document.getElementById(barId);
                if (!el || !bar) return;
                const sync = function() {
                    const raw = el.innerText.replace(/[^0-9.\\-]/g, '');
                    bar.style.width = pct(raw, max) + '%';
                };
                new MutationObserver(sync).observe(el, { childList: true, characterData: true, subtree: true });
                sync();
            }
            bind('sol', 'solBar', 1200);
            bind('uv', 'uvBar', 11);
        })();

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
                if (!res.ok) throw new Error(\"Failed response\");
                const history = await res.json();
                document.getElementById('graphs-loading').style.display = 'none';
                if (history && history.length > 0) {
                    document.getElementById('graphs-wrapper-inner').style.display = 'grid';
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
                    document.getElementById('graphs-error').innerText = \"No graph data available for today yet.\";
                    document.getElementById('graphs-error').style.display = 'block';
                }
            } catch (err) {
                console.error(\"Error drawing graphs:\", err);
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

                document.getElementById('tTrendBox').innerHTML = d.temp.rate > 0 ? '<span class=\"trend-up\">▲</span> +' + d.temp.rate + '°C /hr' : d.temp.rate < 0 ? '<span class=\"trend-down\">▼</span> ' + d.temp.rate + '°C /hr' : '● Steady';
                document.getElementById('mx').innerHTML = d.temp.max + '°C <span class=\"time-mark\">' + d.temp.maxTime + '</span>';
                document.getElementById('mn').innerHTML = d.temp.min + '°C <span class=\"time-mark\">' + d.temp.minTime + '</span>';
                const feels = d.temp.realFeel;
                const heatColor = feels >= 54 ? '#ef4444' : feels >= 41 ? '#f97316' : feels >= 32 ? '#eab308' : 'var(--text)';
                document.getElementById('rf').style.color = heatColor;
                document.getElementById('rf').innerText = feels + '°C';
                document.getElementById('h_val').innerHTML = d.atmo.hum + '% ' + (d.atmo.hTrend > 0 ? '▲' : d.atmo.hTrend < 0 ? '▼' : '●');
                document.getElementById('d_val').innerText = d.temp.dew + '°C';

                document.getElementById('wd_bracket').innerText = '(' + d.wind.card + ')';
                document.getElementById('mw').innerHTML = d.wind.maxS + ' km/h <span class=\"time-mark\">' + d.wind.maxSTime + '</span>';
                document.getElementById('mg').innerHTML = d.wind.maxG + ' km/h <span class=\"time-mark\">' + d.wind.maxGTime + '</span>';
                document.getElementById('needle').style.transform = 'rotate(' + d.wind.deg + 'deg)';
                liveWindSpeed = d.wind.speed; liveWindDeg = d.wind.deg;

                document.getElementById('r_week').innerText = d.rain.weekly + ' mm';
                document.getElementById('r_month').innerText = d.rain.monthly + ' mm';
                document.getElementById('r_year').innerText = d.rain.yearly + ' mm';
                document.getElementById('mr').innerHTML = d.rain.maxR > 0 ? d.rain.maxR + ' mm/h <span class=\"time-mark\">' + d.rain.maxRTime + '</span>' : '0 mm/h';

                const pTrend = d.atmo.pTrend;
                let pArrow = '●';
                if (pTrend >= 0.1) pArrow = '<span class=\"trend-up\" style=\"color:#ef4444\">▲</span>';
                if (pTrend <= -0.1) pArrow = '<span class=\"trend-down\" style=\"color:#0ea5e9\">▼</span>';
                document.getElementById('pIcon').innerHTML = pArrow;

                document.getElementById('pr').innerText = d.atmo.press;
                document.getElementById('sol').innerText = d.atmo.sol + ' W/m²';
                document.getElementById('uv').innerText = d.atmo.uv;
                document.getElementById('ts').innerText = new Date(d.lastSync).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

                if(document.getElementById('s-mx')) {
                    document.getElementById('s-mx').innerText = d.temp.max + '°C';
                    document.getElementById('s-mn').innerText = d.temp.min + '°C';
                    document.getElementById('s-mw').innerText = d.wind.maxS + ' km/h';
                    document.getElementById('s-mg').innerText = (d.wind.maxG || d.wind.maxS) + ' km/h';
                    document.getElementById('s-rt').innerText = d.rain.total + ' mm';
                }

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
            document.getElementById('page-dashboard').style.display = pageId === 'dashboard' ? 'block' : 'none';
            document.getElementById('page-summary').style.display = pageId === 'summary' ? 'block' : 'none';
            document.getElementById('page-historical').style.display = pageId === 'historical' ? 'block' : 'none';
            document.getElementById('tab-dash').classList.toggle('active', pageId === 'dashboard');
            document.getElementById('tab-sum').classList.toggle('active', pageId === 'summary');
            document.getElementById('tab-hist').classList.toggle('active', pageId === 'historical');
            if (pageId === 'summary') showMonthlySummaryUI();
            else if (pageId === 'historical') showHistoricalUI();
        }

        let selectedMonth = new Date().toLocaleDateString('en-IN', { month: 'long' });
        let selectedYear = new Date().getFullYear().toString();

        async function fetchMonthlySummary() {
            const tableContainer = document.getElementById('archive-data-table');
            if (!tableContainer) return;
            tableContainer.innerHTML = '<div class=\"card\" style=\"text-align:center; padding:40px;\">Querying Database...</div>';
            try {
                const res = await fetch('/api/summary');
                const groups = await res.json();
                const currentKey = selectedMonth + ' ' + selectedYear;
                const days = groups[currentKey] || [];
                if (days.length === 0) {
                    tableContainer.innerHTML = '<div class=\"card\" style=\"text-align:center; padding:60px; color: var(--muted); font-weight: 600;\">No data recorded for ' + currentKey + '</div>';
                    return;
                }
                var rows = days.map(function(d) {
                    return '<div class=\"pro-row\" style=\"display: flex; align-items: center; padding: 15px; border-bottom: 1px solid var(--border);\">' +
                        '<div style=\"width: 20%; font-size: 16px;\"><b>' + new Date(d.record_date).getDate() + '</b></div>' +
                        '<div style=\"width: 25%; display: flex; justify-content: center; gap: 8px;\">' +
                            '<span style=\"color:#ef4444; font-weight: 700;\">' + parseFloat(d.max_temp_c).toFixed(1) + '°</span>' +
                            '<span style=\"opacity: 0.3;\">/</span>' +
                            '<span style=\"color:#0ea5e9; font-weight: 700;\">' + parseFloat(d.min_temp_c).toFixed(1) + '°</span>' +
                        '</div>' +
                        '<div style=\"width: 30%; font-size: 13px; text-align: center;\">' +
                            parseFloat(d.max_wind_kmh).toFixed(1) + ' <small style=\"opacity:0.4\">/</small> ' + parseFloat(d.max_gust_kmh).toFixed(1) + ' <small>km/h</small>' +
                        '</div>' +
                        '<div style=\"width: 25%; font-weight: 800; color: #3b82f6; text-align: right;\">' +
                            parseFloat(d.total_rain_mm).toFixed(1) + ' <small>mm</small>' +
                        '</div>' +
                    '</div>';
                }).join('');
                tableContainer.innerHTML =
                    '<div class=\"pro-summary-table\" style=\"background: var(--card); border-radius: 15px; overflow: hidden; border: 1px solid var(--border);\">' +
                        '<div class=\"pro-row\" style=\"background: var(--badge); font-weight: 800; font-size: 11px; text-transform: uppercase; display: flex; align-items: center; padding: 15px; border-bottom: 1px solid var(--border);\">' +
                            '<div style=\"width: 20%;\">Date</div>' +
                            '<div style=\"width: 25%; text-align: center;\">Temp (H/L)</div>' +
                            '<div style=\"width: 30%; text-align: center;\">Wind / Gust</div>' +
                            '<div style=\"width: 25%; text-align: right;\">Rainfall</div>' +
                        '</div>' + rows +
                    '</div>';
            } catch (e) {
                tableContainer.innerHTML = '<div class=\"card\" style=\"color:#ef4444; padding:20px; text-align:center;\">Error loading data.</div>';
            }
        }

        window.updateArchiveFilter = function() {
            selectedMonth = document.getElementById('monthSelect').value;
            selectedYear = document.getElementById('yearSelect').value;
            fetchMonthlySummary();
        };

        window.showMonthlySummaryUI = function() {
            var content = document.getElementById('summary-content');
            var months = [\"January\", \"February\", \"March\", \"April\", \"May\", \"June\", \"July\", \"August\", \"September\", \"October\", \"November\", \"December\"];
            var monthOptions = \"\";
            for (var i = 0; i < months.length; i++) {
                var m = months[i];
                var sel = (selectedMonth === m) ? 'selected' : '';
                monthOptions += '<option value=\"' + m + '\" ' + sel + '>' + m + '</option>';
            }
            var yearOptions = \"\";
            for (var y = 2026; y <= 2032; y++) {
                var ySel = (selectedYear == y) ? 'selected' : '';
                yearOptions += '<option value=\"' + y + '\" ' + ySel + '>' + y + '</option>';
            }
            content.innerHTML =
                '<div class=\"archive-container\" style=\"animation: fadeIn 0.5s ease;\">' +
                    '<div style=\"margin-bottom: 20px; padding: 15px 25px; display: flex; justify-content: space-between; align-items: center; background: var(--card); border-radius: 20px; border: 1px solid var(--border);\">' +
                        '<div style=\"font-weight: 800; letter-spacing: 0.5px; color: var(--accent);\">MONTHLY ARCHIVES</div>' +
                        '<div style=\"display: flex; gap: 10px;\">' +
                            '<select id=\"monthSelect\" class=\"glass-select\">' + monthOptions + '</select>' +
                            '<select id=\"yearSelect\" class=\"glass-select\">' + yearOptions + '</select>' +
                            '<button onclick=\"updateArchiveFilter()\" style=\"padding: 6px 12px; margin-left: 8px; background: var(--accent); color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 600;\">Get Data</button>' +
                        '</div>' +
                    '</div>' +
                    '<div id=\"archive-data-table\">' +
                        '<div class=\"card\" style=\"text-align:center; padding:60px; color: var(--muted);\">Select a month and click \"Get Data\" to load records.</div>' +
                    '</div>' +
                '</div>';
        };

        window.showHistoricalUI = function() {
            var content = document.getElementById('historical-content');
            var years = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
            var yearOptions = \"\";
            for (var i = 0; i < years.length; i++) {
                yearOptions += '<option value=\"' + years[i] + '\">' + years[i] + '</option>';
            }
            content.innerHTML =
                '<div class=\"archive-container\" style=\"animation: fadeIn 0.4s ease;\">' +
                    '<div style=\"margin-bottom: 20px; padding: 15px; background: var(--card); border-radius: 16px; border: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center;\">' +
                        '<div style=\"font-weight: 800; color: var(--accent); font-size: 0.8rem; letter-spacing: 1px;\">KK NAGAR RAINFALL HISTORY</div>' +
                        '<div style=\"display: flex; gap: 8px;\">' +
                            '<select id=\"histYearSelect\" class=\"glass-select\" style=\"padding: 5px 10px; border-radius: 8px; background: #1e293b; color: white; border: 1px solid #334155;\">' + yearOptions + '</select>' +
                            '<button onclick=\"fetchHistoricalData()\" style=\"padding: 8px 16px; background: #3b82f6; color: white; border: none; border-radius: 10px; font-weight: bold; cursor: pointer;\">FETCH</button>' +
                        '</div>' +
                    '</div>' +
                    '<div id=\"historical-results-table\">' +
                        '<div style=\"text-align: center; padding: 50px 20px; color: #64748b; border: 1px dashed var(--border); border-radius: 16px;\">Select a year and click \"FETCH\" to retrieve records.</div>' +
                    '</div>' +
                '</div>';
        };

        window.fetchHistoricalData = async function() {
            var year = document.getElementById('histYearSelect').value;
            var resultsTable = document.getElementById('historical-results-table');
            resultsTable.innerHTML = '<div style=\"text-align:center; padding:40px; color: var(--muted);\">Syncing Archive...</div>';
            try {
                var response = await fetch('/api/historical-rain?year=' + year);
                var result = await response.json();
                if (!result.data || result.data.length === 0) {
                    resultsTable.innerHTML = '<div style=\"text-align:center; padding:40px; color: #ef4444;\">No data found for ' + year + '</div>';
                    return;
                }
                var months = result.data.filter(function(d) { return d.month_val !== 'Annual'; });
                var annualRow = result.data.find(function(d) { return d.month_val === 'Annual'; });
                var preMonsoonTotal = 0, swmTotal = 0, nemTotal = 0;
                months.forEach(function(m) {
                    var val = parseFloat(m.rainfall_mm) || 0;
                    var mKey = m.month_val.substring(0, 3).toUpperCase();
                    if (['JAN','FEB','MAR','APR','MAY'].indexOf(mKey) !== -1) preMonsoonTotal += val;
                    if (['JUN','JUL','AUG','SEP'].indexOf(mKey) !== -1) swmTotal += val;
                    if (['OCT','NOV','DEC'].indexOf(mKey) !== -1) nemTotal += val;
                });
                var leftCol = months.slice(0, 6);
                var rightCol = months.slice(6, 12);
                function renderCard(d) {
                    var rf = parseFloat(d.rainfall_mm) || 0;
                    var mKey = d.month_val.substring(0, 3).toUpperCase();
                    var mainTextColor = 'var(--text)';
                    var bgColor = 'var(--card)';
                    var borderColor = 'var(--border)';
                    var monthTextColor = 'var(--muted)';
                    if (['JUN','JUL','AUG','SEP'].indexOf(mKey) !== -1) {
                        bgColor = 'rgba(245, 158, 11, 0.08)'; borderColor = 'rgba(245, 158, 11, 0.4)'; monthTextColor = '#d97706';
                    } else if (['OCT','NOV','DEC'].indexOf(mKey) !== -1) {
                        bgColor = 'rgba(5, 150, 105, 0.08)'; borderColor = 'rgba(5, 150, 105, 0.4)'; monthTextColor = '#059669';
                    }
                    return '<div style=\"background:' + bgColor + '; border: 1.5px solid ' + borderColor + '; border-radius: 12px; padding: 14px; margin-bottom: 10px; text-align: center;\">' +
                                '<div style=\"font-size: 0.75rem; font-weight: 900; color: ' + monthTextColor + '; letter-spacing: 1.2px; text-transform: uppercase; margin-bottom: 4px;\">' + d.month_val.substring(0,3) + '</div>' +
                                '<div style=\"font-size: 1.4rem; font-weight: 900; color: ' + mainTextColor + ';\">' + rf.toFixed(1) + '<span style=\"font-size: 0.8rem; opacity: 0.5; margin-left: 2px;\">mm</span></div>' +
                           '</div>';
                }
                var html = '<div style=\"display: flex; gap: 12px; margin-top: 10px;\">';
                html += '<div style=\"flex: 1;\">' + leftCol.map(renderCard).join('') + '</div>';
                html += '<div style=\"flex: 1;\">' + rightCol.map(renderCard).join('') + '</div>';
                html += '</div>';
                html += '<div style=\"display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 5px;\">';
                var seasonalStyle = 'border-radius: 16px; padding: 20px 5px; text-align: center; border: 2.5px solid;';
                html += '<div style=\"' + seasonalStyle + ' background: var(--card); border-color: var(--border);\">' +
                            '<div style=\"font-size: 0.8rem; font-weight: 900; color: var(--muted); letter-spacing: 1px; margin-bottom: 6px;\">JAN-MAY</div>' +
                            '<div style=\"font-size: 1.7rem; font-weight: 900; color: var(--text);\">' + preMonsoonTotal.toFixed(1) + '</div>' +
                        '</div>';
                html += '<div style=\"' + seasonalStyle + ' background: rgba(245, 158, 11, 0.12); border-color: rgba(245, 158, 11, 0.5);\">' +
                            '<div style=\"font-size: 0.8rem; font-weight: 900; color: #d97706; letter-spacing: 1px; margin-bottom: 6px;\">SWM</div>' +
                            '<div style=\"font-size: 1.7rem; font-weight: 900; color: var(--text);\">' + swmTotal.toFixed(1) + '</div>' +
                        '</div>';
                html += '<div style=\"' + seasonalStyle + ' background: rgba(5, 150, 105, 0.12); border-color: rgba(5, 150, 105, 0.5);\">' +
                            '<div style=\"font-size: 0.8rem; font-weight: 900; color: #059669; letter-spacing: 1px; margin-bottom: 6px;\">NEM</div>' +
                            '<div style=\"font-size: 1.7rem; font-weight: 900; color: var(--text);\">' + nemTotal.toFixed(1) + '</div>' +
                        '</div>';
                html += '</div>';
                if (annualRow) {
                    html += '<div style=\"margin-top: 15px; background: var(--card); border: 2px solid #64748b; border-radius: 18px; padding: 24px; text-align: center; box-shadow: 0 4px 20px rgba(0,0,0,0.08);\">' +
                                '<div style=\"font-size: 0.8rem; color: #64748b; font-weight: 900; letter-spacing: 2px; margin-bottom: 6px;\">' + year + ' ANNUAL TOTAL</div>' +
                                '<div style=\"font-size: 3rem; font-weight: 950; color: var(--text); line-height: 1;\">' + parseFloat(annualRow.rainfall_mm).toFixed(1) + '<span style=\"font-size: 1.2rem; opacity: 0.4; margin-left: 6px; font-weight: 700;\">mm</span></div>' +
                            '</div>';
                }
                resultsTable.innerHTML = html;
            } catch (error) {
                resultsTable.innerHTML = '<div style=\"text-align:center; padding:40px; color: #ef4444;\">Connection failed.</div>';
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
