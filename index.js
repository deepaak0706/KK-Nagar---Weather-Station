const express = require("express");
const app = express();

let latestData = { 
    status: "No data received from WS2900 yet", 
    timestamp: new Date().toISOString(),
    note: "Waiting for station upload..."
};

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ====================== HOMEPAGE ======================
app.get("/", (req, res) => {
    res.send(`
        <h1>KK Nagar Weather Station (WS2900)</h1>
        <p style="color: #666;">Auto-refreshes every 5 seconds • Last update: ${latestData.timestamp}</p>
        <pre id="data" style="background:#f8f9fa; padding:20px; border-radius:8px; font-family: monospace; white-space: pre-wrap; overflow:auto;">
            Loading latest weather data...
        </pre>

        <script>
            async function loadData() {
                try {
                    const res = await fetch('/weather');
                    const data = await res.json();
                    document.getElementById('data').innerText = JSON.stringify(data, null, 2);
                } catch(e) {
                    document.getElementById('data').innerText = "Error loading data. Check server logs.";
                }
            }
            setInterval(loadData, 5000);
            loadData();
        </script>
    `);
});

// ====================== WEATHER DATA API ======================
app.get("/weather", (req, res) => {
    res.json(latestData);
});

// ====================== WS2900 / ECOWITT MAIN ROUTE ======================
// This catches common paths used by WS2900 and EasyWeatherPro
app.all(["/data/report*", "/", "/report*", "/data/report"], (req, res) => {
    const now = new Date().toISOString();
    
    console.log("===== WS2900 DATA RECEIVED =====");
    console.log("Time:", now);
    console.log("Method:", req.method);
    console.log("URL:", req.originalUrl);
    console.log("Protocol:", req.protocol);
    console.log("Query Params:", req.query);
    console.log("Body:", req.body);

    let dataToStore = {
        timestamp: now,
        source: "WS2900",
        protocol: req.protocol,
        method: req.method
    };

    // Data usually comes as query parameters (GET)
    if (Object.keys(req.query).length > 0) {
        dataToStore = { ...dataToStore, ...req.query };
        console.log("✅ Successfully stored data from Query Parameters");
    } 
    // Sometimes comes as form-urlencoded POST
    else if (req.body && Object.keys(req.body).length > 0) {
        dataToStore = { ...dataToStore, ...req.body };
        console.log("✅ Successfully stored data from POST Body");
    } 
    else {
        console.log("⚠️ Received empty payload (no query or body data)");
    }

    latestData = dataToStore;
    console.log("Final stored data keys:", Object.keys(dataToStore));
    console.log("=====================================");

    res.send("OK");   // Simple response expected by most weather consoles
});

// Catch other requests (ignore favicon/apple icons)
app.all("*", (req, res) => {
    if (!req.url.includes("apple-touch") && !req.url.includes("favicon") && !req.url.includes("icon")) {
        console.log("Unknown request:", req.method, req.originalUrl);
    }
    res.send("OK");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Server is running on port ${PORT}`);
    console.log(`🌐 Visit: https://kk-nagar-weather-station.onrender.com`);
    console.log(`Waiting for WS2900 to send data...`);
});
