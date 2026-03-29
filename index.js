const express = require("express");
const app = express();

let latestData = {};

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

// API
app.get("/weather", (req, res) => {
    res.json(latestData);
});

// 🔥 Wunderground-style endpoint
app.get("/report/data", (req, res) => {
    console.log("===== WU DATA RECEIVED =====");
    console.log(req.query);

    // Store full data
    latestData = req.query;

    res.send("success"); // important
});

// Catch all
app.all("*", (req, res) => {
    res.send("OK");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
