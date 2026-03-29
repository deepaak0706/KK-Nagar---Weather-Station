const express = require("express");
const fetch = require("node-fetch");

const app = express();

// 🔑 Your API details
const API_KEY = "ec7a03ba77b341dcba03ba77b3a1dcfc";
const STATION_ID = "ICHENN63";

// Homepage
app.get("/", async (req, res) => {
    try {
        const response = await fetch(
            `https://api.weather.com/v2/pws/observations/current?stationId=${STATION_ID}&format=json&units=m&apiKey=${API_KEY}`
        );

        const data = await response.json();
        const obs = data.observations[0];

        res.send(`
            <h1>KK Nagar Weather Station</h1>
            <ul>
                <li>Temperature: ${obs.metric.temp} °C</li>
                <li>Humidity: ${obs.humidity} %</li>
                <li>Wind Speed: ${obs.metric.windSpeed} km/h</li>
                <li>Wind Gust: ${obs.metric.windGust} km/h</li>
                <li>Pressure: ${obs.metric.pressure} hPa</li>
                <li>Rain Rate: ${obs.metric.precipRate} mm/hr</li>
                <li>Total Rain: ${obs.metric.precipTotal} mm</li>
                <li>UV Index: ${obs.uv}</li>
                <li>Solar Radiation: ${obs.solarRadiation}</li>
            </ul>
        `);
    } catch (err) {
        console.error(err);
        res.send("Error fetching weather data");
    }
});

app.listen(3000, () => console.log("Server running"));
