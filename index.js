const express = require("express");
const app = express();

let latestData = {};

// Needed to parse POST data
app.use(express.urlencoded({ extended: true }));

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

// RECEIVE DATA (POST + GET both)
app.all("*", (req, res) => {
    latestData = Object.keys(req.body).length ? req.body : req.query;
    console.log("Received:", latestData);
    res.send("OK");
});

app.listen(3000, () => console.log("Server running"));
