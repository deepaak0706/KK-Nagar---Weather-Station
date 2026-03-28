const express = require("express");
const app = express();

// Store the latest data
let latestData = {};

// Middleware for JSON and URL-encoded bodies (other devices)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

// Robust route for WS WeatherView Plus
app.post("/data/report/", express.text({ type: "*/*" }), (req, res) => {
    let data = {};

    console.log("===== Incoming WSView Plus request =====");
    console.log("Raw body received:", req.body);
    console.log("Headers:", req.headers);

    // Try to parse JSON
    try {
        data = JSON.parse(req.body);
        console.log("Parsed JSON:", data);
    } catch (e) {
        // If not JSON, try URLSearchParams (key=value&key2=value2)
        try {
            const params = new URLSearchParams(req.body);
            data = Object.fromEntries(params.entries());
            console.log("Parsed URLSearchParams:", data);
        } catch (err) {
            console.log("Could not parse body, storing raw string");
            data = { raw: req.body };
        }
    }

    // Store only if keys exist
    if (Object.keys(data).length > 0) {
        latestData = data;
        console.log("Captured Data:", latestData);
    }

    res.send("OK");
});

// Catch-all for other uploads (Ecobit, etc.)
app.all("*", (req, res) => {
    let data = {};

    // Check query params
    if (req.query && Object.keys(req.query).length > 0) {
        data = req.query;
    }

    // Check JSON body
    if (req.body && Object.keys(req.body).length > 0) {
        data = req.body;
    }

    // Store if keys exist
    if (Object.keys(data).length > 0) {
        latestData = data;
        console.log("Captured Data (Other):", latestData);
    }

    res.send("OK");
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
