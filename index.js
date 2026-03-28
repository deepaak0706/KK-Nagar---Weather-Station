const express = require("express");
const app = express();

let latestData = { 
    status: "No data received from WS2900 yet", 
    timestamp: new Date().toISOString()
};

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Homepage
app.get("/", (req, res) => {
    res.send(`
        <h1>KK Nagar Weather Station (WS2900)</h1>
        <p>Auto-refreshes every 5s • Last: ${latestData.timestamp}</p>
        <pre id="data" style="background:#f8f9fa; padding:20px; border-radius:8px; white-space:pre-wrap;">
Loading...
        </pre>
        <script>
            async function loadData() {
                const res = await fetch('/weather');
                const data = await res.json();
                document.getElementById('data').innerText = JSON.stringify(data, null, 2);
            }
            setInterval(loadData, 5000);
            loadData();
        </script>
    `);
});

app.get("/weather", (req, res) => res.json(latestData));

// Catch common paths for both Ecowitt and Wunderground
app.all(["/data/report*", "/", "/report*", "/weatherstation/updateweatherstation.php*"], (req, res) => {
    const now = new Date().toISOString();
    console.log("===== WS2900 DATA RECEIVED =====");
    console.log("Time:", now);
    console.log("Method:", req.method);
    console.log("URL:", req.originalUrl);
    console.log("Query:", req.query);
    console.log("Body:", req.body);

    let dataToStore = {
        timestamp: now,
        source: "WS2900",
        method: req.method,
        protocol: req.protocol
    };

    if (Object.keys(req.query).length > 0) {
        dataToStore = { ...dataToStore, ...req.query };
        console.log("✅ Stored from Query");
    } else if (req.body && Object.keys(req.body).length > 0) {
        dataToStore = { ...dataToStore, ...req.body };
        console.log("✅ Stored from Body");
    }

    latestData = dataToStore;
    console.log("Stored keys:", Object.keys(dataToStore));
    console.log("=====================================");

    res.send("OK");   // or "success" for some protocols
});

app.all("*", (req, res) => {
    if (!req.url.includes("icon") && !req.url.includes("favicon")) {
        console.log("Unknown:", req.method, req.originalUrl);
    }
    res.send("OK");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
