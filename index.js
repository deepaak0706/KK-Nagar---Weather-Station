const express = require("express"); 

const fetch = require("node-fetch");
const { Pool } = require('pg');
const path = require("path");
const app = express();

const pool = new Pool({
    connectionString: process.env.POSTGRES_URL + "?sslmode=require",
    ssl: { rejectUnauthorized: false }
});

// Existing — DO NOT TOUCH
const APPLICATION_KEY = process.env.APPLICATION_KEY;
const API_KEY = process.env.API_KEY;
const MAC = process.env.MAC;

// New — Neelangarai
const NL_APPLICATION_KEY = process.env.NL_APPLICATION_KEY;
const NL_API_KEY = process.env.NL_API_KEY;
const NL_MAC = process.env.NL_MAC;

// =============================================
// STATION CONFIGURATION
// =============================================

const STATIONS = {
    kknagar: {
        id: 'kknagar',
        name: 'KK Nagar',
        type: 'ecowitt',
        appKey: APPLICATION_KEY,
        apiKey: API_KEY,
        mac: MAC,
        yearlyBaseline: 312.2,
        yearlyApiOffset: null,
        // ← ADD THESE 4 LINES:
        dataStartYear: 2019,
        dataEndYear: 2026,
        summaryStartYear: 2026,
        summaryEndYear: 2032,
    },
    neelangarai: {
        id: 'neelangarai',
        name: 'Neelangarai',
        type: 'ambient',
        appKey: NL_APPLICATION_KEY,
        apiKey: NL_API_KEY,
        mac: NL_MAC,
        yearlyBaseline: 0,
        yearlyApiOffset: null,
        // ← ADD THESE 4 LINES:
        dataStartYear: 2020,
        dataEndYear: 2026,
        summaryStartYear: 2026,
        summaryEndYear: 2032,
    },
};


// =============================================
// PER-STATION MEMORY STATE
// =============================================
const stationState = {
    kknagar: { 
        cachedData: null, lastFetchTime: 0, lastDbWrite: 0,
        lastRainRaw: null, lastCalculatedRate: 0, lastRainTime: 0, 
        bufW: 0, bufG: 0, bufMaxT: -999, bufMinT: 999, bufRR: 0,
        tW: null, tG: null, tMaxT: null, tMinT: null, tRR: null,
        lastArchivedDate: null, dataChangedSinceLastRead: false,
        summaryCache: null, lastSummaryFetchDate: null, lastDateSeen: null,
        yearlyApiOffset: null,  // ← ADD THIS
    },
    neelangarai: { 
        cachedData: null, lastFetchTime: 0, lastDbWrite: 0,
        lastRainRaw: null, lastCalculatedRate: 0, lastRainTime: 0, 
        bufW: 0, bufG: 0, bufMaxT: -999, bufMinT: 999, bufRR: 0,
        tW: null, tG: null, tMaxT: null, tMinT: null, tRR: null,
        lastArchivedDate: null, dataChangedSinceLastRead: false,
        summaryCache: null, lastSummaryFetchDate: null, lastDateSeen: null,
        yearlyApiOffset: null,  // ← ADD THIS
    },
};

function resetStateBuffers(station) {
    const s = stationState[station.id];
    s.bufW = 0; s.bufG = 0; s.bufMaxT = -999; s.bufMinT = 999; s.bufRR = 0;
    s.tW = null; s.tG = null; s.tMaxT = null; s.tMinT = null; s.tRR = null;
}

async function loadBufferState(station) {
    const res = await pool.query(
        'SELECT * FROM buffer_state WHERE station_id = $1',
        [station.id]  // ← FIX: use station.id, not station.bufferId
    );
    const row = res.rows[0];
    if (!row) {
        // If row doesn't exist for this station, return defaults
        return {
            lastRainRaw: null,
            lastRainTime: 0,
            lastCalculatedRate: 0,
            bufW: 0, bufG: 0, bufMaxT: -999, bufMinT: 999, bufRR: 0,
            tW: null, tG: null, tMaxT: null, tMinT: null, tRR: null,
        };
    }
    return {
        lastRainRaw: row.last_rain_raw,
        lastRainTime: row.last_rain_time ? Number(row.last_rain_time) : 0,
        lastCalculatedRate: row.last_calculated_rate,
        bufW: row.buf_w,
        bufG: row.buf_g,
        bufMaxT: row.buf_max_t,
        bufMinT: row.buf_min_t,
        bufRR: row.buf_rr,
        tW: row.t_w,
        tG: row.t_g,
        tMaxT: row.t_max_t,
        tMinT: row.t_min_t,
        tRR: row.t_rr,
    };
}

async function saveBufferState(station, b) {
    await pool.query(`
        UPDATE buffer_state SET
            last_rain_raw = $1, last_rain_time = $2, last_calculated_rate = $3,
            buf_w = $4, buf_g = $5, buf_max_t = $6, buf_min_t = $7, buf_rr = $8,
            t_w = $9, t_g = $10, t_max_t = $11, t_min_t = $12, t_rr = $13
        WHERE station_id = $14
    `, [
        b.lastRainRaw, b.lastRainTime, b.lastCalculatedRate,
        b.bufW, b.bufG, b.bufMaxT, b.bufMinT, b.bufRR,
        b.tW, b.tG, b.tMaxT, b.tMinT, b.tRR,
        station.id  // ← FIX: use station.id
    ]);
}

