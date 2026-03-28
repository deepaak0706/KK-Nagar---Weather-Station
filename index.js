const express = require("express");
const app = express();

// Store the latest data
let latestData = {};

// Middleware to parse JSON and URL-encoded bodies
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

// Route for WS WeatherView Plus app
app.post("/data/report/", (req, res) => {
    console.log("===== Incoming WSView Plus request =====");
    console.log("Path:", req.path);
    console.log("Headers:", req.headers);
    console.log("Body:", req.body);

    // Save data if present
    if (req.body && Object.keys(req.body).length > 0) {
        latestData = req.body;
        console.log("Captured Data:", latestData);
    } else if (req.query && Object.keys(req.query).length > 0) {
        latestData = req.query;
        console.log("Captured Data (from query):", latestData);
    }

    res.send("OK");
});

// Catch-all route for other uploads (Ecobit, etc.)
app.all("*", (req, res) => {
    console.log("===== Incoming request (Other) =====");
    console.log("Path:", req.path);
    console.log("Headers:", req.headers);
    console.log("Body:", req.body);

    // Save data if present
    let data = {};
    if (req.body && Object.keys(req.body).length > 0) data = req.body;
    if (req.query && Object.keys(req.query).length > 0) data = req.query;

    if (Object.keys(data).length > 0) {
        latestData = data;
        console.log("Captured Data:", latestData);
    }

    res.send("OK");
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
