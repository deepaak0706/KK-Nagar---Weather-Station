const express = require("express");
const app = express();

let latestData = {};

// Middleware to capture raw body (for POST)
app.use(express.text({ type: "*/*" }));

// Homepage UI
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

// API to fetch stored data
app.get("/weather", (req, res) => {
    res.json(latestData);
});

// Catch ALL incoming requests (GET + POST)
app.all("*", (req, res) => {
    let data = {};

    // 1. Check query parameters (GET)
    if (Object.keys(req.query).length > 0) {
        data = req.query;
    }

    // 2. Check raw body (POST)
    if (req.body && typeof req.body === "string" && req.body.length > 0) {
        const params = new URLSearchParams(req.body);
        data = Object.fromEntries(params.entries());
    }

    console.log("Captured Data:", data);

    // Store only if valid data exists
    if (Object.keys(data).length > 0) {
        latestData = data;
    }

    res.send("OK");
});

app.listen(3000, () => console.log("Server running"));
