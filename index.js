const express = require("express");
const app = express();

let latestData = {};

// Middleware
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

// Weather API
app.get("/weather", (req, res) => {
    res.json(latestData);
});

// 🔥 IMPORTANT: Catch ALL WSView Plus requests
app.all("/data/report*", (req, res) => {
    console.log("===== WSView Plus HIT =====");
    console.log("Method:", req.method);
    console.log("URL:", req.url);
    console.log("Query:", req.query);
    console.log("Body:", req.body);

    // Store ANY data we receive
    if (Object.keys(req.query).length > 0) {
        latestData = req.query;
    } else if (req.body && Object.keys(req.body).length > 0) {
        latestData = req.body;
    } else {
        // fallback: store raw URL (for hash cases)
        latestData = { raw: req.url };
    }

    console.log("Stored:", latestData);

    res.send("OK");
});

// Catch everything else
app.all("*", (req, res) => {
    res.send("OK");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
