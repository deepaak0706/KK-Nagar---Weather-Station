const express = require("express");
const app = express();

let latestData = {};

// Capture RAW body
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

// API
app.get("/weather", (req, res) => {
    res.json(latestData);
});

// RECEIVE EVERYTHING
app.all("*", (req, res) => {
    console.log("RAW BODY:", req.body);
    console.log("QUERY:", req.query);

    // Try parsing raw body if exists
    if (req.body && typeof req.body === "string" && req.body.length > 0) {
        latestData = { raw: req.body };
    } else {
        latestData = req.query;
    }

    res.send("OK");
});

app.listen(3000, () => console.log("Server running"));
