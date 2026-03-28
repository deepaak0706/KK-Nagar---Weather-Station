const express = require("express");
const app = express();

let latestData = {};

app.get("/data/report/", (req, res) => {
    latestData = req.query;
    console.log("Received data:", latestData);
    res.send("OK");
});

app.get("/weather", (req, res) => {
    res.json(latestData);
});

app.get("/", (req, res) => {
    res.send(`
        <h1>My Weather Station</h1>
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