async function resetBufferPeaksDB(station) {
    await pool.query(`
        UPDATE buffer_state SET
            buf_w = 0, buf_g = 0, buf_max_t = -999, buf_min_t = 999, buf_rr = 0,
            t_w = NULL, t_g = NULL, t_max_t = NULL, t_min_t = NULL, t_rr = NULL
        WHERE station_id = $1
    `, [station.id]);  // ← FIX: use station.id
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

 function processRainLogic(buf, newDailyInches, currentTimeStamp, isCron = false) {
     // If a user refresh happens, don't update the baseline or time
    // Only the Cron should advance the "lastRainRaw" and "lastRainTime"
    if (!isCron) {
        return buf; 
    }
    const now = Date.now();
    
    if (buf.lastRainRaw === null) {
        buf.lastRainRaw = newDailyInches;
        buf.lastRainTime = now;
        return buf;
    }

    // --- MIDNIGHT RESET FIX ---
    // If the API resets the daily total back to 0 (or a lower number)
    if (newDailyInches < buf.lastRainRaw) {
        buf.lastRainRaw = newDailyInches; // Reset our baseline tracker
        return buf;    // Exit without calculating a rate
    }
    // --------------------------

    const deltaRain = newDailyInches - buf.lastRainRaw;

    if (deltaRain > 0.0001) { 
        let timeSinceLastTipSec = (now - buf.lastRainTime) / 1000;

        if (timeSinceLastTipSec > 600) {
            timeSinceLastTipSec = 60; 
        }

        const effectiveTime = Math.max(timeSinceLastTipSec, 60);
        
        buf.lastCalculatedRate = deltaRain * (3600 / effectiveTime);
        
        buf.lastRainRaw = newDailyInches;
        buf.lastRainTime = now; 
    } 

    if (buf.lastCalculatedRate > (buf.bufRR || 0)) { 
        buf.bufRR = buf.lastCalculatedRate; 
        buf.tRR = currentTimeStamp; 
    }
    
    return buf;
}


 
// Fix the dangling return and the buffer function
/**
 * 1-MIN CRON: Memory Buffer & Decay Engine
 */

async function bufferOnlyUpdate(station) {
    const now = Date.now();
    const currentTimeStamp = new Date().toISOString();
    const st = stationState[station.id];

    try {
        let apiW, apiG, apiT, dailyRainInches;

        if (station.type === 'ecowitt') {
            const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${station.appKey}&api_key=${station.apiKey}&mac=${station.mac}&rainfall_unitid=12`;
            const response = await fetch(url);
            const json = await response.json();
            if (!json.data) throw new Error("Invalid Ecowitt API Response");
            const d = json.data;

            apiW = parseFloat(d.wind.wind_speed.value);
            apiG = parseFloat(d.wind.wind_gust.value);
            apiT = parseFloat(d.outdoor.temperature.value);
            dailyRainInches = parseFloat(d.rainfall.daily.value) / 25.4;

        } else if (station.type === 'ambient') {
            const url = `https://api.ambientweather.net/v1/devices?applicationKey=${station.appKey}&apiKey=${station.apiKey}&limit=1`;
            const response = await fetch(url);
            const json = await response.json();
            if (!json || !json[0]) throw new Error("Invalid Ambient API Response");
            const d = json[0].lastData;

            apiW = parseFloat(d.windspeedmph);
            apiG = parseFloat(d.windgustmph);
            apiT = parseFloat(d.tempf);
            dailyRainInches = parseFloat(d.dailyrainin);
        }

        let buf = await loadBufferState(station);

        // 1. Process rain tips
        buf = processRainLogic(buf, dailyRainInches, currentTimeStamp, true);

        // 2. Decay engine
        const secondsSinceLastTip = (now - buf.lastRainTime) / 1000;
        if (secondsSinceLastTip > 180) {
            buf.lastCalculatedRate *= 0.8;
            if (buf.lastCalculatedRate < 0.05) buf.lastCalculatedRate = 0;
        }

        // 3. Wind & temp peak buffering
        if (buf.tW === null || apiW > buf.bufW) { buf.bufW = apiW; buf.tW = currentTimeStamp; }
        if (buf.tG === null || apiG > buf.bufG) { buf.bufG = apiG; buf.tG = currentTimeStamp; }
        if (buf.tMaxT === null || apiT > buf.bufMaxT) { buf.bufMaxT = apiT; buf.tMaxT = currentTimeStamp; }
        if (buf.tMinT === null || apiT < buf.bufMinT) { buf.bufMinT = apiT; buf.tMinT = currentTimeStamp; }

        await saveBufferState(station, buf);

        st.lastFetchTime = now;
        return { ok: true, buffered: true, station: station.id, currentRate: buf.lastCalculatedRate };

    } catch (e) {
        console.error(`Cron Buffer Error [${station.id}]:`, e.message);
        return { error: e.message };
    }
}


/**
 * MAIN SYNC: Handles Dashboard, 10-Min DB Write, and Midnight Reset
 */
async function syncWithEcowitt(station, forceWrite = false) {
    const now = Date.now();
    const st = stationState[station.id];
    const fmtL = () => new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
    const nowIST = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const todayISTStr = nowIST.toLocaleDateString('en-CA');
    const hour = nowIST.getHours();
    const minute = nowIST.getMinutes();

    if (st.lastArchivedDate && st.lastArchivedDate !== todayISTStr) {
        st.cachedData = null;
    }

    // ── FETCH RAW DATA FROM API ──────────────────────────────
    const fetchLiveData = async () => {
        if (station.type === 'ecowitt') {
            const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${station.appKey}&api_key=${station.apiKey}&mac=${station.mac}&rainfall_unitid=12`;
            const response = await fetch(url);
            const json = await response.json();
            if (!json.data) throw new Error("Invalid Ecowitt Response");
            const d = json.data;
            return {
                tempF:      parseFloat(d.outdoor.temperature.value),
                dewF:       parseFloat(d.outdoor.dew_point.value),
                humidity:   parseFloat(d.outdoor.humidity.value) || 0,
                pressInHg:  parseFloat(d.pressure.relative.value),
                windMph:    parseFloat(d.wind.wind_speed.value),
                gustMph:    parseFloat(d.wind.wind_gust.value),
                windDeg:    parseFloat(d.wind.wind_direction.value),
                dailyIn:    parseFloat(d.rainfall.daily.value) / 25.4,
                weeklyIn:   parseFloat(d.rainfall.weekly.value) / 25.4,
                monthlyIn:  parseFloat(d.rainfall.monthly.value) / 25.4,
                yearlyIn:   parseFloat(d.rainfall.yearly.value) / 25.4,
                solar:      d.solar_and_uvi?.solar?.value || 0,
                uv:         d.solar_and_uvi?.uvi?.value || 0,
                pressRaw:   parseFloat(d.pressure.relative.value),
            };
        } else {
            const url = `https://api.ambientweather.net/v1/devices?applicationKey=${station.appKey}&apiKey=${station.apiKey}&limit=1`;
            const response = await fetch(url);
            const json = await response.json();
            if (!json || !json[0]) throw new Error("Invalid Ambient Response");
            const d = json[0].lastData;
            return {
                tempF:      parseFloat(d.tempf),
                dewF:       parseFloat(d.dewPoint),
                humidity:   parseFloat(d.humidity) || 0,
                pressInHg:  parseFloat(d.baromrelin),
                windMph:    parseFloat(d.windspeedmph),
                gustMph:    parseFloat(d.windgustmph),
                windDeg:    parseFloat(d.winddir),
                dailyIn:    parseFloat(d.dailyrainin),
                weeklyIn:   parseFloat(d.weeklyrainin),
                monthlyIn:  parseFloat(d.monthlyrainin),
                yearlyIn:   parseFloat(d.yearlyrainin),
                solar:      parseFloat(d.solarradiation) || 0,
                uv:         parseFloat(d.uv) || 0,
                pressRaw:   parseFloat(d.baromrelin),
            };
        }
    };

    // ── VISITOR PATH (cache < 9 min) ─────────────────────────
    if (!forceWrite && st.cachedData && (now - st.lastFetchTime < 540000)) {
        try {
            const r = await fetchLiveData();
            const buf = await loadBufferState(station);
            const liveRR = parseFloat((buf.lastCalculatedRate * 25.4).toFixed(1));

            const liveTemp = parseFloat(((r.tempF - 32) * 5 / 9).toFixed(1));
            const liveWind = parseFloat((r.windMph * 1.60934).toFixed(1));
            const liveGust = parseFloat((r.gustMph * 1.60934).toFixed(1));
            const livePress = parseFloat((r.pressInHg * 33.8639).toFixed(1));
            const liveDewC = parseFloat(((r.dewF - 32) * 5 / 9).toFixed(1));

            st.cachedData.temp.current = liveTemp;
            st.cachedData.temp.dew = liveDewC;
            st.cachedData.temp.realFeel = calculateRealFeel(liveTemp, r.humidity);
            st.cachedData.atmo.hum = r.humidity;
            st.cachedData.atmo.press = livePress;
            st.cachedData.wind.speed = liveWind;
            st.cachedData.wind.gust = liveGust;
            st.cachedData.rain.total = Math.round(r.dailyIn * 2540) / 100;
            st.cachedData.rain.rate = liveRR;

            const fmtIso = (iso) => iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }) : fmtL();

            if (liveTemp > st.cachedData.temp.max) { st.cachedData.temp.max = liveTemp; st.cachedData.temp.maxTime = fmtL(); }
            if (liveTemp < st.cachedData.temp.min) { st.cachedData.temp.min = liveTemp; st.cachedData.temp.minTime = fmtL(); }
            if (liveWind > st.cachedData.wind.maxS) { st.cachedData.wind.maxS = liveWind; st.cachedData.wind.maxSTime = fmtL(); }
            if (liveGust > st.cachedData.wind.maxG) { st.cachedData.wind.maxG = liveGust; st.cachedData.wind.maxGTime = fmtL(); }
            if (liveRR > st.cachedData.rain.maxR) { st.cachedData.rain.maxR = liveRR; st.cachedData.rain.maxRTime = fmtL(); }

            if (buf.bufMaxT !== -999) { const v = parseFloat(((buf.bufMaxT-32)*5/9).toFixed(1)); if (v > st.cachedData.temp.max) { st.cachedData.temp.max = v; st.cachedData.temp.maxTime = fmtIso(buf.tMaxT); } }
            if (buf.bufMinT !== 999)  { const v = parseFloat(((buf.bufMinT-32)*5/9).toFixed(1)); if (v < st.cachedData.temp.min) { st.cachedData.temp.min = v; st.cachedData.temp.minTime = fmtIso(buf.tMinT); } }
            if (buf.bufW > 0) { const v = parseFloat((buf.bufW*1.60934).toFixed(1)); if (v > st.cachedData.wind.maxS) { st.cachedData.wind.maxS = v; st.cachedData.wind.maxSTime = fmtIso(buf.tW); } }
            if (buf.bufG > 0) { const v = parseFloat((buf.bufG*1.60934).toFixed(1)); if (v > st.cachedData.wind.maxG) { st.cachedData.wind.maxG = v; st.cachedData.wind.maxGTime = fmtIso(buf.tG); } }
            if (buf.bufRR > 0) { const v = parseFloat((buf.bufRR*25.4).toFixed(1)); if (v > st.cachedData.rain.maxR) { st.cachedData.rain.maxR = v; st.cachedData.rain.maxRTime = fmtIso(buf.tRR); } }

            st.cachedData.lastSync = new Date().toISOString();
            st.lastFetchTime = now;
            return st.cachedData;
        } catch (e) {
            console.error(`Visitor Sync Error [${station.id}]:`, e);
            return st.cachedData;
        }
    }

    // ── WRITER PATH ──────────────────────────────────────────
    try {
        let snap;
        let dbWriteSuccess = false;

        if (st.lastDateSeen !== todayISTStr) {
            console.log(`📆 New day [${station.id}] (${todayISTStr}). Clearing cache.`);
            st.cachedData = null;
            st.dataChangedSinceLastRead = true;
            st.lastDateSeen = todayISTStr;
            resetStateBuffers(station);
        }

        const r = await fetchLiveData();

        const liveTemp  = parseFloat(((r.tempF - 32) * 5 / 9).toFixed(1));
        const liveDewC  = parseFloat(((r.dewF - 32) * 5 / 9).toFixed(1));
        const liveHum   = r.humidity;
        const livePress = parseFloat((r.pressInHg * 33.8639).toFixed(1));
        const liveWind  = parseFloat((r.windMph * 1.60934).toFixed(1));
        const liveGust  = parseFloat((r.gustMph * 1.60934).toFixed(1));

        let writerBuf;
        if (forceWrite) {
            writerBuf = await loadBufferState(station);
            snap = {
                maxT: writerBuf.bufMaxT, minT: writerBuf.bufMinT,
                w: writerBuf.bufW, g: writerBuf.bufG, rr: writerBuf.bufRR,
                tMaxT: writerBuf.tMaxT, tMinT: writerBuf.tMinT,
                tW: writerBuf.tW, tG: writerBuf.tG, tRR: writerBuf.tRR
            };

            const client = await pool.connect();
try {
    await client.query('BEGIN');

    const checkStart = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const checkEnd   = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const dupCheck   = await client.query(`
        SELECT 1 FROM weather_history 
        WHERE station_id = $1 AND time BETWEEN $2 AND $3 LIMIT 1
    `, [station.id, checkStart, checkEnd]);

    if (!(hour === 0 && minute < 5) && dupCheck.rows.length > 0) {
        console.log(`⚠️ Duplicate skipped [${station.id}]`);
        await client.query('ROLLBACK');
        dbWriteSuccess = true;
        client.release();
        return st.cachedData;
    }

    let timeSql = 'NOW()';
    if (hour === 0 && minute < 5) {
        timeSql = "(date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata') - INTERVAL '1 second'";
    }

    const dbMaxT = snap.maxT === -999 ? r.tempF   : snap.maxT;
    const dbMinT = snap.minT ===  999 ? r.tempF   : snap.minT;
    const dbW    = snap.tW   === null  ? r.windMph : snap.w;
    const dbG    = snap.tG   === null  ? r.gustMph : snap.g;
    const dbRR   = snap.rr || 0;

    // At midnight the API resets daily rain to 0.
    // Use buffer's last known rain value if it's higher than what API returned.
    const dbDailyIn = (hour === 0 && minute < 5 && writerBuf.lastRainRaw !== null && writerBuf.lastRainRaw > r.dailyIn)
    ? writerBuf.lastRainRaw
    : r.dailyIn;


    if (isNaN(r.tempF) || isNaN(dbMaxT) || isNaN(dbMinT) || isNaN(dbW) || isNaN(dbG)) {
    console.error(`Bad reading — skipping insert [${station.id}]`, { tempF: r.tempF, dbMaxT, dbMinT, dbW, dbG });
    await client.query('ROLLBACK');
    client.release();
    return st.cachedData;
    }
    
    await client.query(`
        INSERT INTO weather_history 
        (station_id, time, temp_f, temp_min_f, temp_current_f, humidity,
         wind_speed_mph, wind_gust_mph, rain_rate_in, daily_rain_in,
         max_w_time, max_t_time, min_t_time, max_r_time, max_g_time,
         solar_radiation, press_rel)
        VALUES ($1, ${timeSql}, $2, $3, $4, $5, $6, $7, $8, $9,
                $10, $11, $12, $13, $14, $15, $16)
    `, [
        station.id,
        dbMaxT, dbMinT, r.tempF, liveHum, dbW, dbG, dbRR, dbDailyIn,
        snap.tW    || new Date().toISOString(),
        snap.tMaxT || new Date().toISOString(),
        snap.tMinT || new Date().toISOString(),
        snap.tRR   || new Date().toISOString(),
        snap.tG    || new Date().toISOString(),
        r.solar, r.pressRaw
    ]);

    // Midnight rollup — runs INSIDE transaction
    let didRollup = false;
    if (hour === 0 && minute < 30 && st.lastArchivedDate !== todayISTStr) {
        await client.query(`
            INSERT INTO daily_max_records 
                (station_id, record_date, max_temp_c, min_temp_c, max_wind_kmh, max_gust_kmh, total_rain_mm)
            SELECT 
                station_id,
                (time AT TIME ZONE 'Asia/Kolkata')::date,
                MAX((temp_f - 32) * 5/9), MIN((temp_min_f - 32) * 5/9),
                MAX(wind_speed_mph * 1.60934), MAX(wind_gust_mph * 1.60934),
                MAX(daily_rain_in * 25.4)
            FROM weather_history
            WHERE station_id = $1
              AND (time AT TIME ZONE 'Asia/Kolkata')::date < $2::date
            GROUP BY station_id, (time AT TIME ZONE 'Asia/Kolkata')::date
            ON CONFLICT (station_id, record_date) DO UPDATE SET
                max_temp_c=EXCLUDED.max_temp_c, min_temp_c=EXCLUDED.min_temp_c,
                max_wind_kmh=EXCLUDED.max_wind_kmh, max_gust_kmh=EXCLUDED.max_gust_kmh,
                total_rain_mm=EXCLUDED.total_rain_mm
        `, [station.id, todayISTStr]);

        await client.query(`
            DELETE FROM weather_history 
            WHERE station_id = $1 
              AND (time AT TIME ZONE 'Asia/Kolkata')::date < $2::date
        `, [station.id, todayISTStr]);

        didRollup = true;
    }

    // Single COMMIT covers everything
    await client.query('COMMIT');

    // Update in-memory state ONLY after confirmed commit
    if (didRollup) {
        st.lastArchivedDate = todayISTStr;
        st.cachedData = null;
        resetStateBuffers(station);
        await resetBufferPeaksDB(station);  // ← ADD THIS
        snap=undefined;
        console.log(`✅ Midnight rollup complete [${station.id}]`);
    }


    st.dataChangedSinceLastRead = true;
    dbWriteSuccess = true;

} catch (err) {
    await client.query('ROLLBACK');
    console.error(`CRITICAL: DB Write Failed [${station.id}]`, err);
} finally { client.release(); }

        }

        // Load max/min from DB if data changed
        let tempRate = st.cachedData?.temp?.rate || 0;
        let humRate  = st.cachedData?.atmo?.hTrend || 0;
        let pressRate = st.cachedData?.atmo?.pTrend || 0;
        let mx_t = -999, mn_t = 999, mx_w = 0, mx_g = 0, mx_r = 0;
        let mx_t_time = null, mn_t_time = null, mx_w_t = null, mx_g_t = null, mx_r_t = null;

        if (st.dataChangedSinceLastRead || !st.cachedData) {
            try {
                const historyRes = await pool.query(`
                    SELECT * FROM weather_history
                    WHERE station_id = $1
                      AND (time AT TIME ZONE 'Asia/Kolkata')::date = $2::date
                    ORDER BY time ASC
                `, [station.id, todayISTStr]);

                let pastRecord = null;
                const oneHourAgo = Date.now() - 3600000;
                let closestDiff = Infinity;

                historyRes.rows.forEach(row => {
                    const fmt = (iso) => new Date(iso || row.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
                    const r_max_t = parseFloat(((row.temp_f - 32) * 5/9).toFixed(1));
                    const r_min_t = parseFloat(((row.temp_min_f - 32) * 5/9).toFixed(1));
                    const r_w    = parseFloat((row.wind_speed_mph * 1.60934).toFixed(1));
                    const r_g    = parseFloat((row.wind_gust_mph * 1.60934).toFixed(1));
                    const r_rr   = parseFloat((row.rain_rate_in * 25.4).toFixed(1));

                    if (r_max_t > mx_t) { mx_t = r_max_t; mx_t_time = fmt(row.max_t_time); }
                    if (r_min_t < mn_t) { mn_t = r_min_t; mn_t_time = fmt(row.min_t_time); }
                    if (r_w > mx_w)     { mx_w = r_w;     mx_w_t    = fmt(row.max_w_time); }
                    if (r_g > mx_g)     { mx_g = r_g;     mx_g_t    = fmt(row.max_g_time); }
                    if (r_rr > mx_r)    { mx_r = r_rr;    mx_r_t    = fmt(row.max_r_time); }

                    const diff = Math.abs(new Date(row.time).getTime() - oneHourAgo);
                    if (diff < closestDiff) { closestDiff = diff; pastRecord = row; }
                });

                if (!pastRecord && historyRes.rows.length > 0) pastRecord = historyRes.rows[0];

                if (pastRecord) {
                    const pastTempF = pastRecord.temp_current_f != null ? pastRecord.temp_current_f : pastRecord.temp_f;
                    const pastTemp = parseFloat(((pastTempF - 32) * 5/9).toFixed(1));
                    const timeWindowHours = (Date.now() - new Date(pastRecord.time).getTime()) / 3600000;
                    tempRate  = parseFloat(((liveTemp - pastTemp) / timeWindowHours).toFixed(1));
                    humRate   = parseFloat((liveHum - pastRecord.humidity).toFixed(1));
                    if (pastRecord.press_rel) {
                        pressRate = parseFloat((livePress - parseFloat((pastRecord.press_rel * 33.8639).toFixed(1))).toFixed(1));
                    }
                }
                st.dataChangedSinceLastRead = false;
            } catch (dbError) { console.error("DB Prep Error:", dbError); }
        }

        const writerBufForRR = await loadBufferState(station);
        const liveRR = parseFloat((writerBufForRR.lastCalculatedRate * 25.4).toFixed(1));

        const fmtIso = (iso) => iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }) : fmtL();

        if (mx_t === -999) { mx_t = liveTemp; mx_t_time = fmtL(); }
        if (mn_t ===  999) { mn_t = liveTemp; mn_t_time = fmtL(); }
        if (mx_w ===    0) { mx_w = liveWind; mx_w_t    = fmtL(); }
        if (mx_g ===    0) { mx_g = liveGust; mx_g_t    = fmtL(); }
        if (mx_r ===    0) { mx_r = liveRR;   mx_r_t    = fmtL(); }

        if (liveTemp > mx_t) { mx_t = liveTemp; mx_t_time = fmtL(); }
        if (liveTemp < mn_t) { mn_t = liveTemp; mn_t_time = fmtL(); }
        if (liveWind > mx_w) { mx_w = liveWind; mx_w_t    = fmtL(); }
        if (liveGust > mx_g) { mx_g = liveGust; mx_g_t    = fmtL(); }
        if (liveRR   > mx_r) { mx_r = liveRR;   mx_r_t    = fmtL(); }

        const source = (forceWrite && typeof snap !== 'undefined') ? snap : st;
        if (source.maxT !== -999 && source.maxT !== undefined) { const v = parseFloat(((source.maxT-32)*5/9).toFixed(1)); if (v > mx_t) { mx_t = v; mx_t_time = fmtIso(source.tMaxT); } }
        if (source.minT !==  999 && source.minT !== undefined) { const v = parseFloat(((source.minT-32)*5/9).toFixed(1)); if (v < mn_t) { mn_t = v; mn_t_time = fmtIso(source.tMinT); } }
        if (source.w > 0) { const v = parseFloat((source.w*1.60934).toFixed(1)); if (v > mx_w) { mx_w = v; mx_w_t = fmtIso(source.tW); } }
        if (source.g > 0) { const v = parseFloat((source.g*1.60934).toFixed(1)); if (v > mx_g) { mx_g = v; mx_g_t = fmtIso(source.tG); } }
        if (source.rr > 0) { const v = parseFloat((source.rr*25.4).toFixed(1)); if (v > mx_r) { mx_r = v; mx_r_t = fmtIso(source.tRR); } }

        st.cachedData = {
            temp: { current: liveTemp, max: mx_t, maxTime: mx_t_time, min: mn_t, minTime: mn_t_time, realFeel: calculateRealFeel(liveTemp, liveHum), rate: tempRate, dew: liveDewC },
            atmo: { hum: liveHum, hTrend: humRate, press: livePress, pTrend: pressRate, sol: r.solar, uv: r.uv },
            wind: { speed: liveWind, gust: liveGust, maxS: mx_w, maxSTime: mx_w_t, maxG: mx_g, maxGTime: mx_g_t, deg: r.windDeg, card: getCard(r.windDeg) },
            rain: (() => {
    let yearlyMm = Math.round(r.yearlyIn * 25.4);
    
    if (station.yearlyBaseline > 0) {  // Only for KK Nagar
        // First read: capture the API's baseline from today
        if (st.yearlyApiOffset === null) {
            st.yearlyApiOffset = yearlyMm;
        }
        // Calculate: hardcoded baseline + (current API value - API baseline from today)
        yearlyMm = station.yearlyBaseline + (yearlyMm - st.yearlyApiOffset);
    }
    
    return {
        total:   Math.round(r.dailyIn  * 2540) / 100,
        rate:    liveRR,
        maxR:    mx_r,
        maxRTime: mx_r_t,
        weekly:  Math.round(r.weeklyIn  * 2540) / 100,
        monthly: Math.round(r.monthlyIn * 2540) / 100,
        yearly:  yearlyMm,
    };
})(),
            lastSync: new Date().toISOString()
        };

        if (forceWrite && dbWriteSuccess) await resetBufferPeaksDB(station);

        st.lastFetchTime = now;
        return st.cachedData;

    } catch (e) {
        console.error(`Sync Error [${station.id}]:`, e);
        return st.cachedData;
    }
}
async function getWeatherSummary(station) {
    const st = stationState[station.id];
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    if (st.summaryCache && st.lastSummaryFetchDate === today) return st.summaryCache;
    try {
        const res = await pool.query(
            `SELECT * FROM daily_max_records WHERE station_id = $1 ORDER BY record_date DESC`,
            [station.id]
        );
        const formatted = res.rows.reduce((acc, row) => {
            const mY = new Date(row.record_date).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
            if (!acc[mY]) acc[mY] = [];
            acc[mY].push(row);
            return acc;
        }, {});
        st.summaryCache = formatted;
        st.lastSummaryFetchDate = today;
        return formatted;
    } catch (err) { return { error: err.message }; }
}

