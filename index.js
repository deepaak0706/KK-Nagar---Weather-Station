const express = require("express");
const app = express();

let latestData = {};

// Receive data from weather station
app.get("/data/report", (req, res) => {
    latestData = req.query;
    console.log("Received:", latestData);
    res.send("OK");
});

// API to view data
app.get("/weather", (req, res) => {
    res.json(latestData);
});

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

app.listen(3000, () => console.log("Server running"));
