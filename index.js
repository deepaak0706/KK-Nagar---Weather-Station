const express = require("express");
const app = express();

// Store the latest data
let latestData = {};

// Middleware to parse JSON and URL-encoded bodies
app.use(express.json());                // for JSON POSTs
app.use(express.urlencoded({ extended: true })); // for URL-encoded POSTs

// Homepage
app.get("/", (req, res) => {
    res.send(`
        <h1>KK Nagar Weather Station</h1>
        <pre id="data">Loading...</pre>
        <script>
            async function loadData() {
                const res = await fetch('/weather');
                const data = await res.json();
                document.getElementById('data').innerText = JSON.stringify(data, null, 2);
            }
            setInterval(loadData, 2000);
            loadData();
        </script>
    `);
});

// API to fetch latest data
app.get("/weather", (req, res) => {
    res.json(latestData);
});

// Route for WS WeatherView Plus app
app.post("/data/report/", (req, res) => {
    let data = req.body || {};

    // Also check query parameters just in case
    if (Object.keys(req.query).length > 0) {
        data = req.query;
    }

    if (Object.keys(data).length > 0) {
        latestData = data;
    }

    console.log("Captured Data (WSView Plus):", data);

    res.send("OK");
});

// Catch-all route for other uploads (Ecobit or others)
app.all("*", (req, res) => {
    let data = {};

    // Check query parameters (GET)
    if (Object.keys(req.query).length > 0) {
        data = req.query;
    }

    // Check body (JSON or URL-encoded POST)
    if (req.body && Object.keys(req.body).length > 0) {
        data = req.body;
    }

    if (Object.keys(data).length > 0) {
        latestData = data;
    }

    console.log("Captured Data (Other):", data);

    res.send("OK");
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