// Routes

/**
 * ROUTES
 */

function getStation(req) {
    const id = req.query.station || 'kknagar';
    return STATIONS[id] || STATIONS.kknagar;
}

app.get("/weather", async (req, res) => {
    const s = getStation(req);
    res.json(await syncWithEcowitt(s, false));
});

app.get("/api/summary", async (req, res) => {
    const s = getStation(req);
    res.json(await getWeatherSummary(s));
});

app.get("/api/sync", async (req, res) => {
    const s = getStation(req);
    if (req.query.buffer === 'true') return res.json(await bufferOnlyUpdate(s));
    res.json(await syncWithEcowitt(s, req.query.write === 'true'));
});

app.get("/api/sync-all", async (req, res) => {
    const results = {};
    try {
        for (const stationId of ['kknagar', 'neelangarai']) {
            const s = STATIONS[stationId];
            if (req.query.buffer === 'true') {
                results[stationId] = await bufferOnlyUpdate(s);
            } else if (req.query.write === 'true') {
                results[stationId] = await syncWithEcowitt(s, true);
            }
        }
        res.json({ status: 'ok', timestamp: new Date().toISOString(), results });
    } catch (err) {
        console.error('Sync-all error:', err);
        res.status(500).json({ error: err.message });
    }
});


app.get("/api/history_graphs", async (req, res) => {
    const s = getStation(req);
    const todayISTStr = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })).toLocaleDateString('en-CA');
    try {
        const historyRes = await pool.query(`
            SELECT * FROM weather_history
            WHERE station_id = $1
              AND (time AT TIME ZONE 'Asia/Kolkata')::date = $2::date
            ORDER BY time ASC
        `, [s.id, todayISTStr]);
        const history = historyRes.rows.map(r => ({
            time: r.time,
            temp: parseFloat(((r.temp_f - 32) * 5/9).toFixed(1)),
            hum:  r.humidity,
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
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="apple-mobile-web-app-title" content="KK Nagar Weather">
    <meta name="theme-color" content="#090d16">
    <link rel="icon" type="image/png" href="/icon-192.png">
    <link rel="apple-touch-icon" href="/icon-180.png">
    <link rel="manifest" href="/manifest.json">

    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <title>KK Nagar Weather Station</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
    <style>
    /* ☁️ E-INK LIGHT MODE (Anti-Glare / Matte)    */
    /* ========================================== */
    :root { 
        --bg: #e2e8f0 !important;        /* Slate 200: A true matte gray canvas, kills backlight glare */
        --card: #f8fafc;                 /* Slate 50: An off-white card face, removes the "flashlight" effect */
        --border: #cbd5e1;               /* Slate 300: Slightly deeper border to firmly ground the cards */
        --text: #1e293b !important;      /* Deep, muted charcoal (softer than before) */
        --muted: #64748b;                /* Mid-gray for secondary text */
        
        /* Muting the accents to stop them from looking "neon" */
        --accent: #0369a1;               /* A deeper, calmer ocean blue instead of bright royal blue */
        --lbl-color: #475569;            /* Soft slate for headings */
        --glow: 0 4px 15px -3px rgba(15, 23, 42, 0.08); /* Deeper, softer shadow to anchor the UI */
        --line: #e2e8f0;                 /* Inner dividers match the background */
    }
    /* ========================================== */
    /* 🌙 PREMIUM DARK MODE (OLED Obsidian)       */
    /* ========================================== */
    body.is-night {
        --bg: #090d16 !important;        /* Deep space midnight backing (not flat pitch black) */
        --card: #111827;                 /* Premium dark obsidian card blocks */
        --border: #1f2937;               /* Sleek metallic perimeter border */
        --text: #f8fafc !important;      /* Soft off-white cloud text to prevent neon glowing/bleeding */
        --muted: #94a3b8;                /* Soft metallic gray for secondary metrics */
        --accent: #38bdf8;               /* Radiant sky blue accents for premium highlight tracking */
        --lbl-color: #60a5fa;            /* Perfectly balanced luminous light blue for high title visibility */
        --glow: 0 20px 40px -15px rgba(0, 0, 0, 0.5); /* Heavy deep canvas room shadow */
        --line: #1f2937;                 /* Laser-etched internal dividers */
    }

     
    body { 
    margin: 0; 
    font-family: 'Outfit', sans-serif; 
    background: var(--bg); 
    color: var(--text); 
    /* 👇 FIX: Tight side margins on mobile so elements stretch across the screen nicely */
    padding: 16px 10px 120px 10px; 
    transition: background 0.4s ease, color 0.4s ease; 
    min-height: 100vh; 
    overflow-x: hidden; 
    box-sizing: border-box;
    padding-top: calc(16px + env(safe-area-inset-top, 0px));
    padding-left: calc(10px + env(safe-area-inset-left, 0px));
    padding-right: calc(10px + env(safe-area-inset-right, 0px));
}

/* 👇 RESTORES ORIGINAL SPACING ON DESKTOP SCREENS */
@media screen and (min-width: 768px) {
    body { 
        padding: 24px 24px 120px 24px; 
    }
}

    *, *:before, *:after { box-sizing: inherit; }

    .container { width: 100%; max-width: 1340px; margin: 0 auto; }
    
    /* 🎯 #1: ENHANCED HEADER WITH GRADIENT */
    .header { margin-bottom: 28px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px; }
    
    .header h1 { 
        font-size: 28px; 
        font-weight: 900; 
        margin: 0; 
        letter-spacing: -1px;
        
        /* 🎨 NEW: Premium gradient text effect */
        background: linear-gradient(135deg, var(--text) 0%, var(--text) 100%);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
        transition: all 0.4s ease;
    }

    body.is-night .header h1 {
        text-shadow: 0 2px 12px rgba(56, 189, 248, 0.15);
    }
    
    .header-actions { display: flex; align-items: center; gap: 12px; }
    
    .theme-toggle { background: var(--card); border: 1px solid var(--border); padding: 4px; border-radius: 14px; display: flex; gap: 4px; box-shadow: var(--glow); cursor: pointer; backdrop-filter: blur(20px); }
    .theme-btn { padding: 5px 12px; border-radius: 10px; font-size: 11px; font-weight: 700; transition: 0.2s ease; color: var(--muted); }
    .theme-btn.active { background: var(--accent); color: white; }

    /* 🎯 #2: PREMIUM STATUS BAR WITH GLOW */
    .status-bar { 
        display: flex; 
        align-items: center; 
        gap: 8px; 
        background: var(--card); 
        padding: 8px 16px; 
        border-radius: 100px; 
        
        /* 🎨 ENHANCED: Multi-layer shadow + glow */
        border: 1.5px solid var(--border);
        box-shadow: 
            0 4px 12px -2px rgba(3, 105, 161, 0.1),
            inset 0 1px 0 rgba(255, 255, 255, 0.5);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        
        font-size: 12px; 
        font-weight: 600; 
        letter-spacing: 0.3px;
        transition: all 0.3s ease;
    }

    body.is-night .status-bar {
        box-shadow: 
            0 4px 16px -2px rgba(0, 0, 0, 0.4),
            inset 0 1px 0 rgba(56, 189, 248, 0.1);
    }

    /* Hover lift effect */
    @media (hover: hover) {
        .status-bar:hover {
            transform: translateY(-2px);
            box-shadow: 
                0 8px 20px -4px rgba(3, 105, 161, 0.15),
                inset 0 1px 0 rgba(255, 255, 255, 0.6);
        }

        body.is-night .status-bar:hover {
            box-shadow: 
                0 8px 24px -4px rgba(56, 189, 248, 0.2),
                inset 0 1px 0 rgba(56, 189, 248, 0.15);
        }
    }
    
    .live-dot { width: 6px; height: 6px; background: #10b981; border-radius: 50%; animation: blink 2s infinite; box-shadow: 0 0 8px #10b981; }
    @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    

    .grid-system { 
        display: grid; 
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); 
        gap: 16px; 
        margin-bottom: 32px; 
        width: 100%;
    }
    
    @media screen and (min-width: 768px) {
        .grid-system { 
            /* !important forces the browser to kill any 4-column ghost styles */
            grid-template-columns: repeat(2, 1fr) !important; 
        }
    }
    @media (min-width: 1100px) {
        .grid-system { grid-template-columns: repeat(4, 1fr); }
    }

    /* 🎯 #3: COLORED TOP BORDERS ON CARDS */
    .card { 
        background: var(--card); 
        padding: 20px; 
        border-radius: 24px; 
        
        /* 🎨 ENHANCED: Colored top accent border */
        border: 1px solid var(--border); 
        border-top: 3px solid var(--accent);
        border-top-left-radius: 24px;
        border-top-right-radius: 24px;
        
        backdrop-filter: blur(30px); 
        -webkit-backdrop-filter: blur(30px); 
        box-shadow: var(--glow); 
        position: relative; 
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        gap: 24px;
        width: 100%;
        transition: all 0.35s cubic-bezier(0.22, 1, 0.36, 1);
    }

    /* Individual card color themes */
    .grid-system .card:nth-child(1) { 
        border-top-color: #ef4444; /* Temperature = Warm Red */
    }

    .grid-system .card:nth-child(2) { 
        border-top-color: #f97316; /* Wind = Orange */
    }

    .grid-system .card:nth-child(3) { 
        border-top-color: #3b82f6; /* Rain = Blue */
    }

    .grid-system .card:nth-child(4) { 
        border-top-color: #06b6d4; /* Atmospheric = Cyan */
    }
    
    #windCanvas { position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 0; pointer-events: none; border-radius: 24px; }
    .card > *:not(canvas) { position: relative; z-index: 5; }

    /* 🏷️ FIXED LABEL EYE STRAIN: Uses dedicated heading variables with tracked spacing */
    .label { 
        color: var(--lbl-color); 
        font-size: 11px; 
        font-weight: 800; 
        text-transform: uppercase; 
        letter-spacing: 1.5px; 
        margin-bottom: 14px; 
        transition: color 0.3s ease;
    }
    
    /* 🎯 #4 & #5: SMOOTH TRANSITIONS + MAIN VALUES WITH PREMIUM DEPTH */
    .main-val { 
        font-size: 52px; 
        font-weight: 800; 
        margin: 0; 
        
        /* 🎨 ENHANCED: Better letter spacing + depth */
        letter-spacing: -2px; 
        display: flex; 
        align-items: baseline; 
        line-height: 1; 
        font-variant-numeric: tabular-nums;
        
        /* Subtle text shadow for depth */
        text-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
        transition: all 0.4s ease;
    }

    body.is-night .main-val {
        text-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    }
    
    .unit { font-size: 18px; font-weight: 600; color: var(--muted); margin-left: 3px; }

    /* All numeric values animate smoothly */
    .main-val span,
    .cell-val,
    .pod-val,
    .limit-row-pod,
    #t, #w, #r_tot, #pr,
    #mx, #mn, #mw, #mg,
    #r_rate, #mr, #rf, #h_val, #d_val,
    #r_week, #r_month, #r_year,
    #sol, #uv {
        /* 🎨 SMOOTH: Transition animation on value changes */
        transition: all 0.35s cubic-bezier(0.22, 1, 0.36, 1);
        font-variant-numeric: tabular-nums; /* Prevents width jumping */
    }

    /* Special smooth transition for trend indicators */
    #tTrendBox {
        transition: all 0.4s cubic-bezier(0.22, 1, 0.36, 1);
    }

    /* EQUAL COMPACT GRID PANELS */
    .row-block { 
    display: grid; 
    /* This locks the layout mathematically: 52% left, 1px line, remaining space right. ZERO wobble. */
    grid-template-columns: 52% 1px 1fr; 
    align-items: center; 
    width: 100%; 
}

.left-panel { 
    display: flex; 
    flex-direction: column; 
    justify-content: center; 
    align-items: flex-start; 
    padding-right: 16px; /* Keeps text away from the line */
    box-sizing: border-box;
    min-width: 0; /* Prevents wide numbers from breaking the grid */
}

.right-panel { 
    display: flex; 
    flex-direction: column; 
    gap: 12px; 
    justify-content: center; 
    padding-left: 16px; /* Keeps text away from the line */
    align-items: flex-start; 
    box-sizing: border-box;
    min-width: 0;
}
    
   .v-line { 
    width: 1px; 
    height: 75px; 
    /* Silky smooth fade out at the top and bottom */
    background: linear-gradient(to bottom, transparent 0%, var(--line) 15%, var(--line) 85%, transparent 100%); 
    opacity: 0.5; /* Makes it look sleek and expensive */
    justify-self: center; /* Centers it perfectly in its 1px grid track */
}

    /* HIGH PROMINENCE COMPACT VALUE PODS (PROMINENCE BUMPED BY +0.5) */
    .limit-row-pod { display: flex; align-items: center; justify-content: flex-start; gap: 6px; width: 100%; font-size: 15px; font-weight: 700; line-height: 1; }
    .pod-lbl { font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.8px; opacity: 0.9; }
    .pod-val { font-variant-numeric: tabular-nums; }

    .mod-divider { 
    display: none;
}

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

    /* 🎯 BONUS: ENHANCED MODULAR CELLS */
    .modular-cell {
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        padding: 16px 8px;
        transition: all 0.3s cubic-bezier(0.22, 1, 0.36, 1);
        position: relative;
    }

    /* 🎨 LASER LIGHT DIVIDERS - NO BACKGROUND */
    .modular-cell {
        border-right: 1px solid transparent;
        background: transparent !important;
        box-shadow: none !important;
        position: relative;
    }

    /* Light mode: Subtle laser divider */
    .modular-cell::after {
        content: '';
        position: absolute;
        right: 0;
        top: 10%;
        bottom: 10%;
        width: 1px;
        background: linear-gradient(to bottom,
            transparent 0%,
            rgba(3, 105, 161, 0.3) 15%,
            rgba(3, 105, 161, 0.5) 50%,
            rgba(3, 105, 161, 0.3) 85%,
            transparent 100%);
        box-shadow: 0 0 8px rgba(3, 105, 161, 0.2);
    }

    body.is-night .modular-cell::after {
        background: linear-gradient(to bottom,
            transparent 0%,
            rgba(56, 189, 248, 0.4) 15%,
            rgba(56, 189, 248, 0.6) 50%,
            rgba(56, 189, 248, 0.4) 85%,
            transparent 100%);
        box-shadow: 0 0 12px rgba(56, 189, 248, 0.3);
    }

    .modular-cell:last-child::after {
        display: none; /* No divider on last cell */
    }

    /* Hover effect - subtle glow on divider */
    @media (hover: hover) {
        .modular-cell:hover::after {
            box-shadow: 0 0 16px rgba(3, 105, 161, 0.4);
        }

        body.is-night .modular-cell:hover::after {
            box-shadow: 0 0 20px rgba(56, 189, 248, 0.5);
        }
    }
    
    .cell-lbl { font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); font-weight: 700; margin-bottom: 4px; }
    .cell-val { font-size: 15px; font-weight: 700; color: var(--text); }

    .sub-pill { font-size: 11px; font-weight: 600; color: var(--text); display: inline-flex; align-items: center; gap: 4px; margin-top: 8px; }

    /* ADVANCED HIGH-PROMINENCE COMPASS HUD WITH HUD CARDINAL TEXTS */
    .compass-container { position: relative; width: 72px; height: 72px; margin: 0 auto; display: flex; align-items: center; justify-content: center; }
    .compass-ui { 
        width: 100%; height: 100%; 
        border: 1.5px solid var(--line); 
        border-radius: 50%; 
        position: absolute; top:0; left:0; 
        display: flex; align-items: center; justify-content: center;
        background: radial-gradient(circle, rgba(2,132,199,0.06) 0%, transparent 70%);
        box-shadow: inset 0 0 12px rgba(2,132,199,0.08);
    }
    
    .cardinal-pt { position: absolute; font-size: 9px; font-weight: 900; color: var(--muted); line-height: 1; }
    .pt-n { top: 2px; } .pt-s { bottom: 2px; } .pt-e { right: 4px; } .pt-w { left: 4px; }

    #needle { width: 3px; height: 46px; background: linear-gradient(to bottom, #ef4444 50%, var(--muted) 50%); clip-path: polygon(50% 0%, 100% 100%, 50% 85%, 0% 100%); transition: transform 2s cubic-bezier(0.1, 0.9, 0.2, 1); z-index: 2; }

    .time-mark { font-size: 9px; color: var(--muted); font-weight: 500; display: inline-block; margin-left: 4px; opacity: 0.75; }
    
    .nav-tabs { display: flex; gap: 8px; margin-bottom: 24px; }
    
    /* 🎯 BONUS: TAB BUTTON ENHANCEMENTS */
    .tab-btn {
        background: var(--card);
        border: 1px solid var(--border);
        padding: 12px 24px;
        border-radius: 14px;
        color: var(--text);
        font-weight: 700;
        cursor: pointer;
        transition: all 0.25s cubic-bezier(0.22, 1, 0.36, 1);
        backdrop-filter: blur(20px);
        font-size: 13px;
        letter-spacing: 0.2px;
    }

    .tab-btn.active {
        background: var(--accent);
        color: white;
        border-color: var(--accent);
        box-shadow: 
            0 4px 12px -2px rgba(3, 105, 161, 0.3),
            inset 0 1px 0 rgba(255, 255, 255, 0.2);
        transform: translateY(-2px);
    }

    body.is-night .tab-btn.active {
        box-shadow:
            0 4px 16px -2px rgba(56, 189, 248, 0.4),
            inset 0 1px 0 rgba(56, 189, 248, 0.3);
    }

    @media (hover: hover) {
        .tab-btn:hover:not(.active) {
            background: var(--card);
            border-color: var(--accent);
            box-shadow: 0 4px 8px -2px rgba(3, 105, 161, 0.1);
        }
    }

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

    @keyframes countUp {
        from { transform: translateY(8px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
    }
    .num-flip {
        display: inline-block;
        animation: countUp 0.4s cubic-bezier(0.22, 1, 0.36, 1);
    }

    @media screen and (max-width: 767px) {
    body {
        background: var(--card) !important; 
        padding: calc(24px + env(safe-area-inset-top, 0px)) 16px 120px 16px;
    }

    .card {
        background: transparent !important; 
        border: none !important;            
        box-shadow: none !important;        
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
        padding: 20px 4px !important;       
        border-radius: 0 !important;
        position: relative; /* Setup anchor for the premium custom line */
        border-top: none; /* Remove colored top border on mobile */
    }

    /* 👇 THE AURORA SEPARATOR: Fades out completely at both ends */
    .card::after {
        content: '';
        position: absolute;
        bottom: 0;
        left: 0;
        width: 100%;
        height: 1px;
        background: linear-gradient(to right, 
            transparent 0%, 
            var(--border) 20%, 
            var(--accent) 50%, 
            var(--border) 80%, 
            transparent 100%
        );
        opacity: 0.4; /* Soft, non-intrusive elegance */
    }

    .card:last-of-type::after {
        display: none; /* Keeps the final block clean */
    }

    .pro-summary-table {
        border: none !important;
        box-shadow: none !important;
        background: transparent !important;
    }

    .status-bar {
        box-shadow: none;
        border: 1px solid var(--border);
    }
}

/* ======================================================= */
/* 💻 DESKTOP: 2x2 GRID WITH INDIVIDUAL CARD BORDERS      */
/* ======================================================= */
@media screen and (min-width: 768px) {
    /* Keep cards separate with proper spacing */
    .grid-system {
        display: grid;
        grid-template-columns: repeat(2, 1fr) !important;
        gap: 16px;
        margin-bottom: 32px;
        width: 100%;
    }

    /* Restore individual card styling */
    .grid-system .card {
        background: var(--card) !important;
        border: 1px solid var(--border) !important;
        border-top: 3px solid var(--accent) !important;
        border-radius: 24px !important;
        box-shadow: var(--glow) !important;
        backdrop-filter: blur(30px) !important;
        -webkit-backdrop-filter: blur(30px) !important;
        padding: 28px !important;
        position: relative;
        transition: all 0.35s cubic-bezier(0.22, 1, 0.36, 1);
    }

    /* Hover elevation effect */
    @media (hover: hover) {
        .grid-system .card:hover {
            transform: translateY(-4px);
            box-shadow: 
                0 20px 25px -5px rgba(0, 0, 0, 0.15),
                var(--glow) !important;
        }
    }

    /* Individual card color themes */
    .grid-system .card:nth-child(1) { border-top-color: #ef4444; } /* Temperature = Red */
    .grid-system .card:nth-child(2) { border-top-color: #f97316; } /* Wind = Orange */
    .grid-system .card:nth-child(3) { border-top-color: #3b82f6; } /* Rain = Blue */
    .grid-system .card:nth-child(4) { border-top-color: #06b6d4; } /* Atmospheric = Cyan */
}


.header { flex-wrap: wrap; }
.station-picker { position: relative; min-width: 0; flex: 1 1 auto; }

.header-actions { flex-shrink: 0; }

.title-trigger {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: transparent;
    border: none;
    padding: 4px 0;
    margin: 0;
    cursor: pointer;
    font-family: inherit;
    text-align: left;
    max-width: 100%;
}
.title-trigger h1 {
    font-size: 21px;
    font-weight: 900;
    letter-spacing: -0.4px;
    margin: 0;
    color: var(--text);
}
.pin-toggle {
    flex-shrink: 0;
    width: 24px;
    height: 24px;
    border-radius: 8px;
    background: rgba(56,189,248,0.12);
    color: var(--accent);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    transition: transform 0.2s ease, background 0.2s ease;
}
.title-trigger.open .pin-toggle {
    background: var(--accent);
    transform: scale(0.92);
}



.station-menu {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    min-width: 220px;
    max-width: min(280px, calc(100vw - 32px));
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 16px;
    box-shadow: 0 14px 32px -8px rgba(15,23,42,0.2), var(--glow);
    overflow: hidden;
    z-index: 100;
    opacity: 0;
    transform: translateY(-6px) scale(0.98);
    pointer-events: none;
    transition: all 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}
.station-menu.open { opacity: 1; transform: translateY(0) scale(1); pointer-events: auto; }

.menu-eyebrow {
    font-size: 10px; font-weight: 800; letter-spacing: 1px; text-transform: uppercase;
    color: var(--muted); padding: 12px 14px 6px;
}

.station-menu-item {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 14px; font-size: 14px; font-weight: 700; color: var(--text);
    cursor: pointer; border-top: 1px solid var(--border);
}
.station-menu-item .pin { font-size: 13px; opacity: 0.7; }
.station-menu-item .check {
    margin-left: auto; width: 16px; height: 16px; border-radius: 50%;
    background: var(--accent); color: #fff; font-size: 10px;
    display: none; align-items: center; justify-content: center;
}
.station-menu-item.active { color: var(--accent); background: rgba(3, 105, 161, 0.07); }
.station-menu-item.active .check { display: flex; }
.station-menu-item:active { background: rgba(3, 105, 161, 0.12); }

@media screen and (max-width: 400px) {
    .header h1 { font-size: 19px; }
}

/* 🌧️ RAINFALL GLOW & PULSE ANIMATIONS */

@keyframes rain-pulse-glow {
    0% { 
        text-shadow: 0 2px 8px rgba(6, 182, 212, 0.3);
        transform: scale(1);
    }
    50% { 
        text-shadow: 0 0 20px rgba(6, 182, 212, 0.8), 0 0 30px rgba(6, 182, 212, 0.4);
        transform: scale(1.02);
    }
    100% { 
        text-shadow: 0 2px 8px rgba(6, 182, 212, 0.3);
        transform: scale(1);
    }
}

@keyframes current-rr-glow {
    0% { 
        text-shadow: 0 2px 8px rgba(6, 182, 212, 0.4);
        color: #06b6d4;
    }
    50% { 
        text-shadow: 0 0 16px rgba(6, 182, 212, 0.9), 0 0 24px rgba(6, 182, 212, 0.5);
        color: #22d3ee;
    }
    100% { 
        text-shadow: 0 2px 8px rgba(6, 182, 212, 0.4);
        color: #06b6d4;
    }
}

@keyframes max-rr-glow {
    0% { 
        text-shadow: 0 2px 8px rgba(125, 58, 237, 0.4);
        color: #1d4ed8;
    }
    50% { 
        text-shadow: 0 0 16px rgba(168, 85, 247, 0.9), 0 0 24px rgba(168, 85, 247, 0.5);
        color: #a78bfa;
    }
    100% { 
        text-shadow: 0 2px 8px rgba(125, 58, 237, 0.4);
        color: #1d4ed8;
    }
}


</style>
</head>
<body>
    <div class="container">
    <div class="header">
        <div class="station-picker" id="stationPicker">
         <button class="title-trigger" id="titleTrigger" onclick="toggleStationMenu()">
    <h1 id="station-title">KK Nagar Weather Station</h1>
    <span class="pin-toggle">📍</span>
</button>


            <div class="station-menu" id="stationMenu">
                <div class="menu-eyebrow">Switch station</div>
                <div class="station-menu-item active" id="opt-kknagar" onclick="switchStation('kknagar')">
                    <span class="pin">📍</span><span>KK Nagar</span><span class="check">✓</span>
                </div>
                <div class="station-menu-item" id="opt-neelangarai" onclick="switchStation('neelangarai')">
                    <span class="pin">📍</span><span>Neelangarai</span><span class="check">✓</span>
                </div>
            </div>
        </div>

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
                            <div class="right-panel" style="gap:10px;">
    <div style="display:flex; flex-direction:column; gap:1px;">
        <div style="display:flex; align-items:center; gap:5px;">
            <div style="width:6px; height:6px; border-radius:50%; background:#ef4444; flex-shrink:0;"></div>
            <span style="font-size:9px; font-weight:900; letter-spacing:1.5px; color:#ef4444;">MAX</span>
        </div>
        <span id="mx" style="font-size:22px; font-weight:800; color:#ef4444; line-height:1.1; font-variant-numeric:tabular-nums;">--</span>
    </div>
    <div style="height:1px; width:100%; background:var(--line);"></div>
    <div style="display:flex; flex-direction:column; gap:1px;">
        <div style="display:flex; align-items:center; gap:5px;">
            <div style="width:6px; height:6px; border-radius:50%; background:#0ea5e9; flex-shrink:0;"></div>
            <span style="font-size:9px; font-weight:900; letter-spacing:1.5px; color:#0ea5e9;">MIN</span>
        </div>
        <span id="mn" style="font-size:22px; font-weight:800; color:#0ea5e9; line-height:1.1; font-variant-numeric:tabular-nums;">--</span>
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
                                <div class="main-val"><span id="w">0.0</span><span class="unit">km/h</span><span id="wd_bracket" style="font-size:13px; font-weight:700; color:var(--muted); margin-left:8px; letter-spacing:0;">(--)</span></div>

                            <div class="sub-pill">Gusting to:<span id="wg">--</span></div>
                        </div>
                        
                        <div class="v-line"></div>
                        
                        <div class="right-panel" style="align-items: center; padding-left:0; flex: 0.9;">
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

                            <div class="right-panel" style="gap:0; width:100%;">
    <div style="display:flex; flex-direction:column; gap:2px; padding-bottom:10px; border-bottom:1px solid var(--line); width:100%;">
        <div style="display:flex; align-items:center; gap:5px;">
            <div style="width:6px; height:6px; border-radius:50%; background:#06b6d4; flex-shrink:0;"></div>
            <span style="font-size:12px; font-weight:900; letter-spacing:1.5px; color:#2563eb;">Current RR</span>
        </div>
        <div style="display:flex; align-items:baseline; gap:3px;">
            <span id="r_rate" style="font-size:28px; font-weight:800; color:#2563eb; line-height:1.1; font-variant-numeric:tabular-nums;">--</span>
            <span style="font-size:11px; font-weight:600; color:var(--muted);"></span>
        </div>
    </div>
    <div style="display:flex; flex-direction:column; gap:2px; padding-top:10px; width:100%;">
        <div style="display:flex; align-items:center; gap:5px;">
            <div style="width:6px; height:6px; border-radius:50%; background:#7c3aed; flex-shrink:0;"></div>
            <span style="font-size:12px; font-weight:900; letter-spacing:1.5px; color:#7c3aed;">Max RR</span>
        </div>
        <div style="display:flex; align-items:baseline; gap:3px;">
            <span id="mr" style="font-size:28px; font-weight:800; color:#7c3aed; line-height:1.1; font-variant-numeric:tabular-nums;">--</span>
            <span style="font-size:11px; font-weight:600; color:var(--muted);"></span>
        </div>
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
                <div class="main-val">
                    <span id="pr">--</span>
                    <span class="unit">hPa</span>
                    <span id="pIcon" style="font-size:16px; margin-left:8px; font-weight:800; line-height:1; align-self:center;"></span>
                </div>
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

</div> <!-- End of .grid-system -->


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
        let currentStation = localStorage.getItem('weatherStation') || 'kknagar';

function switchStation(id) {
    currentStation = id;
    localStorage.setItem('weatherStation', id);

    document.getElementById('opt-kknagar').classList.toggle('active', id === 'kknagar');
    document.getElementById('opt-neelangarai').classList.toggle('active', id === 'neelangarai');

    document.getElementById('station-title').textContent =
        id === 'kknagar' ? 'KK Nagar Weather Station' : 'Neelangarai Weather Station';

    closeStationMenu();
    graphDataLoaded = false;
    update();
}

function toggleStationMenu() {
    document.getElementById('stationMenu').classList.toggle('open');
    document.getElementById('titleTrigger').classList.toggle('open');
}

function closeStationMenu() {
    document.getElementById('stationMenu').classList.remove('open');
    document.getElementById('titleTrigger').classList.remove('open');
}

document.addEventListener('click', function(e) {
    const picker = document.getElementById('stationPicker');
    if (picker && !picker.contains(e.target)) closeStationMenu();
});



// Apply saved station on load

        let charts = {};
        let liveWindSpeed = 0, liveWindDeg = 0, particles = [];
        let graphDataLoaded = false;

        switchStation(currentStation);
        
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

            document.querySelectorAll('#themeToggle .theme-btn').forEach(btn => btn.classList.remove('active'));
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
        obj.style.transition = 'none';
        obj.style.opacity = "0";
        obj.style.transform = "translateY(6px)";
        
        setTimeout(() => {
            obj.innerHTML = '<span class="num-flip">' + formattedValue + '</span>';
            obj.style.transition = 'opacity 0.3s ease, transform 0.3s cubic-bezier(0.22, 1, 0.36, 1)';
            obj.style.opacity = "1";
            obj.style.transform = "translateY(0)";
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
                const res = await fetch('/api/history_graphs?station=' + currentStation);
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
                const res = await fetch('/weather?station=' + currentStation + '&v=' + Date.now()); 
                const d = await res.json(); 
                if (!d || d.error) return;

                updateValueWithFade('t', d.temp.current, 1);
                updateValueWithFade('w', d.wind.speed, 1);
                updateValueWithFade('r_tot', d.rain.total, 1);
                document.getElementById('r_rate').innerHTML = d.rain.rate.toFixed(1) + '<span style="font-size:11px; font-weight:600; color:var(--muted); margin-left:3px;">mm/h</span>';
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
                document.getElementById('mr').innerHTML = d.rain.maxR > 0 
    ? d.rain.maxR.toFixed(1) + '<span style="font-size:11px; font-weight:600; color:var(--muted); margin-left:3px;">mm/h</span> <span style="font-size:9px; color:var(--muted); font-weight:500; opacity:0.75;">' + d.rain.maxRTime + '</span>' 
    : '0<span style="font-size:11px; font-weight:600; color:var(--muted); margin-left:3px;">mm/h</span>';


                const pTrend = d.atmo.pTrend;
                if (pTrend >= 0.1) document.getElementById('pIcon').innerHTML = '<span style="color:#ef4444; font-size:14px;">▲</span>';
                else if (pTrend <= -0.1) document.getElementById('pIcon').innerHTML = '<span style="color:#0ea5e9; font-size:14px;">▼</span>';
                else document.getElementById('pIcon').innerHTML = '<span style="color:var(--muted); font-size:12px;">●</span>';

                
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

                updateRainGlow();  // 🌧️ Activate glow animation

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

        applyTheme(); animateWind(); setInterval(update, 30000);

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
        const res = await fetch('/api/summary?station=' + currentStation);
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
        var response = await fetch('/api/historical-rain?year=' + year + '&station=' + currentStation);
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

// 🌧️ SMART RAINFALL GLOW - Only shows when it's raining!
function updateRainGlow() {
    const rainTotal = parseFloat(document.getElementById('r_tot').textContent);
    const currentRR = parseFloat(document.getElementById('r_rate').textContent);
    const maxRR = parseFloat(document.getElementById('mr').textContent);

    const rainTotElem = document.getElementById('r_tot');
    const currentRRElem = document.getElementById('r_rate');
    const maxRRElem = document.getElementById('mr');

    // Main rain value: glow only if > 0
    if (rainTotal === 0 || rainTotal === null || isNaN(rainTotal)) {
        rainTotElem.style.animation = 'none';
        rainTotElem.style.textShadow = 'none';
    } else {
        rainTotElem.style.animation = 'rain-pulse-glow 2.5s ease-in-out infinite';
    }

    // Current RR: glow only if > 0.1
    if (currentRR === 0 || currentRR < 0.1 || isNaN(currentRR)) {
        currentRRElem.style.animation = 'none';
        currentRRElem.style.textShadow = 'none';
    } else {
        currentRRElem.style.animation = 'current-rr-glow 2s ease-in-out infinite';
    }

    // Max RR: glow only if > 0.1
    if (maxRR === 0 || maxRR < 0.1 || isNaN(maxRR)) {
        maxRRElem.style.animation = 'none';
        maxRRElem.style.textShadow = 'none';
    } else {
        maxRRElem.style.animation = 'max-rr-glow 2s ease-in-out infinite';
    }
}

// Auto-check every 30 seconds
setInterval(updateRainGlow, 30000);


</script>
</body>
</html>
    `);
});

if (process.env.NODE_ENV !== 'production') {
    app.listen(3000, () => console.log(`Running at http://localhost:3000`));
}

module.exports = app;
