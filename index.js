const express = require("express");
const app = express();

// Store latest data
let latestData = {};

// Middleware for JSON / URL-encoded bodies (other devices)
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

// WSView Plus GET request with hash in URL
app.get("/data/report/*", (req, res) => {
    const hash = req.url.split("/data/report/")[1]; // get everything after /data/report/
    if (hash) {
        latestData = { raw: hash };
        console.log("Received WSView Plus hash via GET:", hash);
    } else {
        console.log("No hash found in GET request");
    }
    res.send("OK");
});

// WSView Plus POST handler (if device ever uses POST)
app.post("/data/report/", express.text({ type: "*/*" }), (req, res) => {
    const rawData = req.body;
    if (rawData) {
        latestData = { raw: rawData };
        console.log("Received WSView Plus data via POST:", rawData);
    }
    res.send("OK");
});

// Catch-all for other devices (Ecobit, Wunderground)
app.all("*", (req, res) => {
    let data = {};

    if (req.query && Object.keys(req.query).length > 0) {
        data = req.query;
    }

    if (req.body && Object.keys(req.body).length > 0) {
        data = req.body;
    }

    if (Object.keys(data).length > 0) {
        latestData = data;
        console.log("Captured Data (Other device):", latestData);
    }

    res.send("OK");
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
