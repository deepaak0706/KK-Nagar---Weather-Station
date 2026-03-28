const express = require("express");
const app = express();

let latestData = { 
    status: "No data received from WS2900 yet. Waiting for upload...", 
    timestamp: new Date().toISOString()
};

// Middleware to parse both JSON and form data
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Homepage - clean display
app.get("/", (req, res) => {
    res.send(`
        <h1>KK Nagar Weather Station (WS2900)</h1>
        <p>Auto-refreshes every 5 seconds • Last update: ${latestData.timestamp || 'Never'}</p>
        <pre id="data" style="background:#f8f9fa; padding:20px; border:1px solid #ddd; border-radius:8px; font-family:monospace; white-space:pre-wrap; min-height:300px;">
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

app.get("/weather", (req, res) => {
    res.json(latestData);
});

// Main route - catches everything the WS2900 might send
app.all(["/data/report*", "/", "/report*", "/data/report"], (req, res) => {
    const now = new Date().toISOString();
    
    console.log("===== WS2900 DATA RECEIVED =====");
    console.log("Time:", now);
    console.log("Method:", req.method);
    console.log("URL:", req.originalUrl);
    console.log("Protocol:", req.protocol);
    console.log("Query:", JSON.stringify(req.query));
    console.log("Body:", JSON.stringify(req.body));

    let dataToStore = {
        timestamp: now,
        source: "WS2900",
        method: req.method,
        protocol: req.protocol
    };

    if (Object.keys(req.query).length > 0) {
        dataToStore = { ...dataToStore, ...req.query };
        console.log("✅ Stored from Query Parameters");
    } else if (req.body && Object.keys(req.body).length > 0) {
        dataToStore = { ...dataToStore, ...req.body };
        console.log("✅ Stored from POST Body");
    } else {
        console.log("⚠️ Empty data received");
    }

    latestData = dataToStore;
    console.log("Stored keys:", Object.keys(dataToStore));
    console.log("=====================================");

    res.send("OK");
});

// Ignore browser icon requests
app.all("*", (req, res) => {
    if (!req.url.includes("apple") && !req.url.includes("favicon") && !req.url.includes("icon")) {
        console.log("Unknown request:", req.method, req.originalUrl);
    }
    res.send("OK");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`🌐 Open: https://kk-nagar-weather-station.onrender.com`);
});
