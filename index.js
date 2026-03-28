const express = require("express");
const app = express();

let latestData = { status: "No data received yet", timestamp: new Date().toISOString() };

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ====================== HOMEPAGE ======================
app.get("/", (req, res) => {
    res.send(`
        <h1>KK Nagar Weather Station (WS2900)</h1>
        <p>Refresh this page to see latest data. Auto-refreshes every 5 seconds.</p>
        <pre id="data" style="background:#f4f4f4; padding:15px; border-radius:8px; overflow:auto;">
            Loading...
        </pre>

        <script>
            async function loadData() {
                try {
                    const res = await fetch('/weather');
                    const data = await res.json();
                    document.getElementById('data').innerText = JSON.stringify(data, null, 2);
                } catch(e) {
                    document.getElementById('data').innerText = "Error loading data";
                }
            }
            setInterval(loadData, 5000);
            loadData();
        </script>
    `);
});

// ====================== WEATHER API ======================
app.get("/weather", (req, res) => {
    res.json(latestData);
});

// ====================== MAIN ROUTE FOR WS2900 ======================
// Catches /data/report, /data/report/, /, /report, etc.
app.all(["/data/report*", "/", "/report*"], (req, res) => {
    console.log("===== WS2900 DATA RECEIVED =====");
    console.log("Time:", new Date().toISOString());
    console.log("Method:", req.method);
    console.log("Full URL:", req.protocol + "://" + req.get("host") + req.originalUrl);
    console.log("Query Params:", req.query);
    console.log("Body:", req.body);

    let receivedData = {
        timestamp: new Date().toISOString(),
        source: "WS2900_Ecowitt"
    };

    // Most common: data comes as query parameters
    if (Object.keys(req.query).length > 0) {
        receivedData = { ...receivedData, ...req.query };
        console.log("✅ Data stored from Query Parameters");
    } 
    // Sometimes comes as form data (POST)
    else if (req.body && Object.keys(req.body).length > 0) {
        receivedData = { ...receivedData, ...req.body };
        console.log("✅ Data stored from POST Body");
    } 
    else {
        console.log("⚠️ No query or body data found");
    }

    latestData = receivedData;
    console.log("Final Stored Data:", latestData);

    // Many weather stations expect simple "OK" response
    res.send("OK");
});

// Catch any other requests
app.all("*", (req, res) => {
    console.log("Unknown request:", req.method, req.originalUrl);
    res.send("OK");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Visit: https://kk-nagar-weather-station.onrender.com`);
});
