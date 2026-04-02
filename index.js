const express = require("express");
const fetch = require("node-fetch");
const app = express();

const APPLICATION_KEY = process.env.APPLICATION_KEY;
const API_KEY = process.env.API_KEY;
const MAC = process.env.MAC;

let cachedData = null;
let lastFetch = 0;
let todayHistory = [];
let todayMaxRainRate = 0;
let todayMaxWindSpeed = 0;
let todayMaxWindGust = 0;
let currentDate = new Date().toDateString();
let lastTemp = null;
let lastTempTime = null;

app.get("/weather", async (req, res) => {
    const now = Date.now();
    const todayStr = new Date().toDateString();

    if (todayStr !== currentDate) {
        todayHistory = [];
        todayMaxRainRate = 0;
        todayMaxWindSpeed = 0;
        todayMaxWindGust = 0;
        currentDate = todayStr;
    }

    if (cachedData && (now - lastFetch < 30000)) {
        return res.json(cachedData);
    }

    try {
        const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Ecowitt API error: ${response.status}`);

        const ecowitt = await response.json();
        if (ecowitt.code !== 0) throw new Error(ecowitt.msg || "API error");
        const d = ecowitt.data;

        const tempC = ((parseFloat(d.outdoor.temperature.value) - 32) * 5 / 9).toFixed(1);
        const feelsLikeC = ((parseFloat(d.outdoor.feels_like.value) - 32) * 5 / 9).toFixed(1);
        const dewPointC = ((parseFloat(d.outdoor.dew_point.value) - 32) * 5 / 9).toFixed(1);
        const rainRateMmHr = (parseFloat(d.rainfall.rain_rate.value) * 25.4).toFixed(1);
        const totalRainMm = (parseFloat(d.rainfall.daily.value) * 25.4).toFixed(1);
        const windSpeedKmh = (parseFloat(d.wind.wind_speed.value) * 1.60934).toFixed(1);
        const windGustKmh = (parseFloat(d.wind.wind_gust.value) * 1.60934).toFixed(1);

        let tempChangeRate = 0;
        if (todayHistory.length >= 2) {
            const oneHourAgo = Date.now() - (60 * 60 * 1000);
            const recentData = todayHistory.filter(h => new Date(h.time) > oneHourAgo);
            if (recentData.length >= 2) {
                const oldest = recentData[0];
                const newest = recentData[recentData.length - 1];
                const timeDiffHours = (new Date(newest.time) - new Date(oldest.time)) / (1000 * 3600);
                if (timeDiffHours > 0) {
                    tempChangeRate = ((newest.temp - oldest.temp) / timeDiffHours).toFixed(1);
                }
            }
        }

        lastTemp = parseFloat(tempC);
        lastTempTime = Date.now();

        const currentRainRate = parseFloat(rainRateMmHr);
        if (currentRainRate > todayMaxRainRate) todayMaxRainRate = currentRainRate;
        const currentWindSpeed = parseFloat(windSpeedKmh);
        const currentWindGust = parseFloat(windGustKmh);
        if (currentWindSpeed > todayMaxWindSpeed) todayMaxWindSpeed = currentWindSpeed;
        if (currentWindGust > todayMaxWindGust) todayMaxWindGust = currentWindGust;

        todayHistory.push({
            time: new Date().toISOString(),
            temp: parseFloat(tempC),
            hum: parseFloat(d.outdoor.humidity.value),
            rainRate: currentRainRate,
            totalRain: parseFloat(totalRainMm),
            windSpeed: currentWindSpeed,
            windGust: currentWindGust,
            windDir: parseFloat(d.wind.wind_direction.value)
        });

        if (todayHistory.length > 1440) todayHistory.shift();

        cachedData = {
            outdoor: {
                temp: tempC,
                feelsLike: feelsLikeC,
                humidity: parseFloat(d.outdoor.humidity.value),
                dewPoint: dewPointC,
                tempChangeRate: parseFloat(tempChangeRate),
                maxTemp: Math.max(...todayHistory.map(h=>h.temp)).toFixed(1),
                minTemp: Math.min(...todayHistory.map(h=>h.temp)).toFixed(1)
            },
            rainfall: {
                rainRate: rainRateMmHr,
                totalRain: totalRainMm,
                maxRainRate: todayMaxRainRate.toFixed(1)
            },
            wind: {
                speed: windSpeedKmh,
                gust: windGustKmh,
                maxSpeed: todayMaxWindSpeed.toFixed(1),
                maxGust: todayMaxWindGust.toFixed(1),
                direction: d.wind.wind_direction.value
            },
            solar_uv: {
                solar: d.solar_and_uvi.solar.value,
                uvi: d.solar_and_uvi.uvi.value
            },
            pressure: (parseFloat(d.pressure.relative.value) * 33.8639).toFixed(1),
            history: todayHistory
        };

        lastFetch = now;
        res.json(cachedData);

    } catch (error) {
        console.error("Ecowitt API Error:", error.message);
        if (cachedData) return res.json(cachedData);
        res.status(500).json({ error: "Failed to fetch data from Ecowitt" });
    }
});

app.get("/", (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>KK Nagar Weather Station</title>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<style>
    body { 
        margin:0; 
        font-family:'Outfit', system-ui, sans-serif; 
        background: radial-gradient(circle at top right, #1e293b, #020617); 
        color:#e2e8f0; 
        min-height:100vh; 
    }
    .header-container {
        padding: 30px 15px 20px;
        text-align: center;
        background: linear-gradient(180deg, rgba(2,6,23,0.9) 0%, rgba(2,6,23,0) 100%);
    }
    h1 { 
        font-size: 36px; 
        margin:0 0 10px 0; 
        font-weight: 800;
        letter-spacing: -1px; 
        background: linear-gradient(90deg, #38bdf8, #818cf8, #c084fc);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
    }
    .status { 
        display: inline-block;
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 20px;
        font-size: 13px; 
        padding: 6px 16px; 
        font-weight: 400;
        letter-spacing: 0.5px; 
    }
    .container { max-width:1100px; margin:0 auto; padding:20px; }
    
    .card { 
        background: linear-gradient(145deg, rgba(30,41,59,0.6), rgba(15,23,42,0.8));
        backdrop-filter: blur(16px); 
        -webkit-backdrop-filter: blur(16px);
        border: 1px solid rgba(255,255,255,0.08);
        border-top: 1px solid rgba(255,255,255,0.15);
        border-radius: 24px; 
        padding: 30px; 
        margin-bottom: 24px; 
        box-shadow: 0 20px 40px rgba(0,0,0,0.4); 
    }
    
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:25px; }
    .item { 
        text-align:center; 
        display: flex;
        flex-direction: column;
        justify-content: center;
        padding: 15px;
        background: rgba(0,0,0,0.15);
        border-radius: 16px;
    }
    
    .label { 
        font-size: 12px; 
        color: #94a3b8; 
        margin-bottom: 8px; 
        font-weight: 600; 
        letter-spacing: 1.5px; 
        text-transform: uppercase;
    }
    .value { 
        font-size: 34px; 
        font-weight: 800; 
        letter-spacing: -1px; 
        color: #ffffff;
        text-shadow: 0 0 20px rgba(255,255,255,0.1);
    }
    .small { 
        font-size: 13px; 
        font-weight: 400; 
        color: #cbd5e1;
        margin-top: 6px;
    }
    
    .chart-container {
        padding: 10px;
        margin-bottom: 10px;
    }
    .chart-title {
        text-align: center;
        font-size: 18px;
        font-weight: 600;
        margin: 0 0 25px 0;
        color: #e2e8f0;
    }

    /* Value Specific Colors */
    .val-temp { color: #38bdf8;
